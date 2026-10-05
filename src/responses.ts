/**
 * OpenAI's Responses format, for the calls that the AI binding takes and
 * answers in it; see `RESPONSES_FORMAT_WITH_TOOLS` in `reach.ts`. A caller of this
 * Worker speaks OpenAI's Chat Completions format, so such a call is
 * translated on the way in, and its answer on the way back.
 *
 * What the models take on that path was seen in production on 2026-10-05. A
 * rule below that rests on it says so.
 */

import {
  chatCompletionsAnswer,
  type AnswerForm,
  type Fields,
  type Piece,
} from "./answer.ts";

/**
 * Fields that are left out without a word. The Worker has used the first
 * three already. A cache marker says nothing to this model, whose cache needs
 * none; a caller that also calls Anthropic's models sends it by habit.
 */
const LEFT_OUT = ["model", "stream", "stream_options", "cache_control"];

/** Fields that the Responses format takes under the same name. */
const SAME_NAME = [
  "temperature",
  "top_p",
  "user",
  "prompt_cache_key",
  "parallel_tool_calls",
];

/** A request this path cannot carry. The caller is told which part. */
class Unsupported extends Error {}

/**
 * A caller's Chat Completions body as the inputs of a Responses call, or why
 * it cannot be one. Nothing is dropped silently except the fields of
 * `LEFT_OUT`: a field this does not know is refused by name, so a caller
 * never believes a setting applied that did not.
 *
 * The call is always streamed, whatever the caller asked, so that a long
 * answer with much reasoning does not wait in silence. It is never stored at
 * the provider: the format stores an answer unless it is told not to, and
 * the Worker keeps a caller's text nowhere.
 */
export function toResponses(
  body: Fields,
): { inputs: Fields } | { refused: string } {
  try {
    const inputs: Fields = { input: translateMessages(body.messages) };
    const limit = body.max_completion_tokens ?? body.max_tokens;
    if (limit !== undefined && limit !== null) inputs.max_output_tokens = limit;
    for (const [field, value] of Object.entries(body)) {
      // A field set to null is a field not set: many clients send them so.
      if (LEFT_OUT.includes(field) || value === undefined || value === null) {
        continue;
      }
      if (SAME_NAME.includes(field)) {
        inputs[field] = value;
        continue;
      }
      switch (field) {
        case "messages":
        case "max_tokens":
        case "max_completion_tokens":
          break; // read above
        case "tools":
          inputs.tools = translateTools(value);
          break;
        case "tool_choice":
          inputs.tool_choice = toolChoice(value);
          break;
        case "reasoning_effort":
          inputs.reasoning = { effort: value };
          break;
        case "n":
          if (value !== 1) throw new Unsupported('"n" other than 1');
          break;
        case "response_format":
          if ((value as Fields).type !== "text") {
            throw new Unsupported('"response_format" other than text');
          }
          break;
        default:
          throw new Unsupported(`the field "${field}"`);
      }
    }
    return { inputs: { ...inputs, store: false, stream: true } };
  } catch (error) {
    if (!(error instanceof Unsupported)) throw error;
    return {
      refused: `This call goes to the model in OpenAI's Responses format, which cannot carry ${error.message}.`,
    };
  }
}

/**
 * The messages as items of a Responses call. A message keeps its place and
 * its role. An assistant turn becomes its text, then one item for each tool
 * call; a tool's result becomes an item that names its call.
 */
function translateMessages(value: unknown): Fields[] {
  if (!Array.isArray(value)) throw new Unsupported("messages that are no list");
  const items: Fields[] = [];
  for (const message of value as (Fields | null)[]) {
    if (typeof message !== "object" || message === null) {
      throw new Unsupported("a message that is no object");
    }
    switch (message.role) {
      case "system":
      case "developer":
        items.push({ role: message.role, content: textOf(message.content) });
        break;
      case "user":
        items.push({ role: "user", content: userContent(message.content) });
        break;
      case "assistant": {
        // An empty text is left out: the turn may be tool calls only. A turn
        // that is a refusal has its words there, and no content.
        const text = textOf(message.content) || refusalOf(message);
        if (text !== "") items.push({ role: "assistant", content: text });
        for (const call of (message.tool_calls ?? []) as Fields[]) {
          if (call.type !== undefined && call.type !== "function") {
            throw new Unsupported(`a tool call of the type "${call.type}"`);
          }
          const { name, arguments: args } = (call.function ?? {}) as Fields;
          items.push({
            type: "function_call",
            call_id: call.id,
            name,
            arguments: typeof args === "string" ? args : JSON.stringify(args),
          });
        }
        break;
      }
      case "tool":
        items.push({
          type: "function_call_output",
          call_id: message.tool_call_id,
          output: textOf(message.content),
        });
        break;
      default:
        throw new Unsupported(`a message with the role "${message.role}"`);
    }
  }
  return items;
}

function refusalOf(message: Fields): string {
  return typeof message.refusal === "string" ? message.refusal : "";
}

/** The text of a content that is a string, or a list of text parts. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  if (!Array.isArray(content)) throw new Unsupported("a content of that kind");
  return (content as Fields[])
    .map((part) => {
      if (part.type !== "text") {
        throw new Unsupported(`a "${part.type}" part in that message`);
      }
      return part.text;
    })
    .join("");
}

/** A user message's parts. A cache marker on a part is left out, as at the top level. */
function userContent(content: unknown): string | Fields[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) throw new Unsupported("a content of that kind");
  return (content as Fields[]).map((part) => {
    if (part.type === "text") return { type: "input_text", text: part.text };
    if (part.type === "image_url") {
      const { url, detail } = (part.image_url ?? {}) as Fields;
      if (typeof url !== "string")
        throw new Unsupported("an image with no URL");
      return {
        type: "input_image",
        image_url: url,
        ...(detail !== undefined && { detail }),
      };
    }
    throw new Unsupported(`a "${part.type}" part in a user message`);
  });
}

