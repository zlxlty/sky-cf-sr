/**
 * A model's answer in another format, as a Chat Completions answer. Each
 * format that the Worker translates has its own module, which reads the
 * model's events as the pieces below; see `anthropic.ts` and `responses.ts`.
 * What is made of the pieces is the same for all of them, and is here.
 */

export type Fields = Record<string, unknown>;

/** What the caller asked for, which decides the form of the answer. */
export interface AnswerForm {
  /** Whether the caller asked for a stream; the model is always asked for one. */
  stream: boolean;
  /** Whether a stream ends with a chunk that holds the usage. */
  includeUsage: boolean;
  /** The time of the answer, in seconds since 1970. */
  created: number;
}

/** What an answer is made of, in the order the model sends it. */
export type Piece =
  | { kind: "start"; id: unknown; model: unknown }
  | { kind: "text"; text: string }
  | { kind: "tool"; index: number; id: unknown; name: unknown }
  | { kind: "arguments"; index: number; json: string }
  | { kind: "end"; finishReason: string; usage: Fields }
  | { kind: "error"; error: Fields };

/**
 * The model's answer as a Chat Completions answer: a stream of chunks for a
 * caller that asked for a stream, one JSON object for a caller that did not.
 * `read` turns the events of the model's format into pieces. An answer that
 * is no event stream, which is an error from the binding or the Gateway, is
 * returned as it is.
 *
 * A caller that did not ask for a stream still gets its status and headers
 * when the model starts to answer, and its body when the model has finished.
 * So an error that the model sends after it has started reaches that caller
 * in a body with the status 200.
 */
export function chatCompletionsAnswer(
  upstream: Response,
  form: AnswerForm,
  read: (source: AsyncGenerator<Fields>) => AsyncGenerator<Piece>,
): Response {
  const isStream =
    upstream.headers.get("content-type")?.startsWith("text/event-stream") ??
    false;
  if (upstream.body === null || !upstream.ok || !isStream) return upstream;

  const encoder = new TextEncoder();
  const source = read(events(upstream.body));
  const pieces = form.stream ? chunks(source, form) : whole(source, form);
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await pieces.next();
        if (done) controller.close();
        else controller.enqueue(encoder.encode(value));
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await pieces.return(undefined);
    },
  });
  const headers = new Headers(upstream.headers);
  headers.set(
    "content-type",
    form.stream ? "text/event-stream" : "application/json",
  );
  return new Response(body, { status: upstream.status, headers });
}

/** The data of each event of an event stream. The upstream is cancelled if the reader stops early. */
async function* events(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Fields> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let unfinished = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      const lines = (unfinished + value).split("\n");
      unfinished = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data:")) {
          yield JSON.parse(line.slice("data:".length)) as Fields;
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function errorBody(error: Fields): Fields {
  return {
    error: {
      message: error.message,
      type: error.type ?? "api_error",
      param: null,
      code: null,
    },
  };
}

/** The answer as Chat Completions chunks, for a caller that asked for a stream. */
async function* chunks(
  source: AsyncGenerator<Piece>,
  form: AnswerForm,
): AsyncGenerator<string> {
  let head: Fields = {};
  const event = (fields: Fields) => `data: ${JSON.stringify(fields)}\n\n`;
  const chunk = (delta: Fields, finishReason: string | null = null) =>
    event({
      ...head,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    });
  for await (const piece of source) {
    switch (piece.kind) {
      case "start":
        head = {
          id: piece.id,
          object: "chat.completion.chunk",
          created: form.created,
          model: piece.model,
        };
        yield chunk({ role: "assistant", content: "" });
        break;
      case "text":
        yield chunk({ content: piece.text });
        break;
      case "tool":
        yield chunk({
          tool_calls: [
            {
              index: piece.index,
              id: piece.id,
              type: "function",
              function: { name: piece.name, arguments: "" },
            },
          ],
        });
        break;
      case "arguments":
        yield chunk({
          tool_calls: [
            { index: piece.index, function: { arguments: piece.json } },
          ],
        });
        break;
      case "end":
        yield chunk({}, piece.finishReason);
        if (form.includeUsage) {
          yield event({ ...head, choices: [], usage: piece.usage });
        }
        break;
      case "error":
        yield event(errorBody(piece.error));
        break;
    }
  }
  yield "data: [DONE]\n\n";
}

/** The answer as one Chat Completions object, for a caller that asked for no stream. */
async function* whole(
  source: AsyncGenerator<Piece>,
  form: AnswerForm,
): AsyncGenerator<string> {
  let head: Fields = {};
  let text = "";
  const calls: { id: unknown; name: unknown; json: string }[] = [];
  for await (const piece of source) {
    switch (piece.kind) {
      case "start":
        head = {
          id: piece.id,
          object: "chat.completion",
          created: form.created,
          model: piece.model,
        };
        break;
      case "text":
        text += piece.text;
        break;
      case "tool":
        calls.push({ id: piece.id, name: piece.name, json: "" });
        break;
      case "arguments":
        calls[piece.index]!.json += piece.json;
        break;
      case "end": {
        const toolCalls = calls.map(({ id, name, json }) => ({
          id,
          type: "function",
          function: { name, arguments: json },
        }));
        yield JSON.stringify({
          ...head,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: text === "" && toolCalls.length > 0 ? null : text,
                ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
              },
              finish_reason: piece.finishReason,
            },
          ],
          usage: piece.usage,
        });
        break;
      }
      case "error":
        yield JSON.stringify(errorBody(piece.error));
        break;
    }
  }
}
