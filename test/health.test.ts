import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";
import { authedFetch } from "./helpers";

it("GET /api/health reports ok with working D1 and R2 bindings", async () => {
  const res = await SELF.fetch("http://example.com/api/health");
  expect(res.status).toBe(200);
  const body = await res.json<{ ok: boolean; d1: boolean; r2: boolean; time: string }>();
  expect(body.ok).toBe(true);
  expect(body.d1).toBe(true);
  expect(body.r2).toBe(true);
  expect(typeof body.time).toBe("string");
});

it("unknown /api route returns 401 without a PIN session, 404 with one", async () => {
  const gated = await SELF.fetch("http://example.com/api/nope");
  expect(gated.status).toBe(401);
  const res = await authedFetch("http://example.com/api/nope");
  expect(res.status).toBe(404);
});
