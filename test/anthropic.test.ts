import { describe, expect, it } from "vitest";
import { fromAnthropic, toAnthropic } from "../src/anthropic.ts";

type Fields = Record<string, unknown>;

const HI = [{ role: "user", content: "hi" }];

/** The inputs for a body, which must be one this path can carry. */
function inputs(body: Fields, sessionId: string | null = null): Fields {
  const translated = toAnthropic(body, sessionId);
  if ("refused" in translated) throw new Error(translated.refused);
  return translated.inputs;
}

function refusal(body: Fields): string {
  const translated = toAnthropic(body, null);
  return "refused" in translated ? translated.refused : "not refused";
}

describe("a request translated to Anthropic's format", () => {
  it("carries the messages, a limit on output, and always asks for a stream", () => {
    expect(inputs({ model: "direct/x", messages: HI })).toEqual({
      max_tokens: 16_384,
      messages: HI,
      stream: true,
    });
  });

  it.each([
    [{ max_tokens: 20 }, 20],
    [{ max_completion_tokens: 30 }, 30],
    [{ max_tokens: 20, max_completion_tokens: 30 }, 30],
  ])("takes the caller's limit on output: %j", (limit, expected) => {
    expect(inputs({ messages: HI, ...limit }).max_tokens).toBe(expected);
  });

  it("joins system and developer messages into one text, wherever they are", () => {
    const translated = inputs({
      messages: [
        { role: "system", content: "Be terse." },
        ...HI,
        { role: "developer", content: [{ type: "text", text: "No lists." }] },
      ],
    });

    expect(translated.system).toBe("Be terse.\n\nNo lists.");
    expect(translated.messages).toEqual(HI);
  });

  it("turns a user message's parts into text and image blocks", () => {
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
              image_url: { url: "https://x.example/a.png" },
            },
          ],
        },
      ],
    });

    expect(translated.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Compare these." },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "AAAA" },
          },
          {
            type: "image",
            source: { type: "url", url: "https://x.example/a.png" },
          },
        ],
      },
    ]);
  });

  it("turns an assistant's tool calls into blocks, and their results into one user message", () => {
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
          tool_calls: [
            call("call_1", '{"city":"Paris"}'),
            call("call_2", "{}"),
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "10:00" },
        { role: "tool", tool_call_id: "call_2", content: "17:00" },
        { role: "user", content: "And now?" },
      ],
    });

    expect(translated.messages).toEqual([
      ...HI,
      {
        role: "assistant",
        content: [
          { type: "text", text: "Checking." },
          {
            type: "tool_use",
            id: "call_1",
            name: "get_time",
            input: { city: "Paris" },
          },
          { type: "tool_use", id: "call_2", name: "get_time", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "10:00" },
          { type: "tool_result", tool_use_id: "call_2", content: "17:00" },
        ],
      },
      { role: "user", content: "And now?" },
    ]);
  });

  it("sends a tool call whose arguments are no JSON object with an empty input", () => {
    const translated = inputs({
      messages: [
        ...HI,
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", function: { name: "f", arguments: "{broken" } },
            { id: "call_2", function: { name: "f", arguments: "[1]" } },
          ],
        },
      ],
    });

    const blocks = (translated.messages as Fields[])[1]!.content as Fields[];
    expect(blocks.map((block) => block.input)).toEqual([{}, {}]);
  });

  it("leaves out an assistant turn that is empty", () => {
    const translated = inputs({
      messages: [...HI, { role: "assistant", content: "" }, ...HI],
    });

    expect(translated.messages).toEqual([...HI, ...HI]);
  });

  describe("with tools", () => {
    const tools = [
      {
        type: "function",
        function: {
          name: "get_time",
          description: "The local time.",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
          },
        },
      },
      { type: "function", function: { name: "ping" } },
    ];

    it("names each tool's parameters as Anthropic does", () => {
      expect(inputs({ messages: HI, tools }).tools).toEqual([
        {
          name: "get_time",
          description: "The local time.",
          input_schema: {
            type: "object",
            properties: { city: { type: "string" } },
          },
        },
        { name: "ping", input_schema: { type: "object", properties: {} } },
      ]);
    });

    it.each([
      ["auto", { type: "auto" }],
      ["none", { type: "none" }],
      ["required", { type: "any" }],
      [
        { type: "function", function: { name: "ping" } },
        { type: "tool", name: "ping" },
      ],
    ])("translates the tool choice %j", (choice, expected) => {
      const translated = inputs({ messages: HI, tools, tool_choice: choice });
      expect(translated.tool_choice).toEqual(expected);
    });

    it("sends no tool choice when the caller sends none", () => {
      expect(inputs({ messages: HI, tools })).not.toHaveProperty("tool_choice");
    });

    it("asks for one tool call at a time when the caller turns parallel calls off", () => {
      const off = { messages: HI, tools, parallel_tool_calls: false };

      expect(inputs(off).tool_choice).toEqual({
        type: "auto",
        disable_parallel_tool_use: true,
      });
      expect(inputs({ ...off, tool_choice: "required" }).tool_choice).toEqual({
        type: "any",
        disable_parallel_tool_use: true,
      });
      expect(inputs({ ...off, tool_choice: "none" }).tool_choice).toEqual({
        type: "none",
      });
    });
  });

  it("renames the stop sequences, the effort and the user", () => {
    const translated = inputs({
      messages: HI,
      stop: "END",
      reasoning_effort: "high",
      user: "someone",
    });

    expect(translated.stop_sequences).toEqual(["END"]);
    expect(translated.output_config).toEqual({ effort: "high" });
    expect(translated.metadata).toEqual({ user_id: "someone" });
    expect(inputs({ messages: HI, stop: ["A", "B"] }).stop_sequences).toEqual([
      "A",
      "B",
    ]);
  });

  it("leaves out the sampling settings the model refuses, and what the Worker has used", () => {
    const translated = inputs({
      model: "direct/x",
      messages: HI,
      temperature: 0,
      top_p: 0.9,
      stream: false,
      stream_options: { include_usage: true },
      prompt_cache_key: "mine",
      n: 1,
      response_format: { type: "text" },
    });

    expect(translated).toEqual({
      max_tokens: 16_384,
      messages: HI,
      stream: true,
    });
  });

  it("takes a field that is null as a field that is not there", () => {
    const translated = inputs({
      messages: HI,
      max_tokens: null,
      stop: null,
      tools: null,
      tool_choice: null,
      user: null,
      seed: null,
    });

    expect(translated).toEqual({
      max_tokens: 16_384,
      messages: HI,
      stream: true,
    });
  });

  it.each([
    [{ seed: 7 }, 'the field "seed"'],
    [{ logprobs: true }, 'the field "logprobs"'],
    [{ n: 2 }, '"n" other than 1'],
    [
      { response_format: { type: "json_object" } },
      '"response_format" other than text',
    ],
    [{ tool_choice: { type: "allowed_tools" }, tools: [] }, "that tool_choice"],
    [{ tools: [{ type: "web_search" }] }, 'a tool of the type "web_search"'],
  ])("refuses what it cannot carry, and names it: %j", (extra, named) => {
    const message = refusal({ messages: HI, ...extra });

    expect(message).toContain(named);
    expect(message).toContain("Anthropic's format");
  });

  it.each([
    [
      [{ role: "function", content: "x" }],
      'a message with the role "function"',
    ],
    [
      [{ role: "user", content: [{ type: "input_audio" }] }],
      'a "input_audio" part in a user message',
    ],
    [
      [{ role: "system", content: [{ type: "image_url" }] }],
      'a "image_url" part',
    ],
    ["not a list", "messages that are no list"],
  ])("refuses messages it cannot carry: %j", (messages, named) => {
    expect(refusal({ messages })).toContain(named);
  });

  describe("and its cache marker", () => {
    it("is one marker at the top level, for a call in a session", () => {
      expect(inputs({ messages: HI }, "session-1").cache_control).toEqual({
        type: "ephemeral",
      });
    });

    it("is absent for a call with no session", () => {
      expect(inputs({ messages: HI })).not.toHaveProperty("cache_control");
    });

    it("is the caller's own, when the caller sends one at the top level", () => {
      const own = { type: "ephemeral", ttl: "1h" };

      expect(inputs({ messages: HI, cache_control: own }).cache_control).toBe(
        own,
      );
      expect(
        inputs({ messages: HI, cache_control: own }, "session-1").cache_control,
      ).toBe(own);
    });

    it("is not added when the caller has marked a part of a message", () => {
      const marked = {
        type: "text",
        text: "a long document",
        cache_control: { type: "ephemeral" },
      };
      const translated = inputs(
        { messages: [{ role: "user", content: [marked] }] },
        "session-1",
      );

      expect(translated).not.toHaveProperty("cache_control");
      expect(translated.messages).toEqual([
        { role: "user", content: [marked] },
      ]);
    });
  });
});

