import { Hono } from "hono";
import type { AppContext } from "../env";
import { CALL_PERMISSION_LEVELS, generateMappings, NO_LOCATION_NOTE, recheckMapping } from "../mapping/engine";

export const mappings = new Hono<AppContext>();

mappings.post("/:id/mappings/generate", async (c) => {
  const result = await generateMappings(c.env, c.req.param("id"));
  return c.json(result);
});

mappings.get("/:id/mappings", async (c) => {
  const type = c.req.query("type");
  const query = type
    ? c.env.DB.prepare("SELECT * FROM mappings WHERE project_id = ? AND target_type = ? ORDER BY src_type").bind(c.req.param("id"), type)
    : c.env.DB.prepare("SELECT * FROM mappings WHERE project_id = ? ORDER BY src_type").bind(c.req.param("id"));
  const { results } = await query.all();
  return c.json(results);
});

// Edit one mapping: selection, payload (merged), voicemail override, or any combination.
mappings.patch("/:id/mappings/:mappingId", async (c) => {
  const body = await c.req.json<{ selected?: boolean; payload?: Record<string, unknown>; voicemailOverride?: boolean; callPermission?: string }>();
  const row = await c.env.DB.prepare("SELECT * FROM mappings WHERE id = ? AND project_id = ?")
    .bind(c.req.param("mappingId"), c.req.param("id"))
    .first<{ target_payload: string; target_type: string }>();
  if (!row) return c.json({ error: "not found" }, 404);

  if (body.payload !== undefined) {
    const merged = { ...JSON.parse(row.target_payload), ...body.payload };
    // Re-run the deterministic checks so a real fix clears the block.
    const recheck = recheckMapping(row.target_type, merged);
    await c.env.DB.prepare("UPDATE mappings SET target_payload = ?, status = 'edited', confidence = ?, notes = ? WHERE id = ?")
      .bind(JSON.stringify(merged), recheck.confidence, recheck.notes.join("\n") || null, c.req.param("mappingId"))
      .run();
  }
  if (body.selected !== undefined) {
    await c.env.DB.prepare("UPDATE mappings SET selected = ? WHERE id = ?")
      .bind(body.selected ? 1 : 0, c.req.param("mappingId"))
      .run();
  }
  // Call-permission class is a provisioning choice (persists across regeneration).
  if (body.callPermission !== undefined) {
    if (!CALL_PERMISSION_LEVELS.includes(body.callPermission as never)) {
      return c.json({ error: `callPermission must be one of: ${CALL_PERMISSION_LEVELS.join(", ")}` }, 400);
    }
    await c.env.DB.prepare(
      "UPDATE mappings SET call_permission = ?, target_payload = json_set(target_payload, '$.callPermission', ?) WHERE id = ?",
    )
      .bind(body.callPermission, body.callPermission, c.req.param("mappingId"))
      .run();
  }
  // Voicemail toggle is a provisioning choice, not an "edit": no status change,
  // and the override survives mapping regeneration.
  if (body.voicemailOverride !== undefined) {
    await c.env.DB.prepare(
      "UPDATE mappings SET vm_override = ?, target_payload = json_set(target_payload, '$.voicemail', json(?)) WHERE id = ?",
    )
      .bind(body.voicemailOverride ? 1 : 0, body.voicemailOverride ? "true" : "false", c.req.param("mappingId"))
      .run();
  }
  const updated = await c.env.DB.prepare("SELECT * FROM mappings WHERE id = ?").bind(c.req.param("mappingId")).first();
  return c.json(updated);
});

// CUCM sites (device pools / locations seen on phones) and their Webex location mapping.
mappings.get("/:id/site-mappings", async (c) => {
  const projectId = c.req.param("id");
  const sites = (
    await c.env.DB.prepare(
      `SELECT COALESCE(device_pool, location_name) AS site, COUNT(*) AS phones
       FROM src_phones WHERE project_id = ? AND COALESCE(device_pool, location_name) IS NOT NULL
       GROUP BY site ORDER BY phones DESC`,
    )
      .bind(projectId)
      .all<{ site: string; phones: number }>()
  ).results;
  const saved = new Map(
    (
      await c.env.DB.prepare("SELECT cucm_site, webex_location, e164_prefix FROM site_mappings WHERE project_id = ?")
        .bind(projectId)
        .all<{ cucm_site: string; webex_location: string | null; e164_prefix: string | null }>()
    ).results.map((r) => [r.cucm_site, r]),
  );
  return c.json(
    sites.map((s) => ({
      cucmSite: s.site,
      phones: s.phones,
      webexLocation: saved.get(s.site)?.webex_location ?? null,
      e164Prefix: saved.get(s.site)?.e164_prefix ?? null,
    })),
  );
});

