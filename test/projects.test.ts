import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

async function createProject(name: string): Promise<any> {
  const res = await SELF.fetch("http://x/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, customer: "Test Co" }),
  });
  expect(res.status).toBe(201);
  return res.json();
}

describe("projects API", () => {
  it("creates, lists, summarises and deletes a project", async () => {
    const project = await createProject("Test Migration");
    expect(project.name).toBe("Test Migration");

    const list = (await (await SELF.fetch("http://x/api/projects")).json()) as any[];
    expect(list.some((p) => p.id === project.id)).toBe(true);

    const summary = (await (await SELF.fetch(`http://x/api/projects/${project.id}/summary`)).json()) as any;
    expect(summary.project.id).toBe(project.id);
    expect(summary.counts.users).toBe(0);
    expect(summary.webex).toBeNull();

    const del = await SELF.fetch(`http://x/api/projects/${project.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const after = await SELF.fetch(`http://x/api/projects/${project.id}`);
    expect(after.status).toBe(404);
  });

  it("rejects creation without a name", async () => {
    const res = await SELF.fetch("http://x/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("crypto roundtrip via AXL config", () => {
  it("stores an AXL connection and reports it in the summary", async () => {
    const project = await createProject("AXL Test");
    const save = await SELF.fetch(`http://x/api/projects/${project.id}/axl`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: "https://cucm.example.com", username: "axluser", password: "secret" }),
    });
    expect(save.status).toBe(200);
    const summary = (await (await SELF.fetch(`http://x/api/projects/${project.id}/summary`)).json()) as any;
    expect(summary.axl.base_url).toBe("https://cucm.example.com");
    expect(summary.axl.username).toBe("axluser");
    expect(JSON.stringify(summary.axl)).not.toContain("secret");
  });
});