/** An event stream as the binding sends it for this model. */
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
  type: "message_start",
  message: {
    id: "msg_1",
    model: "claude-opus-5-5",
    usage: {
      input_tokens: 4,
      cache_creation_input_tokens: 21,
      cache_read_input_tokens: 8120,
      output_tokens: 1,
    },
  },
};
const delta = (index: number, fields: Fields) => ({
  type: "content_block_delta",
  index,
  delta: fields,
});
const block = (index: number, fields: Fields) => ({
  type: "content_block_start",
  index,
  content_block: fields,
});
const stop = (index: number) => ({ type: "content_block_stop", index });
const end = (reason: string, output = 12, thinking = 5) => [
  {
    type: "message_delta",
    delta: { stop_reason: reason },
    usage: {
      output_tokens: output,
      output_tokens_details: { thinking_tokens: thinking },
    },
  },
  { type: "message_stop" },
];

const TEXT = [
  START,
  block(0, { type: "thinking", thinking: "" }),
  delta(0, { type: "thinking_delta", thinking: "" }),
  delta(0, { type: "signature_delta", signature: "abc" }),
  stop(0),
  block(1, { type: "text", text: "" }),
  { type: "ping" },
  delta(1, { type: "text_delta", text: "Hel" }),
  delta(1, { type: "text_delta", text: "lo" }),
  stop(1),
  ...end("end_turn"),
];

