import { describe, expect, it } from "vitest";
import { fromResponses, toResponses } from "../src/responses.ts";

type Fields = Record<string, unknown>;

const HI = [{ role: "user", content: "hi" }];

/** The inputs for a body, which must be one this path can carry. */
function inputs(body: Fields): Fields {
  const translated = toResponses(body);
  if ("refused" in translated) throw new Error(translated.refused);
  return translated.inputs;
}

function refusal(body: Fields): string {
  const translated = toResponses(body);
  return "refused" in translated ? translated.refused : "not refused";
}

describe("a request translated to OpenAI's Responses format", () => {
  it("carries the messages as items, is never stored, and always asks for a stream", () => {
    expect(inputs({ model: "direct/x", messages: HI })).toEqual({
      input: HI,
      store: false,
      stream: true,
    });
  });

  it.each([
    [{ max_tokens: 20 }, 20],
    [{ max_completion_tokens: 30 }, 30],
    [{ max_tokens: 20, max_completion_tokens: 30 }, 30],
  ])("takes the caller's limit on output: %j", (limit, expected) => {
    expect(inputs({ messages: HI, ...limit }).max_output_tokens).toBe(expected);
  });

  it("sets no limit on output when the caller sets none", () => {
    expect(inputs({ messages: HI })).not.toHaveProperty("max_output_tokens");
  });

  it("keeps system and developer messages in their place, as text", () => {
    const translated = inputs({
      messages: [
        { role: "system", content: "Be terse." },
        ...HI,
        { role: "developer", content: [{ type: "text", text: "No lists." }] },
      ],
    });

    expect(translated.input).toEqual([
      { role: "system", content: "Be terse." },
      ...HI,
      { role: "developer", content: "No lists." },
    ]);
  });

  it("turns a user message's parts into text and image parts", () => {
    const translated = inputs({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Compare these." },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,AAAA" },
            },
            {
              type: "image_url",
              image_url: { url: "https://x.example/a.png", detail: "low" },
            },
          ],
        },
      ],
    });

    expect(translated.input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "Compare these." },
          { type: "input_image", image_url: "data:image/png;base64,AAAA" },
          {
            type: "input_image",
            image_url: "https://x.example/a.png",
            detail: "low",
          },
        ],
      },
    ]);
  });

  it("turns an assistant's tool calls into items, and each result into an item that names its call", () => {
    const call = (id: string, args: string) => ({
      id,
      type: "function",
      function: { name: "get_time", arguments: args },
    });
    const translated = inputs({
      messages: [
        ...HI,
        {
          role: "assistant",
          content: "Checking.",
          tool_calls: [call("call_1", '{"city":"Paris"}'), call("call_2", "")],
        },
        { role: "tool", tool_call_id: "call_1", content: "12:00" },
        {
          role: "tool",
          tool_call_id: "call_2",
          content: [{ type: "text", text: "13:00" }],
        },
      ],
    });

    expect(translated.input).toEqual([
      ...HI,
      { role: "assistant", content: "Checking." },
      {
        type: "function_call",
        call_id: "call_1",
        name: "get_time",
        arguments: '{"city":"Paris"}',
      },
      {
        type: "function_call",
        call_id: "call_2",
        name: "get_time",
        arguments: "",
      },
      { type: "function_call_output", call_id: "call_1", output: "12:00" },
      { type: "function_call_output", call_id: "call_2", output: "13:00" },
    ]);
  });

  it("leaves out the text of an assistant turn that is tool calls only", () => {
    const translated = inputs({
      messages: [
        ...HI,
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", function: { name: "ping", arguments: "{}" } },
          ],
        },
      ],
    });

    expect(translated.input).toEqual([
      ...HI,
      {
        type: "function_call",
        call_id: "call_1",
        name: "ping",
        arguments: "{}",
      },
    ]);
  });

  it("sends a tool call's arguments as text when they are not text", () => {
    const translated = inputs({
      messages: [
        {
          role: "assistant",
          tool_calls: [
            { id: "call_1", function: { name: "ping", arguments: { a: 1 } } },
          ],
        },
      ],
    });

    expect((translated.input as Fields[])[0]!.arguments).toBe('{"a":1}');
  });

  describe("with tools", () => {
    const tool = (fields: Fields = {}) => ({
      type: "function",
      function: {
        name: "get_time",
        description: "The time in a city.",
        parameters: { type: "object", properties: { city: {} } },
        ...fields,
      },
    });

    it("puts each tool's fields one level up, and checks arguments strictly only when the tool says so", () => {
      const translated = inputs({
        messages: HI,
        tools: [
          tool(),
          tool({ strict: true }),
          { type: "function", function: { name: "ping" } },
        ],
      });

      expect(translated.tools).toEqual([
        {
          type: "function",
          name: "get_time",
          description: "The time in a city.",
          parameters: { type: "object", properties: { city: {} } },
          strict: false,
        },
        {
          type: "function",
          name: "get_time",
          description: "The time in a city.",
          parameters: { type: "object", properties: { city: {} } },
          strict: true,
        },
        {
          type: "function",
          name: "ping",
          parameters: { type: "object", properties: {} },
          strict: false,
        },
      ]);
    });

    it.each([
      ["auto", "auto"],
      ["none", "none"],
      ["required", "required"],
      [
        { type: "function", function: { name: "get_time" } },
        { type: "function", name: "get_time" },
      ],
    ])("translates the tool choice %j", (choice, expected) => {
      const translated = inputs({
        messages: HI,
        tools: [tool()],
        tool_choice: choice,
      });

      expect(translated.tool_choice).toEqual(expected);
    });

    it("sends no tool choice when the caller sends none", () => {
      expect(inputs({ messages: HI, tools: [tool()] })).not.toHaveProperty(
        "tool_choice",
      );
    });
  });

  it("renames the effort, and keeps the fields that have the same name", () => {
    const translated = inputs({
      messages: HI,
      reasoning_effort: "high",
      temperature: 0.2,
      top_p: 0.9,
      user: "u1",
      prompt_cache_key: "k1",
      parallel_tool_calls: false,
    });

    expect(translated).toMatchObject({
      reasoning: { effort: "high" },
      temperature: 0.2,
      top_p: 0.9,
      user: "u1",
      prompt_cache_key: "k1",
      parallel_tool_calls: false,
    });
    expect(translated).not.toHaveProperty("reasoning_effort");
  });

  it("leaves out what the Worker has used, and a cache marker", () => {
    const translated = inputs({
      model: "direct/x",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hi", cache_control: { type: "ephemeral" } },
          ],
        },
      ],
      stream: false,
      stream_options: { include_usage: true },
      cache_control: { type: "ephemeral" },
    });

    expect(translated).toEqual({
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
      store: false,
      stream: true,
    });
  });

  it("sends an assistant turn that is a refusal with the refusal as its text", () => {
    const translated = inputs({
      messages: [
        ...HI,
        { role: "assistant", content: null, refusal: "I cannot do that." },
      ],
    });

    expect(translated.input).toEqual([
      ...HI,
      { role: "assistant", content: "I cannot do that." },
    ]);
  });

  it("takes a field that is null as a field that is not there", () => {
    const translated = inputs({
      messages: HI,
      max_tokens: null,
      tools: null,
      tool_choice: null,
      reasoning_effort: null,
      seed: null,
      n: 1,
      response_format: { type: "text" },
    });

    expect(translated).toEqual({ input: HI, store: false, stream: true });
  });

  it.each([
    [{ seed: 7 }, 'the field "seed"'],
    [{ stop: ["END"] }, 'the field "stop"'],
    [{ logprobs: true }, 'the field "logprobs"'],
    [{ n: 2 }, '"n" other than 1'],
    [
      { response_format: { type: "json_object" } },
      '"response_format" other than text',
    ],
    [{ tools: [{ type: "web_search" }] }, 'a tool of the type "web_search"'],
    [{ tools: [{ type: "function" }] }, "a function tool with no function"],
    [{ tools: [null] }, 'a tool of the type "undefined"'],
    [{ tools: "bash" }, "tools that are no list"],
    [{ tool_choice: { type: "allowed_tools" } }, "that tool_choice"],
  ])("refuses %j, and says which part", (extra, part) => {
    const message = refusal({ messages: HI, ...extra });

    expect(message).toContain("OpenAI's Responses format");
    expect(message).toContain(part);
  });

  it.each([
    [{ messages: "hi" }, "messages that are no list"],
    [{ messages: [{ role: "function", content: "x" }] }, 'the role "function"'],
    [
      { messages: [{ role: "user", content: [{ type: "input_audio" }] }] },
      'a "input_audio" part in a user message',
    ],
    [
      {
        messages: [
          { role: "user", content: [{ type: "image_url", image_url: {} }] },
        ],
      },
      "an image with no URL",
    ],
    [
      {
        messages: [
          { role: "tool", tool_call_id: "c", content: [{ type: "image_url" }] },
        ],
      },
      'a "image_url" part in that message',
    ],
    [{ messages: [null] }, "a message that is no object"],
    [
      {
        messages: [
          {
            role: "assistant",
            tool_calls: [{ id: "c", type: "custom", custom: { name: "x" } }],
          },
        ],
      },
      'a tool call of the type "custom"',
    ],
  ])("refuses messages it cannot carry: %j", (body, part) => {
    expect(refusal(body)).toContain(part);
  });
});

