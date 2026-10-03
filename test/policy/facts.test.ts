import { describe, expect, it } from "vitest";
import { extractFacts, MAX_PROJECTED_CHARS } from "../../src/policy/facts.ts";

const user = (content: unknown) => ({ role: "user", content });

describe("extractFacts", () => {
  it("counts messages by role", () => {
    const facts = extractFacts({
      messages: [
        { role: "system", content: "Be brief." },
        user("hi"),
        { role: "assistant", content: null, tool_calls: [{ id: "1" }] },
        { role: "tool", tool_call_id: "1", content: "42" },
        user("thanks"),
      ],
    });
    expect(facts).toMatchObject({
      messageCount: 5,
      userMessageCount: 2,
      toolResultCount: 1,
    });
  });

  it("projects the latest user message's text, joining text parts", () => {
    const facts = extractFacts({
      messages: [
        user("first question"),
        { role: "assistant", content: "answer" },
        user([
          { type: "text", text: "Look at this" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,AAAA" },
          },
          { type: "text", text: "and explain it" },
        ]),
      ],
    });
    expect(facts.latestUserText).toBe("Look at this\nand explain it");
    expect(facts.imageCount).toBe(1);
    expect(facts.latestUserTextTruncated).toBe(false);
  });

  it("cuts a very long latest message for keyword matching, and says so", () => {
    const facts = extractFacts({
      messages: [user("x".repeat(MAX_PROJECTED_CHARS + 10))],
    });
    expect(facts.latestUserText).toHaveLength(MAX_PROJECTED_CHARS);
    expect(facts.latestUserTextTruncated).toBe(true);
  });

  it.each([
    [{}, false, false],
    [{ tools: [{ type: "function", function: { name: "f" } }] }, true, false],
    [
      {
        tools: [{ type: "function", function: { name: "f" } }],
        tool_choice: "required",
      },
      true,
      true,
    ],
    [
      {
        tools: [{ type: "function", function: { name: "f" } }],
        tool_choice: { type: "function", function: { name: "f" } },
      },
      true,
      true,
    ],
    [
      {
        tools: [{ type: "function", function: { name: "f" } }],
        tool_choice: "auto",
      },
      true,
      false,
    ],
    [{ functions: [{ name: "f" }] }, true, false],
  ])("reads tool use from %j", (extra, hasTools, requiresToolCall) => {
    expect(extractFacts({ messages: [user("hi")], ...extra })).toMatchObject({
      hasTools,
      requiresToolCall,
    });
  });

  it.each([
    [undefined, "text"],
    [{ type: "text" }, "text"],
    [{ type: "json_object" }, "json_object"],
    [
      { type: "json_schema", json_schema: { name: "s", schema: {} } },
      "json_schema",
    ],
  ])("reads response_format %j as %s", (format, expected) => {
    expect(
      extractFacts({ messages: [user("hi")], response_format: format })
        .responseFormat,
    ).toBe(expected);
  });

  describe("the context estimate", () => {
    it("follows upstream's formula", () => {
      // 2 messages of 10 and 6 text bytes: ceil(16 / 4) = 4 tokens of text,
      // plus 4 framing tokens per message, plus the 100 requested output tokens.
      const facts = extractFacts({
        messages: [
          user("0123456789"),
          { role: "assistant", content: "abcdef" },
        ],
        max_tokens: 100,
      });
      expect(facts.contextTokenEstimate).toBe(4 + 2 * 4 + 100);
    });

    it("counts UTF-8 bytes, not characters", () => {
      // "数学" is 6 bytes: ceil(6 / 4) = 2 tokens, plus 4 for framing.
      expect(
        extractFacts({ messages: [user("数学")] }).contextTokenEstimate,
      ).toBe(6);
    });

    it("reserves 8,192 tokens per image instead of counting its bytes", () => {
      const facts = extractFacts({
        messages: [
          user([
            { type: "image_url", image_url: { url: "data:x".repeat(1000) } },
          ]),
        ],
      });
      expect(facts.contextTokenEstimate).toBe(8192 + 4);
    });

    it("counts tool definitions and calls as one token per byte, plus framing", () => {
      const tools = [{ type: "function", function: { name: "f" } }];
      const calls = [
        { id: "1", type: "function", function: { name: "f", arguments: "{}" } },
      ];
      const facts = extractFacts({
        messages: [{ role: "assistant", content: null, tool_calls: calls }],
        tools,
      });
      const bytes = (v: unknown) =>
        new TextEncoder().encode(JSON.stringify(v)).length;
      expect(facts.contextTokenEstimate).toBe(
        bytes(calls) + bytes(tools) + 4 + 8 + 8,
      );
    });

    it("prefers max_completion_tokens to max_tokens", () => {
      const facts = extractFacts({
        messages: [],
        max_completion_tokens: 50,
        max_tokens: 900,
      });
      expect(facts.contextTokenEstimate).toBe(50);
    });
  });

  it("treats malformed parts as absent", () => {
    expect(
      extractFacts({ messages: "nope", tools: "nope", stream: "yes" }),
    ).toMatchObject({
      messageCount: 0,
      hasTools: false,
      stream: false,
      latestUserText: "",
      contextTokenEstimate: 0,
    });
  });
});
