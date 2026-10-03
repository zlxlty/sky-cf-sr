import { describe, expect, it } from "vitest";
import {
  estimateContext,
  extractFacts,
  MAX_PROJECTED_CHARS,
} from "../../src/policy/facts.ts";

const user = (content: unknown) => ({ role: "user", content });
const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;

describe("extractFacts", () => {
  it("counts messages by role", () => {
    const facts = extractFacts({
      messages: [
        { role: "system", content: "Be brief." },
        user("hi"),
        { role: "assistant", content: null, tool_calls: [{ id: "1" }] },
        { role: "tool", tool_call_id: "1", content: "42" },
        { role: "function", name: "f", content: "43" },
        "not a message",
        user("thanks"),
      ],
    });
    expect(facts).toMatchObject({
      messageCount: 7,
      userMessageCount: 2,
      toolResultCount: 2,
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
          { type: "input_text", text: "and explain it" },
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

  it("does not cut a character in half", () => {
    const text = "a".repeat(MAX_PROJECTED_CHARS - 1) + "😀b";
    const facts = extractFacts({ messages: [user(text)] });
    expect(facts.latestUserText).toBe("a".repeat(MAX_PROJECTED_CHARS - 1));
    expect(facts.latestUserTextTruncated).toBe(true);
  });

  const TOOLS = [{ type: "function", function: { name: "f" } }];
  it.each([
    [{}, false, false],
    [{ tools: TOOLS }, true, false],
    [{ tools: TOOLS, tool_choice: "required" }, true, true],
    [{ tools: TOOLS, tool_choice: "auto" }, true, false],
    [
      {
        tools: TOOLS,
        tool_choice: { type: "function", function: { name: "f" } },
      },
      true,
      true,
    ],
    [
      { tools: TOOLS, tool_choice: { type: "custom", custom: { name: "f" } } },
      true,
      true,
    ],
    [
      {
        tools: TOOLS,
        tool_choice: {
          type: "allowed_tools",
          allowed_tools: { mode: "required", tools: TOOLS },
        },
      },
      true,
      true,
    ],
    [
      {
        tools: TOOLS,
        tool_choice: {
          type: "allowed_tools",
          allowed_tools: { mode: "auto", tools: TOOLS },
        },
      },
      true,
      false,
    ],
    [{ functions: [{ name: "f" }] }, true, false],
    [{ functions: [{ name: "f" }], function_call: { name: "f" } }, true, true],
    [{ functions: [{ name: "f" }], function_call: "auto" }, true, false],
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

  it("counts malformed parts in the estimate and as absent elsewhere", () => {
    expect(
      extractFacts({ messages: "nope", tools: "nope", stream: "yes" }),
    ).toMatchObject({
      messageCount: 0,
      hasTools: false,
      stream: false,
      latestUserText: "",
      // Each "nope" is 6 bytes of structured JSON.
      contextTokenEstimate: 12,
    });
  });

  it("does not overflow the stack on a deeply nested body", () => {
    const depth = 100_000;
    const nested: unknown = JSON.parse("[".repeat(depth) + "]".repeat(depth));
    const facts = extractFacts({
      messages: [user("hi")],
      response_format: nested,
      tool_choice: nested,
    });
    // "user" and "hi" are 6 text bytes: 2 tokens, plus 4 for framing.
    expect(facts.contextTokenEstimate).toBe(2 + 4 + 2 * (2 * depth));
  });
});

describe("estimateContext", () => {
  it("counts the role and other message fields as text", () => {
    expect(
      estimateContext({
        messages: [
          { role: "user", name: "ann", content: "hello" },
          {
            role: "assistant",
            content: "ok",
            refusal: "no",
            reasoning_content: "think",
          },
        ],
      }),
    ).toMatchObject({
      textBytes:
        "user".length +
        "ann".length +
        "hello".length +
        "assistant".length +
        "ok".length +
        "no".length +
        "think".length,
      structuredBytes: 0,
      framingTokens: 2 * 4,
    });
  });

  it("counts a tool result as structured bytes, with tool-call framing", () => {
    expect(
      estimateContext({
        messages: [{ role: "tool", tool_call_id: "c1", content: "abcdefgh" }],
      }),
    ).toEqual({
      textBytes: "tool".length + "c1".length,
      // The JSON string "abcdefgh", quotes included.
      structuredBytes: 10,
      imageCount: 0,
      framingTokens: 4 + 8,
      outputReserve: 0,
      toolDefinitionCount: 0,
      tokens: 2 + 10 + 12,
    });
  });

  it("counts 100 KB of tool output as about 100,000 tokens", () => {
    const output = "x".repeat(100_000);
    const { tokens } = estimateContext({
      messages: [{ role: "tool", tool_call_id: "c1", content: output }],
    });
    expect(tokens).toBe(2 + (100_000 + 2) + 12);
  });

  it("reserves images in tool results and parts typed image", () => {
    const estimate = estimateContext({
      messages: [
        user([{ type: "image", source: { data: "AAAA" } }]),
        {
          role: "tool",
          content: [
            { type: "input_image", image_url: "data:x" },
            { type: "text", text: "caption" },
          ],
        },
      ],
    });
    expect(estimate.imageCount).toBe(2);
    // In a tool result, even a text part is structured.
    expect(estimate.structuredBytes).toBe(
      bytes({ type: "text", text: "caption" }),
    );
  });

  it("counts tool calls with their ID, type and name as text, and arguments as structured", () => {
    const tools = [{ type: "function", function: { name: "f" } }];
    const estimate = estimateContext({
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "1",
              type: "function",
              function: { name: "f", arguments: "{}" },
            },
          ],
        },
      ],
      tools,
    });
    expect(estimate).toMatchObject({
      textBytes:
        "assistant".length + "1".length + "function".length + "f".length,
      structuredBytes: bytes("{}") + bytes(tools[0]),
      framingTokens: 4 + 8 + 8,
      toolDefinitionCount: 1,
    });
  });

  it("counts a malformed tool call once, whole", () => {
    expect(
      estimateContext({
        messages: [{ role: "assistant", tool_calls: [{ id: "1" }] }],
      }),
    ).toMatchObject({
      textBytes: "assistant".length,
      structuredBytes: bytes({ id: "1" }),
      framingTokens: 4 + 8,
    });
  });

  it("uses max_completion_tokens whenever it is given, even 0", () => {
    expect(
      estimateContext({
        messages: [],
        max_completion_tokens: 0,
        max_tokens: 900,
      }),
    ).toMatchObject({ outputReserve: 0, structuredBytes: 0, tokens: 0 });
  });

  it("counts a malformed output limit as structured bytes", () => {
    expect(estimateContext({ messages: [], max_tokens: "100" })).toMatchObject({
      outputReserve: 0,
      structuredBytes: 5,
    });
  });
});

/*
 * The cases below are adapted from vLLM Semantic Router's
 * request_context_estimate_test.go (commit 590a51c,
 * https://github.com/vllm-project/semantic-router), Copyright 2026 vLLM
 * Semantic Router, licensed under the Apache License, Version 2.0. Upstream
 * reads raw JSON, so its integers beyond 2^53 keep their written length; here
 * they are parsed first, and count as JavaScript writes them.
 */
describe("estimateContext, upstream's cases", () => {
  it("keeps the cold-start heuristic for plain text", () => {
    // TestEstimateOpenAIRequestContextPlainTextPreservesColdStartHeuristic.
    const estimate = estimateContext({
      model: "auto",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(estimate.textBytes).toBe("user".length + "hello".length);
    expect(estimate.structuredBytes).toBe(0);
    expect(estimate.tokens).toBe(3 + 4);
  });

  it("counts history, tools and numbers", () => {
    // TestEstimateOpenAIRequestContextCountsHistoryToolsAndExactNumbers.
    const priorUser = "p".repeat(8_000);
    const toolResult = "r".repeat(12_000);
    const schemaDescription = "s".repeat(16_000);
    const largeInteger = 90071992547409931234567890123456789;
    const estimate = estimateContext({
      model: "auto",
      messages: [
        { role: "user", content: priorUser },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              type: "function",
              function: { name: "lookup", arguments: { ticket: largeInteger } },
            },
          ],
        },
        { role: "tool", content: toolResult },
        { role: "user", content: "ok" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "lookup",
            description: schemaDescription,
            parameters: {
              type: "object",
              properties: { ticket: { type: "integer" } },
            },
          },
        },
      ],
    });
    expect(estimate.textBytes).toBeGreaterThanOrEqual(
      priorUser.length + "lookup".length + "ok".length,
    );
    expect(estimate.structuredBytes).toBeGreaterThanOrEqual(
      schemaDescription.length +
        String(largeInteger).length +
        toolResult.length,
    );
    expect(estimate.tokens).toBeGreaterThan(Math.floor("ok".length / 4));
  });

  it("keeps the exact size of tool arguments written as a JSON string", () => {
    // TestEstimateOpenAIRequestContextToolArgumentsKeepExactRawJSONString.
    const argumentsJson =
      '"{\\"ticket\\":90071992547409931234567890123456789}"';
    const estimate = estimateContext(
      JSON.parse(`{
        "messages":[{
          "role":"assistant",
          "content":null,
          "tool_calls":[{"function":{"name":"lookup","arguments":${argumentsJson}}}]
        }]
      }`),
    );
    expect(estimate.structuredBytes).toBe(argumentsJson.length);
    expect(estimate.textBytes).toBe("assistant".length + "lookup".length);
  });

  it("gives an image a fixed budget whatever its size", () => {
    // TestEstimateOpenAIRequestContextImageUsesFixedPrivateBudget.
    const bodyWith = (payload: string) => ({
      messages: [
        user([
          { type: "text", text: "hi" },
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${payload}` },
          },
        ]),
      ],
    });
    const small = estimateContext(bodyWith("AAA"));
    const large = estimateContext(bodyWith("PRIVATE".repeat(20_000)));
    expect(large).toEqual(small);
    expect(small.imageCount).toBe(1);
    expect(small.tokens).toBe(8192 + 2 + 4);
  });

  it("counts structured schemas and the preferred output reserve once", () => {
    // TestEstimateOpenAIRequestContextUsesStructuredAndEffectiveOutputReservesOnce.
    const estimate = estimateContext({
      messages: [{ role: "user", content: "ok" }],
      tools: [
        {
          type: "function",
          function: {
            name: "emit",
            parameters: {
              type: "object",
              properties: {
                n: { type: "integer", const: 9007199254740993123456789 },
              },
            },
          },
        },
      ],
      max_tokens: 4096,
      max_completion_tokens: 2048,
    });
    expect(estimate.outputReserve).toBe(2048);
    expect(estimate.toolDefinitionCount).toBe(1);
    expect(estimate.structuredBytes).toBeGreaterThan(0);
    expect(estimate.tokens).toBeGreaterThanOrEqual(
      estimate.outputReserve +
        estimate.structuredBytes +
        estimate.framingTokens,
    );
  });

  it("counts malformed messages and legacy function results", () => {
    // TestEstimateOpenAIRequestContextCountsMalformedMessagesAndLegacyFunctionResults.
    const functionResult = '"{\\"rows\\":[1,2,3]}"';
    const malformed = 9007199254740993123456789;
    const estimate = estimateContext(
      JSON.parse(`{
        "messages":[
          ${malformed},
          {"role":"function","name":"lookup","content":${functionResult}}
        ]
      }`),
    );
    expect(estimate.structuredBytes).toBe(
      String(malformed).length + functionResult.length,
    );
    expect(estimate.framingTokens).toBe(4 + 4 + 8);
  });
});
