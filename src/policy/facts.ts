import { isHighSurrogate, jsonBytes, utf8Bytes } from "./encoding.ts";

/**
 * Facts read from a Chat Completions request without any model: its shape,
 * what it requires of a model, an estimate of its context size, and the text
 * keyword signals look at.
 */
export interface Facts {
  /** Entries in `messages`, malformed ones included. */
  messageCount: number;
  userMessageCount: number;
  /** Messages with the `tool` role, or the legacy `function` role: results of earlier tool calls. */
  toolResultCount: number;
  /** Whether the request defines tools the model may call, in `tools` or the legacy `functions`. */
  hasTools: boolean;
  /** Whether the request forces a tool call instead of leaving it to the model. */
  requiresToolCall: boolean;
  responseFormat: "text" | "json_object" | "json_schema";
  /** Images anywhere in the messages, tool results included. */
  imageCount: number;
  stream: boolean;
  /**
   * An estimate, not a tokenizer count: upstream vLLM-SR's conservative
   * admission formula, ceil(text bytes / 4) + structured bytes + 8,192 per
   * image + framing tokens + the requested output tokens. `Estimate` says
   * what counts as text and what as structured.
   */
  contextTokenEstimate: number;
  /** The latest user message's text, which keyword signals match against. */
  latestUserText: string;
  /** Whether `latestUserText` is only the first `MAX_PROJECTED_CHARS` of a longer text. */
  latestUserTextTruncated: boolean;
}

/** Keyword matching stops at this many characters of the latest user message. */
export const MAX_PROJECTED_CHARS = 32_000;

// The constants of upstream's RequestContextEstimate.
const BYTES_PER_TOKEN = 4;
const IMAGE_TOKENS = 8 * 1024;
const MESSAGE_FRAMING_TOKENS = 4;
const TOOL_CALL_FRAMING_TOKENS = 8;
const TOOL_DEFINITION_FRAMING_TOKENS = 8;

const IMAGE_TYPES = new Set(["image", "image_url", "input_image"]);
const TEXT_TYPES = new Set(["text", "input_text", "output_text"]);

/** Reads facts from a parsed request body. Malformed parts never throw. */
export function extractFacts(body: Record<string, unknown>): Facts {
  const estimate = estimateContext(body);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const roles = messages.map((m) => (isObject(m) ? normalized(m.role) : ""));
  const latestUser: unknown = messages[roles.lastIndexOf("user")];
  const projected = projectText(
    isObject(latestUser) ? latestUser.content : undefined,
  );
  return {
    messageCount: messages.length,
    userMessageCount: roles.filter((role) => role === "user").length,
    toolResultCount: roles.filter((role) => isToolResultRole(role)).length,
    hasTools: estimate.toolDefinitionCount > 0,
    requiresToolCall: forcesToolCall(body.tool_choice, body.function_call),
    responseFormat: readResponseFormat(body.response_format),
    imageCount: estimate.imageCount,
    stream: body.stream === true,
    contextTokenEstimate: estimate.tokens,
    latestUserText: projected.text,
    latestUserTextTruncated: projected.truncated,
  };
}

/** The parts of the context estimate, as upstream reports them. */
export interface ContextEstimate {
  textBytes: number;
  structuredBytes: number;
  imageCount: number;
  framingTokens: number;
  outputReserve: number;
  toolDefinitionCount: number;
  /** ceil(textBytes / 4) + structuredBytes + 8,192 per image + framingTokens + outputReserve. */
  tokens: number;
}

export function estimateContext(
  body: Record<string, unknown>,
): ContextEstimate {
  const estimate = new Estimate();
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) estimate.addMessage(message);
  } else {
    estimate.addStructured(body.messages);
  }
  estimate.addToolDefinitions(body.tools);
  estimate.addToolDefinitions(body.functions);
  estimate.addStructured(body.tool_choice);
  estimate.addStructured(body.function_call);
  estimate.addStructured(body.response_format);
  estimate.addOutputReserve(body.max_completion_tokens, body.max_tokens);
  return estimate.result();
}

