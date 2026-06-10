import { describe, expect, it } from "vitest";
import { matchGreeting } from "../src/parsers/greetings";

const boxes = [
  { alias: "jdoe", extension: "1001" },
  { alias: "asmith", extension: null },
];

describe("matchGreeting", () => {
  it("matches by alias, case-insensitively", () => {
    expect(matchGreeting("JDoe.wav", boxes)).toBe("jdoe");
    expect(matchGreeting("greetings/ASMITH.WAV", boxes)).toBe("asmith");
  });
  it("matches by extension", () => {
    expect(matchGreeting("1001.wav", boxes)).toBe("jdoe");
  });
  it("prefers alias matches over extension matches", () => {
    const tricky = [{ alias: "1001", extension: "2002" }, { alias: "x", extension: "1001" }];
    expect(matchGreeting("1001.wav", tricky)).toBe("1001");
  });
  it("returns null for orphans", () => {
    expect(matchGreeting("nobody.wav", boxes)).toBeNull();
  });
});
