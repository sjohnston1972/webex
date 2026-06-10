import { authedFetch as SELFfetch } from "./helpers";
import { expect, it } from "vitest";

// /auth/* must reach the Worker, not be swallowed by the SPA asset fallback.
it("GET /auth/login without a project reaches the Worker (400, not SPA HTML)", async () => {
  const res = await SELFfetch("http://x/auth/login", { redirect: "manual" });
  expect(res.status).toBe(400);
  expect(res.headers.get("content-type") ?? "").not.toContain("text/html");
});

it("GET /auth/login with a project redirects to the Webex authorize URL", async () => {
  const create = await SELFfetch("http://x/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "OAuth Routing Test" }),
  });
  const project = (await create.json()) as { id: string };

  const res = await SELFfetch(`http://x/auth/login?project=${project.id}`, { redirect: "manual" });
  expect(res.status).toBe(302);
  const location = res.headers.get("location") ?? "";
  expect(location).toContain("https://webexapis.com/v1/authorize");
  expect(location).toContain("client_id=");
  expect(location).toContain(`state=${project.id}.`);
  expect(res.headers.get("set-cookie") ?? "").toContain("wx_oauth=");
});