/** An event stream as the binding sends it in this format. */
function answer(events: Fields[], split?: number): Response {
  const text = events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  const bytes = new TextEncoder().encode(text);
  // Cut into pieces of `split` bytes, to break events across chunks.
  const size = split ?? bytes.length;
  const pieces: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += size) {
    pieces.push(bytes.slice(at, at + size));
  }
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const piece of pieces) controller.enqueue(piece);
        controller.close();
      },
    }),
    {
      headers: {
        "content-type": "text/event-stream",
        "cf-aig-request-id": "r1",
      },
    },
  );
}

const START = {
  type: "response.created",
  response: { id: "resp_1", model: "gpt-6-luna", status: "in_progress" },
};
const added = (index: number, item: Fields) => ({
  type: "response.output_item.added",
  output_index: index,
  item,
});
const done = (index: number, item: Fields) => ({
  type: "response.output_item.done",
  output_index: index,
  item,
});
const text = (index: number, delta: string) => ({
  type: "response.output_text.delta",
  output_index: index,
  delta,
});
const args = (index: number, delta: string) => ({
  type: "response.function_call_arguments.delta",
  output_index: index,
  delta,
});
const RESPONSE_USAGE = {
  input_tokens: 5832,
  output_tokens: 26,
  total_tokens: 5858,
  input_tokens_details: { cached_tokens: 5757, cache_write_tokens: 0 },
  output_tokens_details: { reasoning_tokens: 12 },
};
const completed = (fields: Fields = {}) => ({
  type: "response.completed",
  response: {
    id: "resp_1",
    status: "completed",
    usage: RESPONSE_USAGE,
    ...fields,
  },
});