const TOOLS = [
  START,
  block(0, { type: "text", text: "" }),
  delta(0, { type: "text_delta", text: "Checking." }),
  stop(0),
  block(1, { type: "tool_use", id: "toolu_1", name: "get_time", input: {} }),
  delta(1, { type: "input_json_delta", partial_json: "" }),
  delta(1, { type: "input_json_delta", partial_json: '{"city"' }),
  delta(1, { type: "input_json_delta", partial_json: ': "Paris"}' }),
  stop(1),
  block(2, { type: "tool_use", id: "toolu_2", name: "ping", input: {} }),
  delta(2, { type: "input_json_delta", partial_json: "" }),
  stop(2),
  ...end("tool_use"),
];

const USAGE = {
  prompt_tokens: 8145,
  completion_tokens: 12,
  total_tokens: 8157,
  prompt_tokens_details: { cached_tokens: 8120, cache_write_tokens: 21 },
  completion_tokens_details: { reasoning_tokens: 5 },
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
  id: "msg_1",
  object: "chat.completion.chunk",
  created: 1_800_000_000,
  model: "claude-opus-5-5",
};
const chunk = (deltaFields: Fields, finishReason: string | null = null) => ({
  ...HEAD,
  choices: [{ index: 0, delta: deltaFields, finish_reason: finishReason }],
});

