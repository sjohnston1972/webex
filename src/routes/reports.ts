import { Hono } from "hono";
import type { AppContext } from "../env";
import { safeJsonParse, toCsv } from "../lib/util";
import { listUnattachedDns } from "../mapping/engine";

export const reports = new Hono<AppContext>();

function csvResponse(filename: string, csv: string): Response {
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

// Pre-migration readiness: every mapping with its confidence and issues.
reports.get("/:id/reports/readiness.csv", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT target_type, target_payload, confidence, selected, status, notes FROM mappings WHERE project_id = ? ORDER BY target_type, confidence",
  )
    .bind(c.req.param("id"))
    .all<{ target_type: string; target_payload: string; confidence: string; selected: number; status: string; notes: string | null }>();

  const rows = results.map((r) => {
    const p = safeJsonParse(r.target_payload, {} as any);
    const label = r.target_type === "person" ? (p.email ?? p.displayName) : p.name;
    return [r.target_type, label, p.extension ?? p.phoneNumber ?? "", p.locationName ?? "", r.confidence, r.selected ? "yes" : "no", r.status, r.notes ?? ""];
  });
  // Nothing silently dropped: DNs with no migration path get their own rows.
  for (const dn of await listUnattachedDns(c.env, c.req.param("id"))) {
    const why = dn.model === "CTI Port"
      ? `On CTI Port ${dn.device}${dn.owner ? ` (owner ${dn.owner})` : ""} — application endpoint (contact centre/recording); re-architect, not migrate`
      : dn.device
        ? `Secondary/shared line on ${dn.device}${dn.model ? ` (${dn.model})` : ""}${dn.owner ? `, owner ${dn.owner}` : ""} — not migrated automatically`
        : "Not associated with any device — likely test/utility pattern";
    rows.push(["directory_number (unattached)", dn.pattern, dn.pattern, "", "red", "no", "none", why]);
  }
  return csvResponse(
    "readiness-report.csv",
    toCsv(["Object type", "Identity", "Number/Extension", "Webex location", "Readiness", "Selected", "Mapping status", "Issues"], rows),
  );
});

// Full dial plan (CUCM Route Plan Report + supporting infrastructure).
reports.get("/:id/reports/dialplan.csv", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT object_type, name, partition_name, description, detail FROM src_dialplan WHERE project_id = ? ORDER BY object_type, name",
  )
    .bind(c.req.param("id"))
    .all<{ object_type: string; name: string; partition_name: string | null; description: string | null; detail: string | null }>();
  const rows = results.map((r) => [r.object_type, r.name, r.partition_name ?? "", r.description ?? "", r.detail ?? ""]);
  return csvResponse("dial-plan-report.csv", toCsv(["Object type", "Pattern / Name", "Partition", "Description", "Detail"], rows));
});

// JSON list for the Overview "Unattached DNs" tile.
reports.get("/:id/reports/unattached-dns", async (c) => {
  return c.json(await listUnattachedDns(c.env, c.req.param("id")));
});

reports.get("/:id/batches/:batchId/dryrun.csv", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT m.target_type, m.target_payload, bi.validate_status, bi.validate_notes
     FROM batch_items bi JOIN mappings m ON m.id = bi.mapping_id WHERE bi.batch_id = ?`,
  )
    .bind(c.req.param("batchId"))
    .all<{ target_type: string; target_payload: string; validate_status: string | null; validate_notes: string | null }>();
  const rows = results.map((r) => {
    const p = safeJsonParse(r.target_payload, {} as any);
    const label = r.target_type === "person" ? (p.email ?? p.displayName) : p.name;
    return [r.target_type, label, r.validate_status ?? "not validated", r.validate_notes ?? ""];
  });
  return csvResponse("dry-run-report.csv", toCsv(["Object type", "Identity", "Result", "Notes"], rows));
});

reports.get("/:id/batches/:batchId/result.csv", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT m.target_type, m.target_payload, bi.push_status, bi.webex_resource_id, bi.error_text
     FROM batch_items bi JOIN mappings m ON m.id = bi.mapping_id WHERE bi.batch_id = ?`,
  )
    .bind(c.req.param("batchId"))
    .all<{ target_type: string; target_payload: string; push_status: string; webex_resource_id: string | null; error_text: string | null }>();
  const rows = results.map((r) => {
    const p = safeJsonParse(r.target_payload, {} as any);
    const label = r.target_type === "person" ? (p.email ?? p.displayName) : p.name;
    return [r.target_type, label, r.push_status, r.webex_resource_id ?? "", r.error_text ?? ""];
  });
  return csvResponse("post-push-report.csv", toCsv(["Object type", "Identity", "Push status", "Webex resource ID", "Errors"], rows));
});