const TEXT = [
  START,
  { type: "response.in_progress", response: START.response },
  added(0, { type: "reasoning", id: "rs_1" }),
  done(0, { type: "reasoning", id: "rs_1" }),
  added(1, { type: "message", id: "msg_1", role: "assistant" }),
  text(1, "Hel"),
  text(1, "lo"),
  done(1, { type: "message", id: "msg_1" }),
  completed(),
];

const call = (id: string, name: string, json = "") => ({
  type: "function_call",
  id: `fc_${id}`,
  call_id: id,
  name,
  arguments: json,
});
const TOOLS = [
  START,
  added(0, { type: "reasoning", id: "rs_1" }),
  done(0, { type: "reasoning", id: "rs_1" }),
  added(1, { type: "message", id: "msg_1", role: "assistant" }),
  text(1, "Checking."),
  done(1, { type: "message", id: "msg_1" }),
  added(2, call("call_1", "get_time")),
  args(2, '{"city"'),
  args(2, ': "Paris"}'),
  done(2, call("call_1", "get_time", '{"city": "Paris"}')),
  added(3, call("call_2", "ping")),
  done(3, call("call_2", "ping", "{}")),
  added(4, call("call_3", "now")),
  done(4, call("call_3", "now")),
  completed(),
];

const USAGE = {
  prompt_tokens: 5832,
  completion_tokens: 26,
  total_tokens: 5858,
  prompt_tokens_details: { cached_tokens: 5757, cache_write_tokens: 0 },
  completion_tokens_details: { reasoning_tokens: 12 },
};

