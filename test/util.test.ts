import { describe, expect, it } from "vitest";
import { csvEscape, safeJsonParse, toCsv } from "../src/lib/util";

describe("csvEscape", () => {
  it("passes plain values through unchanged", () => {
    expect(csvEscape("jdoe")).toBe("jdoe");
    expect(csvEscape(1001)).toBe("1001");
    expect(csvEscape(null)).toBe("");
  });

  it("quotes values containing commas, quotes or newlines", () => {
    expect(csvEscape("a,b")).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
  });

  it("neutralises formula-injection triggers with a leading apostrophe", () => {
    expect(csvEscape("=1+1")).toBe("'=1+1");
    expect(csvEscape("+1")).toBe("'+1");
    expect(csvEscape("-2")).toBe("'-2");
    expect(csvEscape("@SUM(A1)")).toBe("'@SUM(A1)");
    // A formula that also contains a comma is both neutralised and quoted.
    expect(csvEscape("=HYPERLINK(1,2)")).toBe('"\'=HYPERLINK(1,2)"');
  });

  it("both neutralises and quotes a dangerous value with a comma", () => {
    // Leading '=' gets an apostrophe, and the comma forces quoting: "'=cmd,x"
    expect(csvEscape("=cmd,x")).toBe('"\'=cmd,x"');
  });
});

describe("toCsv", () => {
  it("escapes every cell and terminates rows with CRLF", () => {
    const csv = toCsv(["A", "B"], [["=x", "y,z"]]);
    // '=x' is neutralised (no comma → unquoted); 'y,z' is quoted for its comma.
    expect(csv).toBe('A,B\r\n\'=x,"y,z"\r\n');
  });
});

describe("safeJsonParse", () => {
  it("parses valid JSON", () => {
    expect(safeJsonParse('{"a":1}', {})).toEqual({ a: 1 });
  });
  it("returns the fallback for malformed or empty input", () => {
    expect(safeJsonParse("not json", { ok: true })).toEqual({ ok: true });
    expect(safeJsonParse(null, 42)).toBe(42);
    expect(safeJsonParse(undefined, 42)).toBe(42);
  });
});