mappings.put("/:id/site-mappings", async (c) => {
  const projectId = c.req.param("id");
  const body = await c.req.json<{ mappings?: { cucmSite: string; webexLocation: string | null; e164Prefix?: string | null }[] }>();
  if (!Array.isArray(body.mappings)) return c.json({ error: "mappings array required" }, 400);
  for (const m of body.mappings) {
    if (!m.cucmSite) continue;
    const prefix = m.e164Prefix?.trim() || null;
    if (prefix && !/^\+\d{1,12}$/.test(prefix.replace(/[\s().-]/g, ""))) {
      return c.json({ error: `E.164 prefix "${prefix}" must be + followed by digits (e.g. +44207555)` }, 400);
    }
    await c.env.DB.prepare(
      `INSERT INTO site_mappings (project_id, cucm_site, webex_location, e164_prefix) VALUES (?, ?, ?, ?)
       ON CONFLICT(project_id, cucm_site) DO UPDATE SET webex_location = excluded.webex_location, e164_prefix = excluded.e164_prefix`,
    )
      .bind(projectId, m.cucmSite, m.webexLocation ?? null, prefix)
      .run();
  }
  return c.json({ saved: body.mappings.length });
});

// Bulk operations: select/deselect all (optionally by type), set location on all selected.
mappings.post("/:id/mappings/bulk", async (c) => {
  const projectId = c.req.param("id");
  const body = await c.req.json<{
    action: "select" | "deselect" | "setLocation" | "setRouteChoice" | "setVoicemail" | "setCallPermission";
    targetType?: string;
    locationName?: string;
    routeChoice?: { type: string; id: string; name: string };
    voicemailEnabled?: boolean;
    callPermission?: string;
  }>();

  if (body.action === "setCallPermission") {
    if (!CALL_PERMISSION_LEVELS.includes((body.callPermission ?? "") as never)) {
      return c.json({ error: `callPermission must be one of: ${CALL_PERMISSION_LEVELS.join(", ")}` }, 400);
    }
    await c.env.DB.prepare(
      `UPDATE mappings SET call_permission = ?, target_payload = json_set(target_payload, '$.callPermission', ?)
       WHERE project_id = ? AND target_type = 'person'`,
    )
      .bind(body.callPermission, body.callPermission, projectId)
      .run();
    return c.json({ ok: true });
  }

  if (body.action === "setVoicemail") {
    const enabled = body.voicemailEnabled === true;
    await c.env.DB.prepare(
      `UPDATE mappings SET vm_override = ?, target_payload = json_set(target_payload, '$.voicemail', json(?))
       WHERE project_id = ? AND target_type = 'person'`,
    )
      .bind(enabled ? 1 : 0, enabled ? "true" : "false", projectId)
      .run();
    return c.json({ ok: true });
  }

  if (body.action === "setRouteChoice") {
    if (!body.routeChoice?.id || !body.routeChoice?.type) return c.json({ error: "routeChoice {type,id,name} required" }, 400);
    const { results } = await c.env.DB.prepare(
      "SELECT id, target_payload FROM mappings WHERE project_id = ? AND target_type = 'route_pattern'",
    )
      .bind(projectId)
      .all<{ id: string; target_payload: string }>();
    for (const row of results) {
      const payload = JSON.parse(row.target_payload);
      payload.routeChoice = body.routeChoice;
      await c.env.DB.prepare("UPDATE mappings SET target_payload = ? WHERE id = ?").bind(JSON.stringify(payload), row.id).run();
    }
    return c.json({ ok: true, updated: results.length });
  }

  if (body.action === "select" || body.action === "deselect") {
    const sel = body.action === "select" ? 1 : 0;
    if (body.targetType) {
      await c.env.DB.prepare("UPDATE mappings SET selected = ? WHERE project_id = ? AND target_type = ?")
        .bind(sel, projectId, body.targetType)
        .run();
    } else {
      await c.env.DB.prepare("UPDATE mappings SET selected = ? WHERE project_id = ?").bind(sel, projectId).run();
    }
    return c.json({ ok: true });
  }

  if (body.action === "setLocation") {
    if (!body.locationName) return c.json({ error: "locationName required" }, 400);
    const { results } = await c.env.DB.prepare("SELECT id, target_payload, notes FROM mappings WHERE project_id = ?")
      .bind(projectId)
      .all<{ id: string; target_payload: string; notes: string | null }>();
    for (const row of results) {
      const payload = JSON.parse(row.target_payload);
      payload.locationName = body.locationName;
      // The "no location" note is resolved by this action — drop it.
      const notes = (row.notes ?? "")
        .split("\n")
        .filter((n) => n && n !== NO_LOCATION_NOTE)
        .join("\n");
      await c.env.DB.prepare("UPDATE mappings SET target_payload = ?, notes = ? WHERE id = ?")
        .bind(JSON.stringify(payload), notes || null, row.id)
        .run();
    }
    return c.json({ ok: true, updated: results.length });
  }
  return c.json({ error: "unknown action" }, 400);
});
