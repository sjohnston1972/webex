import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

// The PIN is the only front door on a public URL, and a hit hands over Webex
// org-admin tokens and CUCM credentials for every project. A 6-digit PIN is a
// 10^6 keyspace, so unlimited guessing is the whole vulnerability.

const CORRECT = "435040";

function attempt(pin: string): Promise<Response> {
  return SELF.fetch("http://x/api/pin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin }),
  });
}

async function wrongAttempts(n: number): Promise<Response> {
  let res!: Response;
  for (let i = 0; i < n; i++) res = await attempt(String(100000 + i));
  return res;
}

describe("PIN brute-force lockout", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM pin_attempts").run();
  });

  it("still accepts the correct PIN when nothing is locked", async () => {
    const res = await attempt(CORRECT);
    expect(res.status).toBe(200);
  });

  it("locks out after five wrong PINs and answers 429 with Retry-After", async () => {
    const fifth = await wrongAttempts(5);
    expect(fifth.status).toBe(401);

    const sixth = await attempt("999999");
    expect(sixth.status).toBe(429);
    expect(Number(sixth.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("rejects even the correct PIN while locked out", async () => {
    await wrongAttempts(5);
    const res = await attempt(CORRECT);
    expect(res.status).toBe(429);
  });

  it("accepts the correct PIN once the lockout has expired", async () => {
    await wrongAttempts(5);
    expect((await attempt(CORRECT)).status).toBe(429);

    await env.DB.prepare("UPDATE pin_attempts SET locked_until = ?")
      .bind(new Date(Date.now() - 1000).toISOString())
      .run();

    const res = await attempt(CORRECT);
    expect(res.status).toBe(200);
  });

  it("resets the failure counter after a successful login", async () => {
    await wrongAttempts(4);
    expect((await attempt(CORRECT)).status).toBe(200);

    // The counter is back to zero, so four more failures must not lock us out.
    const res = await wrongAttempts(4);
    expect(res.status).toBe(401);
  });

  it("persists the lockout in D1, not isolate memory", async () => {
    await wrongAttempts(5);
    const row = await env.DB.prepare("SELECT locked_until FROM pin_attempts WHERE locked_until IS NOT NULL")
      .first<{ locked_until: string }>();
    expect(row).not.toBeNull();
    expect(Date.parse(row!.locked_until)).toBeGreaterThan(Date.now());
  });
});
