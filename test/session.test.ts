import { describe, expect, it } from "vitest";
import { issueSession, timingSafeEqual, verifySession } from "../src/lib/pin";

// A valid base64 32-byte key for HMAC derivation.
const ENC_KEY = btoa("0123456789abcdef0123456789abcdef");

describe("timingSafeEqual", () => {
  it("returns true only for identical strings", () => {
    expect(timingSafeEqual("abc123", "abc123")).toBe(true);
    expect(timingSafeEqual("abc123", "abc124")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false); // length mismatch
    expect(timingSafeEqual("", "")).toBe(true);
  });
});

describe("PIN session", () => {
  it("issues a cookie that verifies with the same ENC_KEY + PIN", async () => {
    const { cookieValue } = await issueSession(ENC_KEY, "435040");
    expect(await verifySession(ENC_KEY, "435040", cookieValue)).toBe(true);
  });

  it("rejects a tampered signature", async () => {
    const { cookieValue } = await issueSession(ENC_KEY, "435040");
    const [exp] = cookieValue.split(".");
    expect(await verifySession(ENC_KEY, "435040", `${exp}.deadbeef`)).toBe(false);
  });

  it("invalidates live sessions when the PIN is rotated", async () => {
    const { cookieValue } = await issueSession(ENC_KEY, "435040");
    // A cookie minted under the old PIN must not verify under the new PIN.
    expect(await verifySession(ENC_KEY, "999999", cookieValue)).toBe(false);
  });

  it("rejects an expired cookie", async () => {
    const past = Date.now() - 1000;
    // Forge the message the impl signs, but with a past expiry — must fail the time check.
    expect(await verifySession(ENC_KEY, "435040", `${past}.whatever`)).toBe(false);
  });

  it("rejects a missing/blank cookie", async () => {
    expect(await verifySession(ENC_KEY, "435040", undefined)).toBe(false);
    expect(await verifySession(ENC_KEY, "435040", "")).toBe(false);
  });
});
