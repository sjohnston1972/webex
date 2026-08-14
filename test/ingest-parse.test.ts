import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { authedFetch } from "./helpers";

// Parse is a button an operator can double-click, retry after a slow response,
// or re-run after a partial failure. Appending on every run doubles every src_*
// row, doubles the dashboard counts, and mints fresh src_ids that the mapping
// engine then turns into duplicate people/hunt groups.

const USERS_CSV = [
  "USER ID,FIRST NAME,LAST NAME,MAIL ID,DEPARTMENT,PRIMARY EXTENSION",
  "jdoe,John,Doe,jdoe@example.com,Sales,1001",
  "asmith,Ann,Smith,asmith@example.com,Support,1002",
  "bwong,Bo,Wong,bwong@example.com,Support,1003",
].join("\n");

async function createProject(name: string): Promise<string> {
  const res = await authedFetch("http://x/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, customer: "Test Co" }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function uploadUsers(projectId: string): Promise<string> {
  const form = new FormData();
  form.append("type", "cucm");
  form.append("file", new File([USERS_CSV], "users.csv", { type: "text/csv" }));
  const res = await authedFetch(`http://x/api/projects/${projectId}/uploads`, { method: "POST", body: form });
  expect(res.status).toBe(201);
  return ((await res.json()) as { snapshotId: string }).snapshotId;
}

function parse(projectId: string, snapshotId: string): Promise<Response> {
  return authedFetch(`http://x/api/projects/${projectId}/snapshots/${snapshotId}/parse`, { method: "POST" });
}

async function countUsers(projectId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM src_users WHERE project_id = ?")
    .bind(projectId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe("snapshot parse is idempotent", () => {
  let projectId: string;
  let snapshotId: string;

  beforeAll(async () => {
    projectId = await createProject("Parse Idempotency");
    snapshotId = await uploadUsers(projectId);
  });

  it("leaves the same rows after a second parse of the same snapshot", async () => {
    const first = await parse(projectId, snapshotId);
    expect(first.status).toBe(200);
    expect((await first.json()) as { counts: Record<string, number> }).toMatchObject({ counts: { users: 3 } });
    expect(await countUsers(projectId)).toBe(3);

    const second = await parse(projectId, snapshotId);
    expect(second.status).toBe(200);
    expect(await countUsers(projectId)).toBe(3);
  });

  it("generates exactly one mapping per source user after a re-parse", async () => {
    await parse(projectId, snapshotId);
    await parse(projectId, snapshotId);

    const gen = await authedFetch(`http://x/api/projects/${projectId}/mappings/generate`, { method: "POST" });
    expect(gen.status).toBe(200);

    // Duplicate src_ids for one human would surface as two person mappings
    // carrying the same email.
    const { results } = await env.DB.prepare(
      "SELECT target_payload FROM mappings WHERE project_id = ? AND target_type = 'person'",
    )
      .bind(projectId)
      .all<{ target_payload: string }>();
    const emails = results.map((r) => JSON.parse(r.target_payload).email);
    expect(emails).toHaveLength(3);
    expect(new Set(emails).size).toBe(3);
  });
});
