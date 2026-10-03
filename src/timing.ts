/** How a relayed response body ended, and when, on the clock passed to `timed`. */
export interface BodyTiming {
  /** When generated output first arrived. Null for a response that was not streamed, or produced none. */
  msToFirstToken: number | null;
  msTotal: number;
  /**
   * "cancelled": the caller stopped reading. "timeout": the deadline passed.
   * "error": the upstream stream broke.
   */
  ended: "complete" | "cancelled" | "timeout" | "error";
}

export interface TimedOptions {
  /** Whether the body is a server-sent event stream that may hold tokens. */
  eventStream: boolean;
  /** Milliseconds since the request was sent. */
  elapsed: () => number;
  /** Aborts when the request's deadline passes; the body is then cut off. */
  deadline: AbortSignal;
  onEnd: (timing: BodyTiming) => void;
}

/**
 * Passes a response body through unchanged, one chunk at a time, and reports
 * its timing once when it ends.
 */
export function timed(
  body: ReadableStream<Uint8Array>,
  { eventStream, elapsed, deadline, onEnd }: TimedOptions,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const hasOutput = eventStream ? outputDetector() : null;
  let msToFirstToken: number | null = null;
  let reported = false;
  let output: ReadableStreamDefaultController<Uint8Array> | undefined;

  const end = (ended: BodyTiming["ended"]) => {
    reported = true;
    deadline.removeEventListener("abort", expire);
    onEnd({ msToFirstToken, msTotal: elapsed(), ended });
  };
  function expire() {
    if (reported) return;
    end("timeout");
    output?.error(deadline.reason);
    reader.cancel(deadline.reason).catch(() => {});
  }

  return new ReadableStream({
    start(controller) {
      output = controller;
      if (deadline.aborted) expire();
      else deadline.addEventListener("abort", expire);
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        // The deadline may have ended the body while this read was waiting.
        if (reported) return;
        if (done) {
          end("complete");
          controller.close();
          return;
        }
        // Chunks are parsed only until the first token is found.
        if (msToFirstToken === null && hasOutput?.(value)) {
          msToFirstToken = elapsed();
        }
        controller.enqueue(value);
      } catch (error) {
        if (reported) return;
        end(deadline.aborted ? "timeout" : "error");
        controller.error(error);
      }
    },
    cancel(reason) {
      if (!reported) end("cancelled");
      return reader.cancel(reason);
    },
  });
}

/**
 * Returns a function that is fed the chunks of a Chat Completions event stream
 * and answers whether a chunk contains generated output. Events may be split
 * across chunks, so the unfinished last line is carried over.
 */
function outputDetector(): (chunk: Uint8Array) => boolean {
  const decoder = new TextDecoder();
  let unfinished = "";
  return (chunk) => {
    const lines = (unfinished + decoder.decode(chunk, { stream: true })).split(
      "\n",
    );
    unfinished = lines.pop() ?? "";
    return lines.some(carriesOutput);
  };
}

/**
 * Whether an event-stream line is a completion chunk whose delta holds
 * generated output: text, reasoning or a tool call. The opening chunk that
 * only names the role does not count.
 */
function carriesOutput(line: string): boolean {
  if (!line.startsWith("data:")) return false;
  let event: unknown;
  try {
    event = JSON.parse(line.slice("data:".length));
  } catch {
    return false; // "[DONE]"
  }
  const choices = (event as { choices?: unknown } | null)?.choices;
  if (!Array.isArray(choices)) return false;
  return choices.some((choice: { delta?: unknown } | null) => {
    const delta = choice?.delta;
    if (typeof delta !== "object" || delta === null) return false;
    return Object.entries(delta).some(
      ([field, value]) =>
        field !== "role" &&
        (typeof value === "string" || Array.isArray(value)) &&
        value.length > 0,
    );
  });
}
