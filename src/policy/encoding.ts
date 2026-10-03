/**
 * Byte counts for the context estimate, computed without building strings or
 * recursing, so a large or deeply nested request body costs little and cannot
 * overflow the stack.
 */

export const isHighSurrogate = (unit: number) =>
  unit >= 0xd800 && unit <= 0xdbff;
export const isLowSurrogate = (unit: number) =>
  unit >= 0xdc00 && unit <= 0xdfff;

/** The length of `text` in UTF-8, as `TextEncoder` encodes it. */
export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (isHighSurrogate(unit) && isLowSurrogate(text.charCodeAt(i + 1))) {
      bytes += 4;
      i++;
    } else {
      // Includes a lone surrogate, which is encoded as U+FFFD.
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * The length in UTF-8 of `JSON.stringify(value)` for a parsed JSON value, or
 * 0 when it writes nothing.
 */
export function jsonBytes(value: unknown): number {
  let bytes = 0;
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const item = pending.pop();
    switch (typeof item) {
      case "string":
        bytes += quotedBytes(item);
        break;
      case "number":
        bytes += Number.isFinite(item) ? String(item).length : "null".length;
        break;
      case "boolean":
        bytes += item ? "true".length : "false".length;
        break;
      case "object":
        if (item === null) {
          bytes += "null".length;
        } else if (Array.isArray(item)) {
          // Brackets, and a comma between elements.
          bytes += item.length === 0 ? 2 : item.length + 1;
          for (const element of item) {
            pending.push(isWritten(element) ? element : null);
          }
        } else {
          let members = 0;
          for (const [key, member] of Object.entries(item)) {
            if (!isWritten(member)) continue;
            // The quoted key and its colon.
            bytes += quotedBytes(key) + 1;
            pending.push(member);
            members++;
          }
          bytes += members === 0 ? 2 : members + 1;
        }
        break;
    }
  }
  return bytes;
}

/** Whether `JSON.stringify` writes a value, rather than skipping it or writing null. */
function isWritten(value: unknown): boolean {
  return (
    value !== undefined &&
    typeof value !== "function" &&
    typeof value !== "symbol"
  );
}

/** The UTF-8 length of a string as JSON writes it: quoted and escaped. */
function quotedBytes(text: string): number {
  let bytes = 2;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit === 0x22 || unit === 0x5c) {
      // \" and \\
      bytes += 2;
    } else if (unit < 0x20) {
      // \b \t \n \f \r, or \u00XX for the other control characters.
      bytes += unit >= 0x08 && unit <= 0x0d && unit !== 0x0b ? 2 : 6;
    } else if (unit < 0x80) {
      bytes += 1;
    } else if (unit < 0x800) {
      bytes += 2;
    } else if (
      isHighSurrogate(unit) &&
      isLowSurrogate(text.charCodeAt(i + 1))
    ) {
      bytes += 4;
      i++;
    } else if (isHighSurrogate(unit) || isLowSurrogate(unit)) {
      // A lone surrogate is written as \uXXXX.
      bytes += 6;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}
