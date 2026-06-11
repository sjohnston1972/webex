import { Hono } from "hono";
import type { AppContext } from "../env";
import { uuid } from "../lib/util";
import { listUnattachedDns } from "../mapping/engine";
import { pickCallingLicense, WebexClient } from "../webex/client";

const SRC_TABLES = [
  "src_users",
  "src_phones",
  "src_lines",
  "src_hunt_pilots",
  "src_hunt_members",
  "src_pickup_groups",
  "src_vm_boxes",
  "src_trans_patterns",
  "src_dialplan",
  "src_vm_greetings",
  "src_call_handlers",
];

export const projects = new Hono<AppContext>();

projects.get("/", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT p.*,
       (SELECT COUNT(*) FROM src_users u WHERE u.project_id = p.id) AS user_count,
       (SELECT COUNT(*) FROM axl_connections a WHERE a.project_id = p.id AND a.verified_at IS NOT NULL) AS cucm_linked,
       (SELECT COUNT(*) FROM unity_connections un WHERE un.project_id = p.id AND un.verified_at IS NOT NULL) AS unity_linked,
       (SELECT COUNT(*) FROM webex_tokens t WHERE t.project_id = p.id) AS webex_connected
     FROM projects p ORDER BY p.created_at DESC`,
  ).all();
  return c.json(results);
});

projects.post("/", async (c) => {
  const body = await c.req.json<{ name?: string; customer?: string }>();
  const name = body.name?.trim();
  if (!name) return c.json({ error: "name is required" }, 400);
  const id = uuid();
  await c.env.DB.prepare("INSERT INTO projects (id, name, customer) VALUES (?, ?, ?)")
    .bind(id, name, body.customer?.trim() || null)
    .run();
  const row = await c.env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first();
  return c.json(row, 201);
});

projects.get("/:id", async (c) => {
  const row = await c.env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(c.req.param("id")).first();
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json(row);
});

projects.get("/:id/summary", async (c) => {
  const id = c.req.param("id");
  const project = await c.env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first();
  if (!project) return c.json({ error: "not found" }, 404);

  const counts: Record<string, number> = {};
  for (const table of SRC_TABLES) {
    const r = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`).bind(id).first<{ n: number }>();
    counts[table.replace("src_", "")] = r?.n ?? 0;
  }
  const mappings = await c.env.DB.prepare(
    `SELECT confidence, COUNT(*) AS n, SUM(selected) AS selected FROM mappings WHERE project_id = ? GROUP BY confidence`,
  )
    .bind(id)
    .all<{ confidence: string; n: number; selected: number }>();
  const mappingsByType = await c.env.DB.prepare(
    `SELECT target_type, COUNT(*) AS n, SUM(selected) AS selected FROM mappings WHERE project_id = ? GROUP BY target_type`,
  )
    .bind(id)
    .all<{ target_type: string; n: number; selected: number }>();
  const batches = await c.env.DB.prepare(
    `SELECT id, name, status, created_at FROM batches WHERE project_id = ? ORDER BY created_at DESC`,
  )
    .bind(id)
    .all();
  const snapshots = await c.env.DB.prepare(
    `SELECT id, type, source, status, counts_json, error_text, created_at, parsed_at FROM source_snapshots WHERE project_id = ? ORDER BY created_at DESC`,
  )
    .bind(id)
    .all();
  const axl = await c.env.DB.prepare(
    `SELECT base_url, username, cucm_version, verified_at FROM axl_connections WHERE project_id = ?`,
  )
    .bind(id)
    .first();
  const unity = await c.env.DB.prepare(
    `SELECT base_url, username, unity_version, verified_at FROM unity_connections WHERE project_id = ?`,
  )
    .bind(id)
    .first();
  const webex = await c.env.DB.prepare(
    `SELECT org_id, org_name, scopes, expires_at, updated_at FROM webex_tokens WHERE project_id = ?`,
  )
    .bind(id)
    .first();

  return c.json({
    project,
    counts,
    mappings: mappings.results,
    mappingsByType: mappingsByType.results,
    unattachedDns: (await listUnattachedDns(c.env, id)).length,
    batches: batches.results,
    snapshots: snapshots.results,
    axl: axl ?? null,
    unity: unity ?? null,
    webex: webex ?? null,
  });
});