const STREAMED = { stream: true, includeUsage: true, created: 1_800_000_000 };
const WHOLE = { ...STREAMED, stream: false };

/** The data of each event of a translated stream. */
async function chunks(response: Response): Promise<unknown[]> {
  return (await response.text())
    .split("\n\n")
    .filter((event) => event !== "")
    .map((event) => {
      expect(event.startsWith("data: ")).toBe(true);
      const data = event.slice("data: ".length);
      return data === "[DONE]" ? data : JSON.parse(data);
    });
}

const HEAD = {
  id: "resp_1",
  object: "chat.completion.chunk",
  created: 1_800_000_000,
  model: "gpt-6-luna",
};
const chunk = (deltaFields: Fields, finishReason: string | null = null) => ({
  ...HEAD,
  choices: [{ index: 0, delta: deltaFields, finish_reason: finishReason }],
});
const toolChunk = (index: number, fields: Fields) =>
  chunk({ tool_calls: [{ index, ...fields }] });

describe("an answer translated from OpenAI's Responses format", () => {
  it("is a stream of Chat Completions chunks, without the model's reasoning", async () => {
    const response = fromResponses(answer(TEXT), STREAMED);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cf-aig-request-id")).toBe("r1");
    expect(await chunks(response)).toEqual([
      chunk({ role: "assistant", content: "" }),
      chunk({ content: "Hel" }),
      chunk({ content: "lo" }),
      chunk({}, "stop"),
      { ...HEAD, choices: [], usage: USAGE },
      "[DONE]",
    ]);
  });

  it("ends a stream with no usage chunk when the caller asked for none", async () => {
    const form = { ...STREAMED, includeUsage: false };

    expect((await chunks(fromResponses(answer(TEXT), form))).slice(-2)).toEqual(
      [chunk({}, "stop"), "[DONE]"],
    );
  });

  it("numbers tool calls in their order, by their call IDs, and takes arguments that come whole", async () => {
    const named = (id: string, name: string) => ({
      id,
      type: "function",
      function: { name, arguments: "" },
    });

    expect(await chunks(fromResponses(answer(TOOLS), STREAMED))).toEqual([
      chunk({ role: "assistant", content: "" }),
      chunk({ content: "Checking." }),
      toolChunk(0, named("call_1", "get_time")),
      toolChunk(0, { function: { arguments: '{"city"' } }),
      toolChunk(0, { function: { arguments: ': "Paris"}' } }),
      toolChunk(1, named("call_2", "ping")),
      // These arguments came only with the finished item.
      toolChunk(1, { function: { arguments: "{}" } }),
      toolChunk(2, named("call_3", "now")),
      // A call with no arguments at all gets an empty object.
      toolChunk(2, { function: { arguments: "{}" } }),
      chunk({}, "tool_calls"),
      { ...HEAD, choices: [], usage: USAGE },
      "[DONE]",
    ]);
  });

  it("reads events that are split across chunks", async () => {
    const response = fromResponses(answer(TEXT, 7), WHOLE);
    const body = (await response.json()) as { choices: { message: Fields }[] };

    expect(body.choices[0]!.message.content).toBe("Hello");
  });

  it("is one Chat Completions object for a caller that asked for no stream", async () => {
    const response = fromResponses(answer(TEXT), WHOLE);

    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({
      id: "resp_1",
      object: "chat.completion",
      created: 1_800_000_000,
      model: "gpt-6-luna",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hello" },
          finish_reason: "stop",
        },
      ],
      usage: USAGE,
    });
  });

  it("puts the tool calls of a whole answer in its message", async () => {
    const body = (await fromResponses(answer(TOOLS), WHOLE).json()) as {
      choices: Fields[];
    };

    expect(body.choices[0]).toEqual({
      index: 0,
      message: {
        role: "assistant",
        content: "Checking.",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "get_time", arguments: '{"city": "Paris"}' },
          },
          {
            id: "call_2",
            type: "function",
            function: { name: "ping", arguments: "{}" },
          },
          {
            id: "call_3",
            type: "function",
            function: { name: "now", arguments: "{}" },
          },
        ],
      },
      finish_reason: "tool_calls",
    });
  });

  it("gives a whole answer that is only tool calls a null content", async () => {
    const only = TOOLS.filter(
      (event) => (event as { output_index?: number }).output_index !== 1,
    );
    const body = (await fromResponses(answer(only), WHOLE).json()) as {
      choices: { message: Fields }[];
    };

    expect(body.choices[0]!.message.content).toBeNull();
  });

  it.each([
    ["max_output_tokens", "length"],
    ["content_filter", "content_filter"],
    // An answer that is cut off is never reported as whole.
    ["something_new", "length"],
    [undefined, "length"],
  ])(
    "ends an answer cut off by %s with the reason %s",
    async (reason, expected) => {
      const cut = {
        type: "response.incomplete",
        response: {
          id: "resp_1",
          status: "incomplete",
          incomplete_details: { reason },
          usage: RESPONSE_USAGE,
        },
      };
      const response = fromResponses(
        answer([START, text(0, "Hel"), cut]),
        WHOLE,
      );
      const body = (await response.json()) as {
        choices: Fields[];
        usage: Fields;
      };

      expect(body.choices[0]!.finish_reason).toBe(expected);
      expect(body.usage).toEqual(USAGE);
    },
  );

  it("counts an answer with no usage as zero tokens", async () => {
    const response = fromResponses(
      answer([START, completed({ usage: undefined })]),
      WHOLE,
    );
    const body = (await response.json()) as { usage: Fields };

    expect(body.usage).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 },
    });
  });

  it("passes on a refusal as text", async () => {
    const refused = [
      START,
      { type: "response.refusal.delta", output_index: 0, delta: "I cannot." },
      completed(),
    ];
    const body = (await fromResponses(answer(refused), WHOLE).json()) as {
      choices: { message: Fields }[];
    };

    expect(body.choices[0]!.message.content).toBe("I cannot.");
  });

  it.each([
    [
      "an error from the binding",
      Response.json({ error: "busy" }, { status: 429 }),
    ],
    ["an answer that is no event stream", Response.json({ ok: true })],
    ["an answer with no body", new Response(null, { status: 204 })],
  ])("returns %s as it is", (_name, upstream) => {
    expect(fromResponses(upstream, STREAMED)).toBe(upstream);
  });

  it.each([
    [
      "a failed answer",
      {
        type: "response.failed",
        response: {
          id: "resp_1",
          status: "failed",
          error: { code: "server_error", message: "The model failed." },
        },
      },
      { message: "The model failed.", type: "server_error" },
    ],
    [
      "an error event",
      { type: "error", code: "rate_limit_exceeded", message: "Slow down." },
      { message: "Slow down.", type: "rate_limit_exceeded" },
    ],
    [
      "an error with no code",
      { type: "error", message: "Unknown." },
      { message: "Unknown.", type: "api_error" },
    ],
  ])(
    "passes on %s that the model sends after it has started",
    async (_name, event, expected) => {
      const broken = [START, event];
      const error = { error: { ...expected, param: null, code: null } };

      expect(await chunks(fromResponses(answer(broken), STREAMED))).toEqual([
        chunk({ role: "assistant", content: "" }),
        error,
        "[DONE]",
      ]);
      expect(await fromResponses(answer(broken), WHOLE).json()).toEqual(error);
    },
  );

  it.each([
    ["a stream", STREAMED],
    ["a whole answer", WHOLE],
  ])(
    "fails %s that ends before the model has finished",
    async (_name, form) => {
      const cut = TEXT.slice(0, -1);

      await expect(fromResponses(answer(cut), form).text()).rejects.toThrow(
        "ended before the model had finished",
      );
    },
  );

  it("stops reading the model's stream when the caller stops reading", async () => {
    let cancelled = false;
    const upstream = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const first = `data: ${JSON.stringify(START)}\n\n`;
          controller.enqueue(new TextEncoder().encode(first));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
    const reader = fromResponses(upstream, STREAMED).body!.getReader();
    await reader.read();
    await reader.cancel();

    expect(cancelled).toBe(true);
  });
});
