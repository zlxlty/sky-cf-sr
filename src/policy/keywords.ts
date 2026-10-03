/**
 * Literal keyword matching, ported from vLLM Semantic Router's keyword
 * classifier (Apache-2.0, https://github.com/vllm-project/semantic-router,
 * commit 590a51c: keyword_classifier_regex.go and structure_text.go).
 *
 * A keyword that contains a letter, digit or underscore must not touch a
 * letter, digit or underscore on either side, so "C++" matches in "C++ code"
 * but not in "C++Builder". Keywords containing CJK text, and keywords made only
 * of punctuation, match anywhere, because those scripts and symbols do not
 * separate words with spaces.
 */

import { isHighSurrogate, isLowSurrogate } from "./encoding.ts";

export type KeywordOperator = "AND" | "OR" | "NOR";

// A neighbouring character that joins a keyword to a longer word.
const LETTER_OR_DIGIT = /[\p{L}\p{Nd}]/u;
const CJK =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WORD_LIKE = /[\p{L}\p{Nd}_]/u;
// The characters that must be escaped in a regular expression with the u flag.
const SYNTAX = /[\\^$.*+?()[\]{}|/]/g;

/**
 * Returns a test for one keyword, compiled once. When `cut` is true the text
 * is the start of a longer one, so a match touching its end does not count:
 * the next character, which would decide the boundary, is missing.
 */
export function compileKeyword(
  keyword: string,
  caseSensitive: boolean,
): (text: string, cut?: boolean) => boolean {
  const pattern = new RegExp(
    keyword.replace(SYNTAX, "\\$&"),
    caseSensitive ? "gu" : "giu",
  );
  const needsBoundary = !CJK.test(keyword) && WORD_LIKE.test(keyword);

  return (text, cut = false) => {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      if (!needsBoundary) return true;
      const start = match.index;
      const end = start + match[0].length;
      const after = charAt(text, end);
      if (
        isSeparator(charBefore(text, start)) &&
        (after === undefined ? !cut : isSeparator(after))
      ) {
        return true;
      }
      // Try again one character later, so an overlapping or later occurrence counts.
      pattern.lastIndex = start + (charAt(text, start)?.length ?? 1);
    }
    return false;
  };
}

/**
 * Returns a test for a keyword rule: all keywords (AND), any (OR), or none
 * (NOR). When `cut` is true and the rest of the text could change the answer,
 * the answer is undefined: unknown.
 */
export function compileKeywordRule(
  operator: KeywordOperator,
  keywords: readonly string[],
  caseSensitive: boolean,
): (text: string, cut?: boolean) => boolean | undefined {
  const tests = keywords.map((k) => compileKeyword(k, caseSensitive));
  // What finding the keywords decides; not finding them is only final when
  // the whole text was searched.
  const decided = (found: boolean, ifFound: boolean, cut: boolean) =>
    found ? ifFound : cut ? undefined : !ifFound;
  switch (operator) {
    case "AND":
      return (text, cut = false) =>
        decided(
          tests.every((test) => test(text, cut)),
          true,
          cut,
        );
    case "OR":
      return (text, cut = false) =>
        decided(
          tests.some((test) => test(text, cut)),
          true,
          cut,
        );
    case "NOR":
      return (text, cut = false) =>
        decided(
          tests.some((test) => test(text, cut)),
          false,
          cut,
        );
  }
}

function isSeparator(char: string | undefined): boolean {
  if (char === undefined) return true;
  if (char === "_") return false;
  return !(LETTER_OR_DIGIT.test(char) && !CJK.test(char));
}

/** The character (code point) starting at `index`, or undefined at the end. */
function charAt(text: string, index: number): string | undefined {
  const code = text.codePointAt(index);
  return code === undefined ? undefined : String.fromCodePoint(code);
}

/** The character (code point) ending just before `index`, or undefined at the start. */
function charBefore(text: string, index: number): string | undefined {
  if (index === 0) return undefined;
  const pair =
    index >= 2 &&
    isLowSurrogate(text.charCodeAt(index - 1)) &&
    isHighSurrogate(text.charCodeAt(index - 2));
  return charAt(text, pair ? index - 2 : index - 1);
}
