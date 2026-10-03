import { describe, expect, it } from "vitest";
import { extractFacts, MAX_PROJECTED_CHARS } from "../../src/policy/facts.ts";
import type { Evidence } from "../../src/policy/rules.ts";
import { compileSignals, type Signals } from "../../src/policy/signals.ts";

const SIGNALS: Signals = {
  keyword: [
    { name: "code_terms", operator: "OR", keywords: ["python", "C++"] },
    { name: "no_greeting", operator: "NOR", keywords: ["hello"] },
  ],
  fact: [
    { name: "long", fact: "contextTokenEstimate", atLeast: 1000 },
    { name: "short_chat", fact: "messageCount", atMost: 2 },
    { name: "tools", fact: "hasTools", equals: true },
    { name: "json", fact: "responseFormat", equals: "json_schema" },
  ],
  external: [{ type: "clef", name: "hard" }],
};

const evidenceFor = compileSignals(SIGNALS);

function states(evidence: Evidence): Record<string, string> {
  return Object.fromEntries(
    [...evidence].map(([key, value]) => [
      key,
      value.state === "unknown" ? `unknown: ${value.reason}` : value.state,
    ]),
  );
}

describe("compileSignals", () => {
  it("resolves every keyword and fact signal for a request", () => {
    const facts = extractFacts({
      messages: [{ role: "user", content: "Port this python to C++" }],
    });
    expect(states(evidenceFor(facts))).toMatchObject({
      "keyword:code_terms": "matched",
      "keyword:no_greeting": "matched",
      "fact:long": "unmatched",
      "fact:short_chat": "matched",
      "fact:tools": "unmatched",
      "fact:json": "unmatched",
    });
  });

  it("matches keywords against the latest user message only", () => {
    const facts = extractFacts({
      messages: [
        { role: "user", content: "hello, write python" },
        { role: "assistant", content: "Sure." },
        { role: "user", content: "Now explain it" },
      ],
    });
    expect(states(evidenceFor(facts))).toMatchObject({
      "keyword:code_terms": "unmatched",
      "keyword:no_greeting": "matched",
    });
  });

  it("makes keyword evidence unknown when the cut-off rest could change it", () => {
    const facts = extractFacts({
      messages: [
        { role: "user", content: "hello " + "x ".repeat(MAX_PROJECTED_CHARS) },
      ],
    });
    expect(states(evidenceFor(facts))).toMatchObject({
      // "hello" was found, so the rest cannot change these.
      "keyword:no_greeting": "unmatched",
      // "python" might be in the rest.
      "keyword:code_terms": expect.stringContaining(
        `unknown: only the first ${MAX_PROJECTED_CHARS} characters`,
      ),
    });
  });

  it("applies both bounds of a numeric fact", () => {
    const between = compileSignals({
      fact: [{ name: "mid", fact: "messageCount", atLeast: 2, atMost: 3 }],
    });
    const counts = [1, 2, 3, 4].map((n) => {
      const messages = Array.from({ length: n }, () => ({
        role: "user",
        content: "x",
      }));
      return between(extractFacts({ messages })).get("fact:mid")?.state;
    });
    expect(counts).toEqual(["unmatched", "matched", "matched", "unmatched"]);
  });

  it("takes external evidence as given", () => {
    const facts = extractFacts({ messages: [] });
    const external: Evidence = new Map([["clef:hard", { state: "matched" }]]);
    expect(evidenceFor(facts, external).get("clef:hard")).toEqual({
      state: "matched",
    });
  });

  it("marks external evidence that was not supplied as unknown", () => {
    expect(
      evidenceFor(extractFacts({ messages: [] })).get("clef:hard"),
    ).toEqual({
      state: "unknown",
      reason: "no evidence was supplied for this signal",
    });
  });

  it("ignores external evidence for signals the policy does not declare", () => {
    const external: Evidence = new Map([["clef:other", { state: "matched" }]]);
    expect(
      evidenceFor(extractFacts({ messages: [] }), external).has("clef:other"),
    ).toBe(false);
  });
});
