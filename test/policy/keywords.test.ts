/*
 * The keyword, text and expected match in these tables are taken from vLLM
 * Semantic Router's keyword_classifier_literal_boundaries_test.go (commit
 * 590a51c, https://github.com/vllm-project/semantic-router), Copyright 2026
 * vLLM Semantic Router, licensed under the Apache License, Version 2.0.
 * Upstream's confidence values and its explicit-regex case are left out,
 * because this port has neither.
 */
import { describe, expect, it } from "vitest";
import {
  compileKeyword,
  compileKeywordRule,
} from "../../src/policy/keywords.ts";

describe("literal keyword boundaries", () => {
  // TestKeywordClassifierLiteralBoundaries.
  it.each([
    ["python", "I like python code", true],
    ["数学", "我喜欢数学", true],
    ["C++", "Explain C++ move semantics", true],
    ["C#", "Convert this C# code", true],
    [".NET", "Is .NET 8 faster?", true],
    ["Answer:", "Answer: 42", true],
    ["привет", "скажи привет всем", true],
    ["café", "a café nearby", true],
    ["cat", "concatenate", false],
    ["café", "caféteria", false],
    ["привет", "приветствие", false],
    ["python", "python3", false],
  ])("%s in %j: %s", (keyword, text, expected) => {
    expect(compileKeyword(keyword, false)(text)).toBe(expected);
  });
});

describe("literal keyword neighbours", () => {
  // TestKeywordClassifierLiteralNeighborContract.
  it.each([
    ["C++", "C++Builder", false],
    ["python", "python_code", false],
    ["python", "code_python", false],
    ["C#", "C#script", false],
    [".NET", "ASP.NET", false],
    [".NET", ".NETCore", false],
    ["Answer:", "Answer:42", false],
    ["A)", "A)text", false],
    ["A)", "A) answer", true],
    ["привет", "скажи привет!", true],
    ["안녕하세요", "안녕하세요 여러분", true],
    ["안녕하세요", "안녕하세요여러분", true],
    ["こんにちは", "こんにちは 世界", true],
    ["こんにちは", "こんにちは世界", true],
    ["café", "a café nearby", true],
    ["café", "caféteria", false],
    ["C++", "解释C++语言", true],
    ["数学", "我喜欢数学课", true],
    ["C++", "C++Builder then C++", true],
    [".NET", "ASP.NET then .NET", true],
    ["C++", "c++", true],
    [",,", "A,,, ", true],
    ["*", "2*3", true],
    ["?", "what?", true],
    ["...", "wait...now", true],
    ["💡", "idea💡here", true],
  ])("%s in %j: %s", (keyword, text, expected) => {
    expect(compileKeyword(keyword, false)(text)).toBe(expected);
  });
});

describe("keyword rules", () => {
  // TestKeywordClassifierLiteralOperatorsAndRegexControl, without its
  // confidence values and its explicit-regex case.
  it.each([
    ["AND all", "AND", "C++ and .NET", ["C++", ".NET"], false, true],
    [
      "AND adjacent",
      "AND",
      "C++Builder and .NET",
      ["C++", ".NET"],
      false,
      false,
    ],
    [
      "OR with one standalone keyword",
      "OR",
      "C++Builder and .NET",
      ["C++", ".NET"],
      false,
      true,
    ],
    ["NOR rejects whole", "NOR", "C++ and .NET", ["C++", ".NET"], false, false],
    [
      "NOR ignores adjacent",
      "NOR",
      "C++Builder and ASP.NET",
      ["C++", ".NET"],
      false,
      true,
    ],
    ["case sensitive control", "OR", "c++", ["C++"], true, false],
    ["overlapping keywords", "OR", "C++", ["C", "C++"], false, true],
    [
      "AND punctuation remains substring",
      "AND",
      "2*3 what?",
      ["*", "?"],
      false,
      true,
    ],
    [
      "NOR rejects punctuation substring",
      "NOR",
      "2*3",
      ["*", "?"],
      false,
      false,
    ],
  ] as const)(
    "%s",
    (_name, operator, text, keywords, caseSensitive, expected) => {
      expect(compileKeywordRule(operator, keywords, caseSensitive)(text)).toBe(
        expected,
      );
    },
  );

  it("treats regular-expression characters literally", () => {
    expect(compileKeyword("a.b", false)("axb")).toBe(false);
    expect(compileKeyword("(x)", false)("let (x) = 1")).toBe(true);
    // The neighbour rule applies to the match, not only to letters inside it,
    // as with ".NET" in "ASP.NET".
    expect(compileKeyword("(x)", false)("f(x) = 1")).toBe(false);
    expect(compileKeyword("a-b", false)("x a-b y")).toBe(true);
  });

  it("finds a later occurrence after a rejected one", () => {
    expect(compileKeyword("cat", false)("concatenate the cat")).toBe(true);
  });

  it("checks a neighbour outside the Basic Multilingual Plane", () => {
    expect(compileKeyword("go", false)("𝐀go")).toBe(false);
    expect(compileKeyword("go", false)("💡go")).toBe(true);
  });

  it("gives the same answer when called again", () => {
    const test = compileKeyword("python", false);
    expect([test("python"), test("python"), test("no")]).toEqual([
      true,
      true,
      false,
    ]);
  });
});
