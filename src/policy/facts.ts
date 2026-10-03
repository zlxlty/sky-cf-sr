/**
 * Facts read from a Chat Completions request without any model: its shape,
 * what it requires of a model, an estimate of its context size, and the text
 * keyword signals look at.
 */
export interface Facts {
  messageCount: number;
  userMessageCount: number;
  /** Messages with the `tool` role: results of earlier tool calls. */
  toolResultCount: number;
  /** Whether the request defines tools the model may call. */
  hasTools: boolean;
  /** Whether `tool_choice` forces a tool call, so the model must support tools. */
  requiresToolCall: boolean;
  responseFormat: "text" | "json_object" | "json_schema";
  imageCount: number;
  stream: boolean;
  /**
   * An estimate, not a tokenizer count: upstream vLLM-SR's conservative
   * admission formula, ceil(text bytes / 4) + structured bytes + 8,192 per
   * image + framing tokens + the requested output tokens.
   */
  contextTokenEstimate: number;
  /** The latest user message's text, which keyword signals match against. */
  latestUserText: string;
  /** Whether `latestUserText` was cut to `MAX_PROJECTED_CHARS`. */
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

const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).length;
const jsonBytes = (value: unknown) =>
  value === undefined ? 0 : byteLength(JSON.stringify(value));

/** Reads facts from a parsed request body. Malformed parts count as absent. */
export function extractFacts(body: Record<string, unknown>): Facts {
  const messages = Array.isArray(body.messages)
    ? body.messages.filter(isObject)
    : [];
  const tools = [
    ...(Array.isArray(body.tools) ? body.tools : []),
    ...(Array.isArray(body.functions) ? body.functions : []),
  ];

  let textBytes = 0;
  let structuredBytes = 0;
  let imageCount = 0;
  let toolCallCount = 0;
  for (const message of messages) {
    const content = readContent(message.content);
    textBytes += content.textBytes;
    structuredBytes += content.structuredBytes;
    imageCount += content.imageCount;
    if (typeof message.name === "string") textBytes += byteLength(message.name);
    if (Array.isArray(message.tool_calls)) {
      toolCallCount += message.tool_calls.length;
      structuredBytes += jsonBytes(message.tool_calls);
    }
  }
  structuredBytes +=
    jsonBytes(tools.length > 0 ? tools : undefined) +
    jsonBytes(body.tool_choice) +
    jsonBytes(body.response_format);

  const outputReserve = firstWholeNumber(
    body.max_completion_tokens,
    body.max_tokens,
  );
  const framing =
    MESSAGE_FRAMING_TOKENS * messages.length +
    TOOL_CALL_FRAMING_TOKENS * toolCallCount +
    TOOL_DEFINITION_FRAMING_TOKENS * tools.length;

  const latestUser = messages.findLast((m) => m.role === "user");
  const latestText = latestUser ? readContent(latestUser.content).text : "";

  return {
    messageCount: messages.length,
    userMessageCount: messages.filter((m) => m.role === "user").length,
    toolResultCount: messages.filter((m) => m.role === "tool").length,
    hasTools: tools.length > 0,
    requiresToolCall: forcesToolCall(body.tool_choice),
    responseFormat: readResponseFormat(body.response_format),
    imageCount,
    stream: body.stream === true,
    contextTokenEstimate:
      Math.ceil(textBytes / BYTES_PER_TOKEN) +
      structuredBytes +
      IMAGE_TOKENS * imageCount +
      framing +
      outputReserve,
    latestUserText: latestText.slice(0, MAX_PROJECTED_CHARS),
    latestUserTextTruncated: latestText.length > MAX_PROJECTED_CHARS,
  };
}

interface Content {
  text: string;
  textBytes: number;
  structuredBytes: number;
  imageCount: number;
}

/** Reads message content: a string, or a list of text, image and other parts. */
function readContent(content: unknown): Content {
  if (typeof content === "string") {
    return {
      text: content,
      textBytes: byteLength(content),
      structuredBytes: 0,
      imageCount: 0,
    };
  }
  const result: Content = {
    text: "",
    textBytes: 0,
    structuredBytes: 0,
    imageCount: 0,
  };
  if (!Array.isArray(content)) return result;
  const texts: string[] = [];
  for (const part of content) {
    if (!isObject(part)) continue;
    if (part.type === "text" && typeof part.text === "string") {
      texts.push(part.text);
      result.textBytes += byteLength(part.text);
    } else if (part.type === "image_url" || part.type === "input_image") {
      // Image bytes are not text; each image gets the fixed reserve instead.
      result.imageCount += 1;
    } else {
      result.structuredBytes += jsonBytes(part);
    }
  }
  result.text = texts.join("\n");
  return result;
}

function forcesToolCall(toolChoice: unknown): boolean {
  return (
    toolChoice === "required" ||
    (isObject(toolChoice) &&
      (toolChoice.type === "function" || "function" in toolChoice))
  );
}

function readResponseFormat(format: unknown): Facts["responseFormat"] {
  if (isObject(format)) {
    if (format.type === "json_object") return "json_object";
    if (format.type === "json_schema") return "json_schema";
  }
  return "text";
}

function firstWholeNumber(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
      return value;
    }
  }
  return 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
