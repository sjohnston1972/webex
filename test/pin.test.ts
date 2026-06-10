import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authedFetch } from "./helpers";

describe("PIN gate", () => {
  it("rejects API requests without a session", async () => {
    const res = await SELF.fetch("http://x/api/projects");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("pin_required");
  });

  it("leaves the health endpoint open", async () => {
    const res = await SELF.fetch("http://x/api/health");
    expect(res.status).toBe(200);
  });

  it("rejects a wrong PIN", async () => {
    const res = await SELF.fetch("http://x/api/pin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: "000000" }),
    });
    expect(res.status).toBe(401);
  });

  it("grants a session for the right PIN and allows API access", async () => {
    const res = await authedFetch("http://x/api/projects");
    expect(res.status).toBe(200);
  });

  it("gates the OAuth routes too", async () => {
    const res = await SELF.fetch("http://x/auth/login?project=x", { redirect: "manual" });
    expect(res.status).toBe(401);
  });
});