describe("an answer translated from Anthropic's format", () => {
  it("is a stream of Chat Completions chunks, without the model's thinking", async () => {
    const response = fromAnthropic(answer(TEXT), STREAMED);

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
    const response = fromAnthropic(answer(TEXT), {
      ...STREAMED,
      includeUsage: false,
    });

    const sent = await chunks(response);
    expect(sent.at(-2)).toEqual(chunk({}, "stop"));
    expect(sent.at(-1)).toBe("[DONE]");
  });

  it("numbers tool calls in their order, and gives a call with no arguments an empty object", async () => {
    const tool = (index: number, fields: Fields) => ({
      tool_calls: [{ index, ...fields }],
    });

    expect(await chunks(fromAnthropic(answer(TOOLS), STREAMED))).toEqual([
      chunk({ role: "assistant", content: "" }),
      chunk({ content: "Checking." }),
      chunk(
        tool(0, {
          id: "toolu_1",
          type: "function",
          function: { name: "get_time", arguments: "" },
        }),
      ),
      chunk(tool(0, { function: { arguments: '{"city"' } })),
      chunk(tool(0, { function: { arguments: ': "Paris"}' } })),
      chunk(
        tool(1, {
          id: "toolu_2",
          type: "function",
          function: { name: "ping", arguments: "" },
        }),
      ),
      chunk(tool(1, { function: { arguments: "{}" } })),
      chunk({}, "tool_calls"),
      { ...HEAD, choices: [], usage: USAGE },
      "[DONE]",
    ]);
  });

  it("reads events that are split across chunks", async () => {
    const split = fromAnthropic(answer(TOOLS, 7), STREAMED);
    const unsplit = fromAnthropic(answer(TOOLS), STREAMED);

    expect(await chunks(split)).toEqual(await chunks(unsplit));
  });

  it("is one Chat Completions object for a caller that asked for no stream", async () => {
    const response = fromAnthropic(answer(TEXT), WHOLE);

    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({
      id: "msg_1",
      object: "chat.completion",
      created: 1_800_000_000,
      model: "claude-opus-5-5",
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
    const body = (await fromAnthropic(answer(TOOLS), WHOLE).json()) as {
      choices: Fields[];
    };

    expect(body.choices[0]).toEqual({
      index: 0,
      message: {
        role: "assistant",
        content: "Checking.",
        tool_calls: [
          {
            id: "toolu_1",
            type: "function",
            function: { name: "get_time", arguments: '{"city": "Paris"}' },
          },
          {
            id: "toolu_2",
            type: "function",
            function: { name: "ping", arguments: "{}" },
          },
        ],
      },
      finish_reason: "tool_calls",
    });
  });

  it("gives a whole answer that is only tool calls a null content", async () => {
    const only = TOOLS.filter(
      (event) => (event as { index?: number }).index !== 0,
    );
    const body = (await fromAnthropic(answer(only), WHOLE).json()) as {
      choices: { message: Fields }[];
    };

    expect(body.choices[0]!.message.content).toBeNull();
  });

  it.each([
    ["end_turn", "stop"],
    ["stop_sequence", "stop"],
    ["max_tokens", "length"],
    ["tool_use", "tool_calls"],
    ["refusal", "content_filter"],
    ["something_new", "stop"],
  ])("gives the stop reason %s as %s", async (reason, expected) => {
    const response = fromAnthropic(answer([START, ...end(reason)]), WHOLE);
    const body = (await response.json()) as { choices: Fields[] };

    expect(body.choices[0]!.finish_reason).toBe(expected);
  });

  it("counts cached tokens in the prompt, as OpenAI does", async () => {
    const response = fromAnthropic(answer([START, ...end("end_turn")]), WHOLE);
    const body = (await response.json()) as { usage: Fields };

    // 4 fresh, 21 written to the cache and 8,120 read from it.
    expect(body.usage).toEqual(USAGE);
  });

  it.each([
    [
      "an error from the binding",
      Response.json({ error: "busy" }, { status: 429 }),
    ],
    ["an answer that is no event stream", Response.json({ ok: true })],
    ["an answer with no body", new Response(null, { status: 204 })],
  ])("returns %s as it is", (_name, upstream) => {
    expect(fromAnthropic(upstream, STREAMED)).toBe(upstream);
  });

  it("passes on an error the model sends after it has started", async () => {
    const broken = [
      START,
      {
        type: "error",
        error: { type: "overloaded_error", message: "Overloaded" },
      },
    ];
    const error = {
      error: {
        message: "Overloaded",
        type: "overloaded_error",
        param: null,
        code: null,
      },
    };

    expect(await chunks(fromAnthropic(answer(broken), STREAMED))).toEqual([
      chunk({ role: "assistant", content: "" }),
      error,
      "[DONE]",
    ]);
    expect(await fromAnthropic(answer(broken), WHOLE).json()).toEqual(error);
  });

  it.each([
    ["a stream", STREAMED],
    ["a whole answer", WHOLE],
  ])(
    "fails %s that ends before the model has finished",
    async (_name, form) => {
      const cut = TEXT.slice(0, -2);

      await expect(fromAnthropic(answer(cut), form).text()).rejects.toThrow(
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
    const reader = fromAnthropic(upstream, STREAMED).body!.getReader();
    await reader.read();
    await reader.cancel();

    expect(cancelled).toBe(true);
  });
});