/**
 * Upstream's request context estimate for the OpenAI Chat Completions shape,
 * ported method by method from vLLM Semantic Router's
 * request_context_estimate.go (Apache-2.0,
 * https://github.com/vllm-project/semantic-router, commit 590a51c).
 *
 * Prose counts as text bytes, at four bytes per token: message text, roles,
 * names, IDs, refusals and reasoning. Everything else counts one token per
 * byte, because JSON tokenizes far more densely than prose: tool results,
 * tool-call arguments, tool definitions, unknown content parts and malformed
 * values. Each image gets a fixed reserve instead of its bytes.
 *
 * Two differences, because the Worker sees the parsed body, not its raw text:
 * - Structured values are measured as compact JSON, as `JSON.stringify`
 *   writes them. Upstream measures the raw text, so whitespace between JSON
 *   tokens, and characters written as escapes when they need not be, count
 *   there but not here.
 * - Numbers count as JavaScript writes them. An integer beyond 2^53 is
 *   rounded, and an output limit written `1.0` or `1e3` is a whole number
 *   here but structured bytes upstream.
 */
class Estimate {
  textBytes = 0;
  structuredBytes = 0;
  imageCount = 0;
  framingTokens = 0;
  outputReserve = 0;
  toolDefinitionCount = 0;

  addMessage(message: unknown): void {
    this.framingTokens += MESSAGE_FRAMING_TOKENS;
    if (!isObject(message)) {
      this.addStructured(message);
      return;
    }
    this.addText(message.role);
    this.addText(message.name);
    this.addText(message.tool_call_id);
    if (isToolResultRole(normalized(message.role))) {
      this.addToolResult(message.content);
    } else {
      this.addContent(message.content);
    }
    this.addText(message.refusal);
    this.addText(message.reasoning_content);
    this.addToolCalls(message.tool_calls);
    this.addFunctionCall(message.function_call);
  }

  /** A tool result is structured, apart from images. */
  addToolResult(content: unknown): void {
    this.framingTokens += TOOL_CALL_FRAMING_TOKENS;
    const parts = Array.isArray(content) ? content : [content];
    for (const part of parts) {
      if (IMAGE_TYPES.has(typeOf(part))) this.imageCount++;
      else this.addStructured(part);
    }
  }

  addContent(content: unknown): void {
    if (typeof content === "string") {
      this.textBytes += utf8Bytes(content);
    } else if (Array.isArray(content)) {
      for (const part of content) this.addContentPart(part);
    } else if (isObject(content)) {
      this.addContentPart(content);
    } else {
      this.addStructured(content);
    }
  }

  addContentPart(part: unknown): void {
    const type = typeOf(part);
    if (IMAGE_TYPES.has(type)) {
      this.imageCount++;
    } else if (TEXT_TYPES.has(type) && isObject(part) && "text" in part) {
      this.addText(part.text);
    } else {
      // Unknown structured content still takes up context.
      this.addStructured(part);
    }
  }

  addToolCalls(calls: unknown): void {
    if (calls === undefined || calls === null) return;
    if (!Array.isArray(calls)) {
      this.addStructured(calls);
      return;
    }
    for (const call of calls) {
      this.framingTokens += TOOL_CALL_FRAMING_TOKENS;
      if (!isObject(call) || !isObject(call.function)) {
        // A malformed call counts once, whole.
        this.addStructured(call);
        continue;
      }
      this.addText(call.id);
      this.addText(call.type);
      this.addText(call.tool_call_id);
      this.addText(call.function.name);
      this.addStructured(call.function.arguments);
    }
  }

  /** The legacy single `function_call` of an assistant message. */
  addFunctionCall(call: unknown): void {
    if (call === undefined || call === null) return;
    if (!isObject(call)) {
      this.addStructured(call);
      return;
    }
    this.framingTokens += TOOL_CALL_FRAMING_TOKENS;
    this.addText(call.name);
    this.addStructured(call.arguments);
  }

