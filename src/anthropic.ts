/**
 * Anthropic's Messages format, for the pool models that the AI binding takes
 * and answers in it; see `ANTHROPIC_FORMAT` in `reach.ts`. A caller of this
 * Worker speaks OpenAI's Chat Completions format, so a call to such a model is
 * translated on the way in, and its answer on the way back.
 *
 * What the model takes and refuses on that path was seen in production on
 * 2026-10-04. A rule below that rests on it says so.
 */

import {
  chatCompletionsAnswer,
  type AnswerForm,
  type Fields,
  type Piece,
} from "./answer.ts";

/** Anthropic requires a limit on output tokens; this is for a caller that sets none. */
const DEFAULT_MAX_TOKENS = 16_384;

/**
 * Fields that are left out without a word. The model refuses the two sampling
 * settings outright ("not supported on this model. Remove it from your
 * request"), and callers send them by habit. The others say nothing to this
 * model, or the Worker has used them already.
 */
const LEFT_OUT = [
  "model",
  "stream",
  "stream_options",
  "prompt_cache_key",
  "temperature",
  "top_p",
];

/** A request this path cannot carry. The caller is told which part. */
class Unsupported extends Error {}

/**
 * A caller's Chat Completions body as the inputs of a Messages call, or why
 * it cannot be one. Nothing is dropped silently except the fields of
 * `LEFT_OUT`: a field this does not know is refused by name, so a caller
 * never believes a setting applied that did not.
 *
 * The call is always streamed, whatever the caller asked: only a streamed
 * answer reports what was read from and written to the cache.
 *
 * With a session, the request carries one cache marker at its top level,
 * which caches the conversation so far for the session's next call. In
 * production a call that wrote the cache was billed at 125% of the full
 * price, and the calls after it, which read it, at 6%. A call with no session
 * gets no marker: it would pay for a write that nothing reads. A caller's own
 * markers, at the top level or on a part of a message, are kept and no other
 * is added.
 */
export function toAnthropic(
  body: Fields,
  sessionId: string | null,
): { inputs: Fields } | { refused: string } {
  try {
    const { system, messages } = translateMessages(body.messages);
    const inputs: Fields = {
      max_tokens:
        body.max_completion_tokens ?? body.max_tokens ?? DEFAULT_MAX_TOKENS,
      ...(system !== "" && { system }),
      messages,
    };
    let ownMarker = hasCacheMarker(body.messages);
    for (const [field, value] of Object.entries(body)) {
      // A field set to null is a field not set: many clients send them so.
      if (LEFT_OUT.includes(field) || value === undefined || value === null) {
        continue;
      }
      switch (field) {
        case "messages":
        case "max_tokens":
        case "max_completion_tokens":
        case "tool_choice":
        case "parallel_tool_calls":
          break; // read above, or with the tools
        case "tools":
          Object.assign(inputs, translateTools(body));
          break;
        case "stop":
          inputs.stop_sequences = typeof value === "string" ? [value] : value;
          break;
        case "reasoning_effort":
          // The model takes low, medium, high, xhigh and max, and refuses any other.
          inputs.output_config = { effort: value };
          break;
        case "user":
          inputs.metadata = { user_id: value };
          break;
        case "cache_control":
          inputs.cache_control = value;
          ownMarker = true;
          break;
        case "n":
          if (value !== 1) throw new Unsupported('"n" other than 1');
          break;
        case "response_format":
          if ((value as Fields | null)?.type !== "text") {
            throw new Unsupported('"response_format" other than text');
          }
          break;
        default:
          throw new Unsupported(`the field "${field}"`);
      }
    }
    if (sessionId !== null && !ownMarker) {
      inputs.cache_control = { type: "ephemeral" };
    }
    return { inputs: { ...inputs, stream: true } };
  } catch (error) {
    if (!(error instanceof Unsupported)) throw error;
    return {
      refused: `This model is called in Anthropic's format, which cannot carry ${error.message}.`,
    };
  }
}

/**
 * The messages as Anthropic takes them. System messages become one `system`
 * text, because the binding takes a string there and nothing else. A tool's
 * result becomes a part of a user message, and the results of one turn share
 * one message, as Anthropic requires.
 */
