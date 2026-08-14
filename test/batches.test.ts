import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { authedFetch } from "./helpers";

// A batch lives inside exactly one project. Every /:id/batches/:batchId/* route
// must prove that before touching it — otherwise project A's items get validated
// against project B's Webex org, or rolled back through the wrong URL.

async function createProject(name: string): Promise<{ id: string }> {
  const res = await authedFetch("http://x/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, customer: "Test Co" }),
  });
  expect(res.status).toBe(201);
  return res.json();
}

/** Seed one selected person mapping so POST /batches has something to collect. */
async function seedMapping(projectId: string, srcId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO mappings (id, project_id, src_type, src_id, target_type, target_payload, selected)
     VALUES (?, ?, 'user', ?, 'person', ?, 1)`,
  )
    .bind(crypto.randomUUID(), projectId, srcId, JSON.stringify({ email: "a@example.com", displayName: "A" }))
    .run();
}

async function createBatch(projectId: string): Promise<string> {
  const res = await authedFetch(`http://x/api/projects/${projectId}/batches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "B1" }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

describe("batch endpoints are scoped to the project in the URL", () => {
  let owner: string;
  let stranger: string;
  let batchId: string;

  beforeAll(async () => {
    owner = (await createProject("Batch Owner")).id;
    stranger = (await createProject("Batch Stranger")).id;
    await seedMapping(owner, "scope-user-1");
    batchId = await createBatch(owner);
  });

  it("404s validate for a batch in another project", async () => {
    const res = await authedFetch(`http://x/api/projects/${stranger}/batches/${batchId}/validate`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("404s rollback for a batch in another project", async () => {
    const res = await authedFetch(`http://x/api/projects/${stranger}/batches/${batchId}/rollback`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("404s the dry-run CSV for a batch in another project", async () => {
    const res = await authedFetch(`http://x/api/projects/${stranger}/batches/${batchId}/dryrun.csv`);
    expect(res.status).toBe(404);
  });

  it("404s the result CSV for a batch in another project", async () => {
    const res = await authedFetch(`http://x/api/projects/${stranger}/batches/${batchId}/result.csv`);
    expect(res.status).toBe(404);
  });

  it("still serves both CSVs through the owning project", async () => {
    const dry = await authedFetch(`http://x/api/projects/${owner}/batches/${batchId}/dryrun.csv`);
    expect(dry.status).toBe(200);
    expect(await dry.text()).toContain("Object type");
    const result = await authedFetch(`http://x/api/projects/${owner}/batches/${batchId}/result.csv`);
    expect(result.status).toBe(200);
    expect(await result.text()).toContain("Push status");
  });
});

describe("rollback guards against in-flight pushes", () => {
  let projectId: string;

  beforeAll(async () => {
    projectId = (await createProject("Rollback Guard")).id;
    await seedMapping(projectId, "guard-user-1");
  });

  it("rejects rollback while the batch is still pushing and queues nothing", async () => {
    const batchId = await createBatch(projectId);
    await env.DB.prepare("UPDATE batches SET status = 'pushing' WHERE id = ?").bind(batchId).run();

    const res = await authedFetch(`http://x/api/projects/${projectId}/batches/${batchId}/rollback`, { method: "POST" });
    expect(res.status).toBe(400);

    const jobs = await env.DB.prepare("SELECT COUNT(*) AS n FROM push_jobs WHERE batch_id = ? AND action = 'rollback'")
      .bind(batchId)
      .first<{ n: number }>();
    expect(jobs?.n).toBe(0);
    // The guard must not have moved the batch out of 'pushing'.
    const batch = await env.DB.prepare("SELECT status FROM batches WHERE id = ?").bind(batchId).first<{ status: string }>();
    expect(batch?.status).toBe("pushing");
  });

  it("rejects rollback while the batch is validating", async () => {
    const batchId = await createBatch(projectId);
    await env.DB.prepare("UPDATE batches SET status = 'validating' WHERE id = ?").bind(batchId).run();
    const res = await authedFetch(`http://x/api/projects/${projectId}/batches/${batchId}/rollback`, { method: "POST" });
    expect(res.status).toBe(400);
  });

  it("supersedes outstanding push jobs when a settled batch is rolled back", async () => {
    const batchId = await createBatch(projectId);
    await env.DB.prepare("UPDATE batches SET status = 'pushed' WHERE id = ?").bind(batchId).run();
    const item = await env.DB.prepare("SELECT id FROM batch_items WHERE batch_id = ?").bind(batchId).first<{ id: string }>();
    const jobId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO push_jobs (id, batch_id, batch_item_id, action, status) VALUES (?, ?, ?, 'push', 'pending')",
    )
      .bind(jobId, batchId, item!.id)
      .run();

    const res = await authedFetch(`http://x/api/projects/${projectId}/batches/${batchId}/rollback`, { method: "POST" });
    expect(res.status).toBe(200);

    const job = await env.DB.prepare("SELECT status FROM push_jobs WHERE id = ?").bind(jobId).first<{ status: string }>();
    expect(job?.status).toBe("superseded");
  });
});
