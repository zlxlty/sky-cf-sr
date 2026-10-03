import { describe, expect, it } from "vitest";
import { jsonBytes, utf8Bytes } from "../../src/policy/encoding.ts";

const encoder = new TextEncoder();
const lone = (unit: number) => String.fromCharCode(unit);

// Every control character, the characters JSON escapes, each UTF-8 width,
// a surrogate pair, lone surrogates of both kinds, and separators JavaScript
// treats specially.
const STRINGS = [
  "",
  "plain",
  Array.from({ length: 0x20 }, (_, i) => String.fromCharCode(i)).join(""),
  'quote " and backslash \\',
  "é ß ü",
  "数学 中文",
  "😀 𝐀",
  lone(0xd83d),
  lone(0xde00),
  `a${lone(0xd83d)}b${lone(0xde00)}c`,
  `${lone(0xde00)}${lone(0xd83d)}`,
  String.fromCharCode(0x2028, 0x2029, 0x7f, 0xfeff),
];

/** A small seeded generator, so a failure can be reproduced. */
function random(seed: number): () => number {
  return () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    return seed / 2 ** 31;
  };
}

function randomValue(next: () => number, depth: number): unknown {
  const pick = Math.floor(next() * (depth > 4 ? 4 : 6));
  switch (pick) {
    case 0:
      return STRINGS[Math.floor(next() * STRINGS.length)]!;
    case 1:
      return [0, -0, 1.5e-7, 1e21, -42, 2 ** 53 + 2, Number.MAX_VALUE][
        Math.floor(next() * 7)
      ];
    case 2:
      return next() < 0.5;
    case 3:
      return null;
    case 4:
      return Array.from({ length: Math.floor(next() * 4) }, () =>
        randomValue(next, depth + 1),
      );
    default:
      return Object.fromEntries(
        Array.from({ length: Math.floor(next() * 4) }, (_, i) => [
          `${STRINGS[Math.floor(next() * STRINGS.length)]}${i}`,
          randomValue(next, depth + 1),
        ]),
      );
  }
}

describe("utf8Bytes", () => {
  it.each(STRINGS.map((s) => [JSON.stringify(s), s]))(
    "measures %s as TextEncoder does",
    (_label, text) => {
      expect(utf8Bytes(text)).toBe(encoder.encode(text).length);
    },
  );
});

describe("jsonBytes", () => {
  it.each(STRINGS.map((s) => [JSON.stringify(s), s]))(
    "measures the string %s as JSON.stringify writes it",
    (_label, text) => {
      expect(jsonBytes(text)).toBe(encoder.encode(JSON.stringify(text)).length);
    },
  );

  it.each([
    0,
    -0,
    1.5e-7,
    1e21,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    true,
    false,
    null,
    [],
    {},
    [undefined, () => 1],
    { skipped: undefined, kept: 1 },
  ])("measures %j as JSON.stringify writes it", (value) => {
    expect(jsonBytes(value)).toBe(encoder.encode(JSON.stringify(value)).length);
  });

  it("measures nothing for a value JSON does not write", () => {
    expect(jsonBytes(undefined)).toBe(0);
  });

  it("agrees with JSON.stringify on 2,000 random values", () => {
    const next = random(7);
    for (let i = 0; i < 2_000; i++) {
      const value = randomValue(next, 0);
      expect(jsonBytes(value)).toBe(
        encoder.encode(JSON.stringify(value)).length,
      );
    }
  });

  it("measures a value nested 100,000 levels deep without recursion", () => {
    const depth = 100_000;
    const nested: unknown = JSON.parse(
      '{"a":'.repeat(depth) + "1" + "}".repeat(depth),
    );
    expect(jsonBytes(nested)).toBe(depth * '{"a":}'.length + 1);
  });
});