function translateMessages(value: unknown): {
  system: string;
  messages: Fields[];
} {
  if (!Array.isArray(value)) throw new Unsupported("messages that are no list");
  const system: string[] = [];
  const messages: { role: string; content: string | Fields[] }[] = [];
  for (const message of value as Fields[]) {
    switch (message.role) {
      case "system":
      case "developer":
        system.push(textOf(message.content));
        break;
      case "user":
        messages.push({ role: "user", content: userContent(message.content) });
        break;
      case "assistant": {
        // An empty turn is left out: Anthropic refuses an empty message.
        const blocks = assistantBlocks(message);
        if (blocks.length > 0) {
          messages.push({ role: "assistant", content: blocks });
        }
        break;
      }
      case "tool": {
        const result = {
          type: "tool_result",
          tool_use_id: message.tool_call_id,
          content: textOf(message.content),
        };
        const last = messages.at(-1);
        if (
          last?.role === "user" &&
          Array.isArray(last.content) &&
          last.content.every((block) => block.type === "tool_result")
        ) {
          last.content.push(result);
        } else {
          messages.push({ role: "user", content: [result] });
        }
        break;
      }
      default:
        throw new Unsupported(`a message with the role "${message.role}"`);
    }
  }
  return { system: system.join("\n\n"), messages };
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

function userContent(content: unknown): string | Fields[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) throw new Unsupported("a content of that kind");
  return (content as Fields[]).map((part) => {
    if (part.type === "text") {
      const marker = part.cache_control;
      return {
        type: "text",
        text: part.text,
        ...(marker !== undefined && { cache_control: marker }),
      };
    }
    if (part.type === "image_url") {
      return { type: "image", source: imageSource(part.image_url) };
    }
    throw new Unsupported(`a "${part.type}" part in a user message`);
  });
}

/** An image given as a `data:` URL holds the image; any other URL points to it. */
function imageSource(image: unknown): Fields {
  const url = (image as Fields | null)?.url;
  if (typeof url !== "string") throw new Unsupported("an image with no URL");
  const inline = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  return inline
    ? { type: "base64", media_type: inline[1], data: inline[2] }
    : { type: "url", url };
}

/**
 * An assistant turn as blocks: its text, then its tool calls. A tool call's
 * arguments are a JSON text for OpenAI and an object for Anthropic. Arguments
 * that are not a JSON object become an empty one: another model may have
 * written that turn earlier in the session, and the turn must still be sent.
 */
function assistantBlocks(message: Fields): Fields[] {
  const text = textOf(message.content);
  const blocks: Fields[] = text === "" ? [] : [{ type: "text", text }];
  for (const call of (message.tool_calls ?? []) as Fields[]) {
    const { name, arguments: args } = (call.function ?? {}) as Fields;
    blocks.push({
      type: "tool_use",
      id: call.id,
      name,
      input: objectOf(args),
    });
  }
  return blocks;
}

function objectOf(json: unknown): Fields {
  try {
    const value: unknown = JSON.parse(String(json));
    const isObject =
      typeof value === "object" && value !== null && !Array.isArray(value);
    return isObject ? (value as Fields) : {};
  } catch {
    return {};
  }
}

/**
 * The tools, and how the model may choose among them. On this path the model
 * takes only "auto" and "none": it refuses a forced call, which is what
 * "required" and a named function ask for. They are translated all the same,
 * so that the caller gets the model's own refusal.
 */
function translateTools(body: Fields): Fields {
  const tools = (body.tools as Fields[]).map((tool) => {
    if (tool.type !== "function") {
      throw new Unsupported(`a tool of the type "${tool.type}"`);
    }
    const { name, description, parameters } = tool.function as Fields;
    return {
      name,
      ...(description !== undefined && { description }),
      input_schema: parameters ?? { type: "object", properties: {} },
    };
  });
  const choice = toolChoice(body.tool_choice);
  const oneAtATime = body.parallel_tool_calls === false;
  if (oneAtATime && choice?.type !== "none") {
    return {
      tools,
      tool_choice: { type: "auto", ...choice, disable_parallel_tool_use: true },
    };
  }
  return { tools, ...(choice !== null && { tool_choice: choice }) };
}

function toolChoice(choice: unknown): Fields | null {
  if (choice === undefined || choice === null) return null;
  if (choice === "auto" || choice === "none") return { type: choice };
  if (choice === "required") return { type: "any" };
  const name = ((choice as Fields).function as Fields | undefined)?.name;
  if ((choice as Fields).type === "function" && typeof name === "string") {
    return { type: "tool", name };
  }
  throw new Unsupported("that tool_choice");
}