  addToolDefinitions(definitions: unknown): void {
    if (definitions === undefined || definitions === null) return;
    if (!Array.isArray(definitions)) {
      this.addStructured(definitions);
      return;
    }
    for (const definition of definitions) {
      this.toolDefinitionCount++;
      this.framingTokens += TOOL_DEFINITION_FRAMING_TOKENS;
      this.addStructured(definition);
    }
  }

  /** The first output limit given wins, even 0; a malformed one counts as structured bytes. */
  addOutputReserve(...limits: unknown[]): void {
    for (const limit of limits) {
      if (limit === undefined || limit === null) continue;
      if (typeof limit === "number" && Number.isInteger(limit) && limit >= 0) {
        this.outputReserve = Math.min(limit, Number.MAX_SAFE_INTEGER);
      } else {
        this.addStructured(limit);
      }
      return;
    }
  }

  /** Text if it is a string; otherwise structured. */
  addText(value: unknown): void {
    if (typeof value === "string") this.textBytes += utf8Bytes(value);
    else this.addStructured(value);
  }

  addStructured(value: unknown): void {
    if (value === undefined || value === null) return;
    this.structuredBytes += jsonBytes(value);
  }

  result(): ContextEstimate {
    const { textBytes, structuredBytes, imageCount, framingTokens } = this;
    const { outputReserve, toolDefinitionCount } = this;
    const tokens =
      Math.ceil(textBytes / BYTES_PER_TOKEN) +
      structuredBytes +
      IMAGE_TOKENS * imageCount +
      framingTokens +
      outputReserve;
    return {
      textBytes,
      structuredBytes,
      imageCount,
      framingTokens,
      outputReserve,
      toolDefinitionCount,
      tokens: Math.min(tokens, Number.MAX_SAFE_INTEGER),
    };
  }
}

/**
 * The text keyword signals see: a string, or the text parts joined by new
 * lines, cut to `MAX_PROJECTED_CHARS` without splitting a character.
 */
function projectText(content: unknown): { text: string; truncated: boolean } {
  const pieces =
    typeof content === "string"
      ? [content]
      : (Array.isArray(content) ? content : [content]).flatMap((part) =>
          TEXT_TYPES.has(typeOf(part)) &&
          isObject(part) &&
          typeof part.text === "string"
            ? [part.text]
            : [],
        );
  let text = "";
  for (const [i, piece] of pieces.entries()) {
    text += i === 0 ? piece : `\n${piece}`;
    if (text.length > MAX_PROJECTED_CHARS) {
      const end = isHighSurrogate(text.charCodeAt(MAX_PROJECTED_CHARS - 1))
        ? MAX_PROJECTED_CHARS - 1
        : MAX_PROJECTED_CHARS;
      return { text: text.slice(0, end), truncated: true };
    }
  }
  return { text, truncated: false };
}

/**
 * A named tool, an allowed-tools list in required mode, `required`, or the
 * legacy `function_call` naming a function.
 */
function forcesToolCall(toolChoice: unknown, functionCall: unknown): boolean {
  if (toolChoice === undefined || toolChoice === null) {
    return isObject(functionCall);
  }
  if (!isObject(toolChoice)) return toolChoice === "required";
  if (toolChoice.type === "allowed_tools") {
    return (
      isObject(toolChoice.allowed_tools) &&
      toolChoice.allowed_tools.mode === "required"
    );
  }
  return (
    toolChoice.type === "function" ||
    toolChoice.type === "custom" ||
    "function" in toolChoice
  );
}

function readResponseFormat(format: unknown): Facts["responseFormat"] {
  if (isObject(format)) {
    if (format.type === "json_object") return "json_object";
    if (format.type === "json_schema") return "json_schema";
  }
  return "text";
}

/** Roles and part types compare as upstream does: trimmed, in any case. */
function normalized(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isToolResultRole(role: string): boolean {
  return role === "tool" || role === "function";
}

function typeOf(part: unknown): string {
  return isObject(part) ? normalized(part.type) : "";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