// Proactive readiness issues: capacity shortfalls, missing prerequisites,
// blocked items — surfaced on the dashboard before anyone dry-runs.
projects.get("/:id/issues", async (c) => {
  const id = c.req.param("id");
  type Issue = { severity: "red" | "amber" | "info"; title: string; detail: string };
  const issues: Issue[] = [];

  const mappings = (
    await c.env.DB.prepare("SELECT target_type, target_payload, confidence, selected FROM mappings WHERE project_id = ?")
      .bind(id)
      .all<{ target_type: string; target_payload: string; confidence: string; selected: number }>()
  ).results;
  const parsed = mappings.map((m) => ({ ...m, p: JSON.parse(m.target_payload) }));

  // Demand: selected items if anything is selected, otherwise everything eligible.
  const anySelected = parsed.some((m) => m.selected === 1);
  const scope = anySelected ? parsed.filter((m) => m.selected === 1) : parsed;
  const scopeWord = anySelected ? "selected" : "eligible (nothing selected yet)";

  const callingDemand = scope.filter((m) => m.target_type === "person" && (m.p.extension || m.p.phoneNumber)).length;
  const workspaceDemand = scope.filter((m) => m.target_type === "workspace").length;

  // Licence supply — needs a connected Webex org.
  const tokens = await c.env.DB.prepare("SELECT project_id FROM webex_tokens WHERE project_id = ?").bind(id).first();
  if (!tokens) {
    if (mappings.length > 0) issues.push({ severity: "amber", title: "Webex not connected", detail: "Connect the target org to check licence capacity, locations and numbers." });
  } else {
    try {
      const client = await WebexClient.forProject(c.env, id);
      const licenses = await client.listLicenses();
      const calling = licenses.find((l: any) => /webex calling.*professional/i.test(l.name)) ?? pickCallingLicense(licenses);
      if (calling && calling.totalUnits !== undefined) {
        const free = calling.totalUnits - calling.consumedUnits;
        if (callingDemand > free) {
          issues.push({
            severity: "red",
            title: "Calling licence shortfall",
            detail: `${callingDemand} ${scopeWord} people need Webex Calling, but only ${free} of ${calling.totalUnits} "${calling.name}" seats are free. Reduce scope or add licences before pushing.`,
          });
        }
        // Structural capacity outlook: total source users vs total org seats,
        // regardless of what's currently selected.
        const totalPersons = parsed.filter((m) => m.target_type === "person").length;
        if (totalPersons > calling.totalUnits) {
          issues.push({
            severity: callingDemand > free ? "red" : "amber",
            title: "Capacity outlook: more CUCM users than org seats",
            detail: `CUCM has ${totalPersons} end users mapped, but the Webex org has only ${calling.totalUnits} "${calling.name}" seats in total (${free} currently free). At most ${calling.totalUnits} people can be migrated with calling — plan additional licences or phase the migration.`,
          });
        }
      }
      const ws = licenses.find((l: any) => /webex calling.*workspaces/i.test(l.name));
      if (ws && ws.totalUnits !== undefined && workspaceDemand > ws.totalUnits - ws.consumedUnits) {
        issues.push({
          severity: "red",
          title: "Workspace licence shortfall",
          detail: `${workspaceDemand} ${scopeWord} workspaces vs ${ws.totalUnits - ws.consumedUnits} free "${ws.name}" seats.`,
        });
      }
    } catch (e) {
      issues.push({ severity: "amber", title: "Licence check unavailable", detail: e instanceof Error ? e.message : String(e) });
    }
  }

  // Missing prerequisites on selected items.
  const LOCATION_TYPES = ["person", "workspace", "hunt_group", "call_pickup", "call_park", "auto_attendant"];
  const noLocation = scope.filter((m) => LOCATION_TYPES.includes(m.target_type) && !m.p.locationName).length;
  if (noLocation > 0) {
    issues.push({ severity: "red", title: "Missing Webex location", detail: `${noLocation} ${scopeWord} item(s) have no location — map CUCM sites or apply a fallback location on Review & select.` });
  }
  const noRoute = scope.filter((m) => m.target_type === "route_pattern" && !m.p.routeChoice).length;
  if (noRoute > 0) {
    issues.push({ severity: "amber", title: "Route patterns without a route target", detail: `${noRoute} ${scopeWord} route pattern(s) need a trunk or route group ("Route via" on Review & select).` });
  }

  // Blocked items, by type.
  const blocked = mappings.filter((m) => m.confidence === "red");
  if (blocked.length > 0) {
    const byType = new Map<string, number>();
    for (const b of blocked) byType.set(b.target_type, (byType.get(b.target_type) ?? 0) + 1);
    issues.push({
      severity: "amber",
      title: `${blocked.length} blocked mapping(s)`,
      detail: [...byType.entries()].map(([t, n]) => `${n} ${t.replace(/_/g, " ")}`).join(", ") + " — fix via Edit on Review & select, or leave excluded.",
    });
  }

  const unattached = (await listUnattachedDns(c.env, id)).length;
  if (unattached > 0) {
    issues.push({ severity: "info", title: `${unattached} unattached directory numbers`, detail: "DNs with no migration path (CTI ports, secondary lines) — listed in the readiness report." });
  }

  return c.json({ issues, callingDemand, workspaceDemand });
});

projects.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const project = await c.env.DB.prepare("SELECT id FROM projects WHERE id = ?").bind(id).first();
  if (!project) return c.json({ error: "not found" }, 404);

  // Purge R2 objects under the project prefix.
  let cursor: string | undefined;
  do {
    const listing = await c.env.UPLOADS.list({ prefix: `projects/${id}/`, cursor });
    if (listing.objects.length > 0) {
      await c.env.UPLOADS.delete(listing.objects.map((o) => o.key));
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);

  // Purge D1 rows explicitly (don't rely on FK cascade settings).
  const tables = [
    ...SRC_TABLES,
    "mappings",
    "batch_items",
    "batches",
    "source_snapshots",
    "axl_connections",
    "unity_connections",
    "webex_tokens",
    "site_mappings",
  ];
  for (const table of tables) {
    if (table === "batch_items") {
      await c.env.DB.prepare(
        "DELETE FROM batch_items WHERE batch_id IN (SELECT id FROM batches WHERE project_id = ?)",
      )
        .bind(id)
        .run();
    } else {
      await c.env.DB.prepare(`DELETE FROM ${table} WHERE project_id = ?`).bind(id).run();
    }
  }
  await c.env.DB.prepare(
    "DELETE FROM push_jobs WHERE batch_id NOT IN (SELECT id FROM batches)",
  ).run();
  await c.env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(id).run();
  return c.json({ deleted: true });
});