function hasCacheMarker(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  return (messages as Fields[]).some(
    ({ content }) =>
      Array.isArray(content) &&
      (content as Fields[]).some((part) => part.cache_control !== undefined),
  );
}

/**
 * The model's answer as a Chat Completions answer; see `chatCompletionsAnswer`
 * for its form and for what happens to an answer that is no event stream.
 */
export function fromAnthropic(upstream: Response, form: AnswerForm): Response {
  return chatCompletionsAnswer(upstream, form, read);
}

const FINISH_REASONS: Record<string, string> = {
  end_turn: "stop",
  stop_sequence: "stop",
  pause_turn: "stop",
  max_tokens: "length",
  tool_use: "tool_calls",
  refusal: "content_filter",
};

/**
 * Reads the model's events as pieces of an answer. The model's thinking is
 * left out: Chat Completions has no place for it, and the model takes a later
 * request whose history lacks it. Tool calls are numbered in their order, as
 * OpenAI numbers them; Anthropic numbers every block.
 *
 * A stream that ends before the model says it has finished is an error, so
 * that a broken answer is never taken for a whole one.
 */
async function* read(source: AsyncGenerator<Fields>): AsyncGenerator<Piece> {
  const tools = new Map<unknown, number>();
  const withArguments = new Set<number>();
  const tokens = { input: 0, written: 0, read: 0, output: 0, thinking: 0 };
  let finishReason: string | null = null;
  const count = (usage: Fields | undefined) => {
    if (usage === undefined) return;
    const details = usage.output_tokens_details as Fields | undefined;
    tokens.input = Number(usage.input_tokens ?? tokens.input);
    tokens.written = Number(
      usage.cache_creation_input_tokens ?? tokens.written,
    );
    tokens.read = Number(usage.cache_read_input_tokens ?? tokens.read);
    tokens.output = Number(usage.output_tokens ?? tokens.output);
    tokens.thinking = Number(details?.thinking_tokens ?? tokens.thinking);
  };

  for await (const event of source) {
    switch (event.type) {
      case "message_start": {
        const message = event.message as Fields;
        count(message.usage as Fields | undefined);
        yield { kind: "start", id: message.id, model: message.model };
        break;
      }
      case "content_block_start": {
        const block = event.content_block as Fields;
        if (block.type === "tool_use") {
          tools.set(event.index, tools.size);
          yield {
            kind: "tool",
            index: tools.size - 1,
            id: block.id,
            name: block.name,
          };
        }
        break;
      }
      case "content_block_delta": {
        const delta = event.delta as Fields;
        if (delta.type === "text_delta" && delta.text !== "") {
          yield { kind: "text", text: String(delta.text) };
        }
        if (delta.type === "input_json_delta" && delta.partial_json !== "") {
          const index = tools.get(event.index)!;
          withArguments.add(index);
          yield { kind: "arguments", index, json: String(delta.partial_json) };
        }
        break;
      }
      case "content_block_stop": {
        // A tool that takes nothing gets no arguments from the model at all;
        // a caller expects the arguments to be a JSON object all the same.
        const index = tools.get(event.index);
        if (index !== undefined && !withArguments.has(index)) {
          yield { kind: "arguments", index, json: "{}" };
        }
        break;
      }
      case "message_delta": {
        count(event.usage as Fields | undefined);
        const reason = String((event.delta as Fields).stop_reason);
        finishReason = FINISH_REASONS[reason] ?? "stop";
        break;
      }
      case "message_stop": {
        // Anthropic counts cached tokens apart from the rest; OpenAI counts them in.
        const prompt = tokens.input + tokens.written + tokens.read;
        yield {
          kind: "end",
          finishReason: finishReason ?? "stop",
          usage: {
            prompt_tokens: prompt,
            completion_tokens: tokens.output,
            total_tokens: prompt + tokens.output,
            prompt_tokens_details: {
              cached_tokens: tokens.read,
              cache_write_tokens: tokens.written,
            },
            completion_tokens_details: { reasoning_tokens: tokens.thinking },
          },
        };
        return;
      }
      case "error":
        yield { kind: "error", error: event.error as Fields };
        return;
    }
  }
  throw new Error("The model's stream ended before the model had finished.");
}