/**
 * The tools, each with its fields one level up. Chat Completions checks a
 * tool's arguments strictly only when the caller asks for it, and the
 * Responses format does so unless told not to; so each tool says which.
 */
function translateTools(value: unknown): Fields[] {
  if (!Array.isArray(value)) throw new Unsupported("tools that are no list");
  return (value as (Fields | null)[]).map((tool) => {
    if (tool?.type !== "function") {
      throw new Unsupported(`a tool of the type "${tool?.type}"`);
    }
    if (typeof tool.function !== "object" || tool.function === null) {
      throw new Unsupported("a function tool with no function");
    }
    const { name, description, parameters, strict } = tool.function as Fields;
    return {
      type: "function",
      name,
      ...(description !== undefined && { description }),
      parameters: parameters ?? { type: "object", properties: {} },
      strict: strict === true,
    };
  });
}

function toolChoice(choice: unknown): unknown {
  if (choice === "auto" || choice === "none" || choice === "required") {
    return choice;
  }
  const name = ((choice as Fields).function as Fields | undefined)?.name;
  if ((choice as Fields).type === "function" && typeof name === "string") {
    return { type: "function", name };
  }
  throw new Unsupported("that tool_choice");
}

/**
 * The model's answer as a Chat Completions answer; see `chatCompletionsAnswer`
 * for its form and for what happens to an answer that is no event stream.
 */
export function fromResponses(upstream: Response, form: AnswerForm): Response {
  return chatCompletionsAnswer(upstream, form, read);
}

/**
 * Why an answer that is not complete stopped, as Chat Completions names it.
 * Any other reason is given as "length": the answer is cut off, and "stop"
 * would say that it is whole.
 */
const INCOMPLETE_REASONS: Record<string, string> = {
  max_output_tokens: "length",
  content_filter: "content_filter",
};

/**
 * Reads the model's events as pieces of an answer. The model's reasoning is
 * left out: Chat Completions has no place for it. A refusal is passed on as
 * text, so that the caller reads the model's own words. Tool calls are
 * numbered in their order, as Chat Completions numbers them; the Responses
 * format numbers every item of the answer.
 *
 * A stream that ends before the model says it has finished is an error, so
 * that a broken answer is never taken for a whole one.
 */
async function* read(source: AsyncGenerator<Fields>): AsyncGenerator<Piece> {
  const tools = new Map<unknown, number>();
  const withArguments = new Set<number>();

  for await (const event of source) {
    switch (event.type) {
      case "response.created": {
        const response = event.response as Fields;
        yield { kind: "start", id: response.id, model: response.model };
        break;
      }
      case "response.output_item.added": {
        const item = event.item as Fields;
        if (item.type === "function_call") {
          tools.set(event.output_index, tools.size);
          yield {
            kind: "tool",
            index: tools.size - 1,
            id: item.call_id,
            name: item.name,
          };
        }
        break;
      }
      case "response.output_text.delta":
      case "response.refusal.delta":
        if (event.delta !== "") {
          yield { kind: "text", text: String(event.delta) };
        }
        break;
      case "response.function_call_arguments.delta":
        if (event.delta !== "") {
          const index = tools.get(event.output_index)!;
          withArguments.add(index);
          yield { kind: "arguments", index, json: String(event.delta) };
        }
        break;
      case "response.output_item.done": {
        // Arguments that did not come in parts are in the finished item. A
        // caller expects them to be a JSON object also for a tool that takes
        // nothing.
        const index = tools.get(event.output_index);
        if (index !== undefined && !withArguments.has(index)) {
          const whole = (event.item as Fields).arguments;
          yield {
            kind: "arguments",
            index,
            json: typeof whole === "string" && whole !== "" ? whole : "{}",
          };
        }
        break;
      }
      case "response.completed":
        yield {
          kind: "end",
          finishReason: tools.size > 0 ? "tool_calls" : "stop",
          usage: usageOf(event.response as Fields),
        };
        return;
      case "response.incomplete": {
        const response = event.response as Fields;
        const reason = (response.incomplete_details as Fields | null)?.reason;
        yield {
          kind: "end",
          finishReason: INCOMPLETE_REASONS[String(reason)] ?? "length",
          usage: usageOf(response),
        };
        return;
      }
      case "response.failed":
        yield errorOf(((event.response as Fields).error ?? {}) as Fields);
        return;
      case "error":
        yield errorOf(event);
        return;
    }
  }
  throw new Error("The model's stream ended before the model had finished.");
}

/** An error of this format has a code where Chat Completions has a type. */
function errorOf(error: Fields): Piece {
  return {
    kind: "error",
    error: { message: error.message, type: error.code ?? "api_error" },
  };
}

/** The usage of a finished answer, under the names of Chat Completions. */
function usageOf(response: Fields): Fields {
  const usage = (response.usage ?? {}) as Fields;
  const input = (usage.input_tokens_details ?? {}) as Fields;
  const output = (usage.output_tokens_details ?? {}) as Fields;
  const prompt = Number(usage.input_tokens ?? 0);
  const completion = Number(usage.output_tokens ?? 0);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: {
      cached_tokens: Number(input.cached_tokens ?? 0),
      cache_write_tokens: Number(input.cache_write_tokens ?? 0),
    },
    completion_tokens_details: {
      reasoning_tokens: Number(output.reasoning_tokens ?? 0),
    },
  };
}
