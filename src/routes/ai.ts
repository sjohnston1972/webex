import { Hono } from "hono";
import type { AppContext, Env } from "../env";
import { CALL_PERMISSION_LEVELS, generateMappings, NO_LOCATION_NOTE } from "../mapping/engine";
import { WebexClient } from "../webex/client";

// Best-first model chain: gpt-oss reasons better; llama is the reliable fallback.
const MODELS = ["@cf/openai/gpt-oss-120b", "@cf/meta/llama-3.3-70b-instruct-fp8-fast"];

const SYSTEM_PROMPT = `You are the migration assistant inside "webexmigrate", a tool that migrates Cisco CUCM / Unity Connection telephony configuration to Webex Calling.
You are shown one migration item or readiness issue, including the tool's deterministic notes.

Hard facts about Webex Calling you must respect:
- Translation patterns (Call Routing): "*+" is rejected anywhere; the destination (replacement) pattern cannot contain X wildcards — it must be literal digits. Matching patterns may use digits, X, [] ranges, ! and +. CUCM "prefix digits" instructions have no direct equivalent.
- Dial plans (premises PSTN) route dial patterns to a trunk (Local Gateway) or route group. Locations on Cloud PSTN don't need outbound route patterns.
- People need an email; numbers must already exist in the location's inventory; locations must pre-exist; one person owns a number (shared lines = shared line appearances on devices).

Webex features you may recommend — know what they are and where they live in Control Hub:
- **Virtual extension**: maps an internal extension (or range) to an EXTERNAL PSTN number. Control Hub: Calling → Service Settings / per-location → Virtual Extensions.
- **Auto attendant** (IVR menus), **Hunt group / Call queue**, **Call park**, **Call pickup**: Calling → Features.
- **Locations**: Calling → Locations (each holds its number inventory and calling context).
- **Outgoing calling permissions**: per-person classes (internal / toll-free / national / international).
- **Number inventory**: Calling → Numbers.

You can APPLY simple fixes yourself in this tool. Available actions (server-enforced allowlist — nothing else exists):
- set_location_for_unset {"locationName": "<existing location>"} — assign that location to every mapping that currently has none
- set_location_all {"locationName": "<existing location>"} — set the location on ALL mappings (fallback location)
- regenerate_mappings {} — re-run mapping generation (after site mappings / prefixes change)
- select_all {"targetType": "<optional type>"} / deselect_all {"targetType": "<optional type>"} — migration scope
- set_voicemail_all {"enabled": true|false} — voicemail provisioning flag on every person
- set_call_permission_all {"level": "internal"|"toll_free"|"national"|"international"} — outgoing call class on every person

Action rules:
- Act ONLY when the user clearly asks you to fix / apply / do it. Otherwise just advise.
- Choose locationName from the "Org locations" list in your context. If the right choice is ambiguous, ask ONE short question instead of acting.
- To act, end your reply with exactly one line (nothing after it):
ACTION: {"name":"<action>","args":{...}}
- One action per reply. You cannot push, rollback or delete — those stay human-driven on the Push page.

Answering style:
- First question on an item: one-sentence diagnosis, 2-4 bullet options, one-line recommendation. Under 220 words.
- Follow-ups: answer the actual question directly and specifically, using the item's real numbers/patterns. Define any feature you name. No preamble.`;

export const ai = new Hono<AppContext>();

// The auto-executed ACTION protocol lives only in the trusted system prompt.
// Uploaded CUCM/Unity data (names, notes, descriptions) is untrusted and could
// contain a planted "ACTION: {...}" line hoping the model parrots it back as the
// final line of its reply. Neutralise the token in anything data-derived so it
// can never be reproduced as a live action directive.
function neutralizeActionTokens(s: string): string {
  return s.replace(/ACTION\s*:/gi, "ACTION​:");
}

// Whether the user's latest turn actually asks us to change something. Server-
// side gate so injected data alone (with no user request) can never trigger an
// action even if the model emits one.
function userRequestedAction(messages: { role: string; content: string }[]): boolean {
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  return /\b(apply|appli|fix|do it|go ahead|please do|make it so|set|select|deselect|regenerate|enable|disable|assign|change|update|clear)\b/i.test(lastUser);
}

ai.post("/:id/ai/chat", async (c) => {
  const projectId = c.req.param("id");
  const body = await c.req.json<{ mappingId?: string; context?: string; messages?: { role: "user" | "assistant"; content: string }[] }>();
  if (!Array.isArray(body.messages) || body.messages.length === 0) return c.json({ error: "messages required" }, 400);
  if (body.messages.length > 30) return c.json({ error: "conversation too long" }, 400);

  let context = "";
  if (body.mappingId) {
    const mapping = await c.env.DB.prepare("SELECT target_type, target_payload, confidence, status, notes FROM mappings WHERE id = ? AND project_id = ?")
      .bind(body.mappingId, projectId)
      .first<{ target_type: string; target_payload: string; confidence: string; status: string; notes: string | null }>();
    if (mapping) {
      context = `Migration item under discussion:
- Target type: ${mapping.target_type}
- Readiness: ${mapping.confidence} (${mapping.confidence === "red" ? "blocked" : mapping.confidence === "amber" ? "needs review" : "ready"})
- Mapping status: ${mapping.status}
- Payload: ${mapping.target_payload}
- Tool notes:
${mapping.notes ?? "(none)"}`;
    }
  }
  if (!context && body.context) context = `Topic under discussion (project readiness issue):\n${String(body.context).slice(0, 3000)}`;
  // Defuse any planted action directive in the data-derived context.
  context = neutralizeActionTokens(context);

  // Live project facts so actions can be chosen sensibly.
  const stats = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM mappings WHERE project_id = ?1 AND json_extract(target_payload,'$.locationName') IS NULL
          AND target_type IN ('person','workspace','hunt_group','call_pickup','call_park','auto_attendant')) AS unset_locations,
       (SELECT COUNT(*) FROM mappings WHERE project_id = ?1 AND selected = 1) AS selected_count,
       (SELECT COUNT(*) FROM mappings WHERE project_id = ?1) AS total_mappings`,
  )
    .bind(projectId)
    .first<{ unset_locations: number; selected_count: number; total_mappings: number }>();
  let locationNames: string[] = [];
  try {
    const client = await WebexClient.forProject(c.env, projectId);
    locationNames = (await client.listLocations()).map((l: any) => String(l.name));
  } catch {
    /* webex not connected — actions needing locations will be refused */
  }
  const facts = `Project facts:
- Org locations: ${locationNames.length ? locationNames.join(", ") : "(Webex not connected)"}
- Mappings: ${stats?.total_mappings ?? 0} total, ${stats?.selected_count ?? 0} selected, ${stats?.unset_locations ?? 0} without a location

${neutralizeActionTokens(await buildMappingDigest(c.env, projectId))}`;

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...(context ? [{ role: "system", content: context }] : []),
    { role: "system", content: facts },
    ...body.messages.map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000) })),
  ];

  let lastError = "";
  for (const model of MODELS) {
    const inputs: Record<string, unknown>[] = model.includes("gpt-oss")
      ? [
          {
            instructions: messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n"),
            input: messages.filter((m) => m.role !== "system").map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n"),
          },
          { messages, max_tokens: 900 },
        ]
      : [{ messages, max_tokens: 900 }];
    for (const input of inputs) {
      try {
        const result = (await c.env.AI.run(model as any, input as any)) as unknown as Record<string, unknown>;
        let reply = extractReply(result);
        if (!reply) {
          lastError = `model ${model} returned an empty/unrecognised response`;
          continue;
        }
        // Did the model ask to apply a fix? Only honour it when the user's own
        // latest message asked us to act — a data-injected ACTION line with no
        // user request is ignored (its directive is stripped from the reply).
        const actionResult = userRequestedAction(body.messages)
          ? await maybeExecuteAction(c.env, projectId, reply, locationNames)
          : stripActionLine(reply);
        if (actionResult) {
          reply = actionResult.summary ? `${actionResult.cleanedReply}\n\n${actionResult.summary}` : actionResult.cleanedReply;
          return c.json({ reply, model, actionApplied: actionResult.ok });
        }
        return c.json({ reply, model });
      } catch (e) {
        lastError = `${model}: ${e instanceof Error ? e.message : e}`;
      }
    }
  }
  return c.json({ error: `AI request failed: ${lastError}` }, 502);
});

/** Compact roster of problem items so the model can answer "which one is blocked?". */
async function buildMappingDigest(env: Env, projectId: string): Promise<string> {
  const rows = (
    await env.DB.prepare(
      `SELECT target_type, target_payload, confidence, notes FROM mappings
       WHERE project_id = ? AND confidence IN ('red','amber')
       ORDER BY CASE confidence WHEN 'red' THEN 0 ELSE 1 END
       LIMIT 60`,
    )
      .bind(projectId)
      .all<{ target_type: string; target_payload: string; confidence: string; notes: string | null }>()
  ).results;
  if (rows.length === 0) return "No blocked or review-state mappings.";

  const identity = (type: string, p: any): string => {
    if (type === "person") return p.email ?? p.displayName ?? "(unnamed person)";
    return p.name ?? p.matchingPattern ?? p.cucmPattern ?? "(unnamed)";
  };
  const line = (r: (typeof rows)[number]): string => {
    const p = JSON.parse(r.target_payload);
    const num = p.phoneNumber ?? p.extension ?? p.dialPattern ?? "";
    const note = (r.notes ?? "").split("\n")[0]?.slice(0, 160) ?? "";
    return `- [${r.target_type}] ${identity(r.target_type, p)}${num ? ` (${num})` : ""} — ${note || "no notes"}`;
  };
  const red = rows.filter((r) => r.confidence === "red");
  const amber = rows.filter((r) => r.confidence === "amber").slice(0, 25);
  const parts: string[] = [];
  if (red.length) parts.push(`Blocked items (${red.length}):\n${red.map(line).join("\n")}`);
  if (amber.length) parts.push(`Review-state items (showing ${amber.length}):\n${amber.map(line).join("\n")}`);
  return parts.join("\n\n");
}

/** Strip a trailing ACTION line without executing it (user didn't ask to act). */
function stripActionLine(reply: string): { cleanedReply: string; summary: string; ok: boolean } | null {
  const match = reply.match(/ACTION:\s*(\{[\s\S]*\})\s*$/);
  if (!match) return null;
  return { cleanedReply: reply.slice(0, match.index).trim(), summary: "", ok: false };
}

/** Parse a trailing ACTION line, validate against the allowlist, execute, summarise. */
async function maybeExecuteAction(
  env: Env,
  projectId: string,
  reply: string,
  locationNames: string[],
): Promise<{ cleanedReply: string; summary: string; ok: boolean } | null> {
  const match = reply.match(/ACTION:\s*(\{[\s\S]*\})\s*$/);
  if (!match) return null;
  const cleanedReply = reply.slice(0, match.index).trim();
  let action: { name?: string; args?: Record<string, unknown> };
  try {
    action = JSON.parse(match[1]);
  } catch {
    return { cleanedReply, summary: "⚠ I proposed a fix but its format was invalid — nothing was changed.", ok: false };
  }
  const args = action.args ?? {};

  const requireLocation = (): string | null => {
    const name = String(args.locationName ?? "").trim();
    if (!name) return null;
    if (locationNames.length > 0 && !locationNames.some((l) => l.toLowerCase() === name.toLowerCase())) return null;
    return locationNames.find((l) => l.toLowerCase() === name.toLowerCase()) ?? name;
  };

  try {
    switch (action.name) {
      case "set_location_for_unset": {
        const loc = requireLocation();
        if (!loc) return { cleanedReply, summary: `⚠ "${args.locationName}" is not an existing Webex location — nothing was changed.`, ok: false };
        const rows = (
          await env.DB.prepare(
            `SELECT id, target_payload, notes FROM mappings WHERE project_id = ?
             AND json_extract(target_payload,'$.locationName') IS NULL
             AND target_type IN ('person','workspace','hunt_group','call_pickup','call_park','auto_attendant')`,
          )
            .bind(projectId)
            .all<{ id: string; target_payload: string; notes: string | null }>()
        ).results;
        for (const row of rows) {
          const payload = JSON.parse(row.target_payload);
          payload.locationName = loc;
          const notes = (row.notes ?? "").split("\n").filter((n) => n && n !== NO_LOCATION_NOTE).join("\n");
          await env.DB.prepare("UPDATE mappings SET target_payload = ?, notes = ? WHERE id = ?")
            .bind(JSON.stringify(payload), notes || null, row.id)
            .run();
        }
        return { cleanedReply, summary: `✅ Applied: set location "${loc}" on ${rows.length} item(s) that had none.`, ok: true };
      }
      case "set_location_all": {
        const loc = requireLocation();
        if (!loc) return { cleanedReply, summary: `⚠ "${args.locationName}" is not an existing Webex location — nothing was changed.`, ok: false };
        const rows = (
          await env.DB.prepare("SELECT id, target_payload, notes FROM mappings WHERE project_id = ?")
            .bind(projectId)
            .all<{ id: string; target_payload: string; notes: string | null }>()
        ).results;
        for (const row of rows) {
          const payload = JSON.parse(row.target_payload);
          payload.locationName = loc;
          const notes = (row.notes ?? "").split("\n").filter((n) => n && n !== NO_LOCATION_NOTE).join("\n");
          await env.DB.prepare("UPDATE mappings SET target_payload = ?, notes = ? WHERE id = ?")
            .bind(JSON.stringify(payload), notes || null, row.id)
            .run();
        }
        return { cleanedReply, summary: `✅ Applied: set location "${loc}" on all ${rows.length} mappings.`, ok: true };
      }
      case "regenerate_mappings": {
        const r = await generateMappings(env, projectId);
        return { cleanedReply, summary: `✅ Applied: regenerated ${r.generated} mappings (edits and overrides preserved).`, ok: true };
      }
      case "select_all":
      case "deselect_all": {
        const sel = action.name === "select_all" ? 1 : 0;
        const targetType = args.targetType ? String(args.targetType) : null;
        const result = targetType
          ? await env.DB.prepare("UPDATE mappings SET selected = ? WHERE project_id = ? AND target_type = ?").bind(sel, projectId, targetType).run()
          : await env.DB.prepare("UPDATE mappings SET selected = ? WHERE project_id = ?").bind(sel, projectId).run();
        return { cleanedReply, summary: `✅ Applied: ${sel ? "selected" : "deselected"} ${result.meta.changes} mapping(s)${targetType ? ` of type ${targetType}` : ""}.`, ok: true };
      }
      case "set_voicemail_all": {
        const enabled = args.enabled === true;
        const r = await env.DB.prepare(
          "UPDATE mappings SET vm_override = ?, target_payload = json_set(target_payload, '$.voicemail', json(?)) WHERE project_id = ? AND target_type = 'person'",
        )
          .bind(enabled ? 1 : 0, enabled ? "true" : "false", projectId)
          .run();
        return { cleanedReply, summary: `✅ Applied: voicemail ${enabled ? "enabled" : "disabled"} for ${r.meta.changes} people.`, ok: true };
      }
      case "set_call_permission_all": {
        const level = String(args.level ?? "");
        if (!CALL_PERMISSION_LEVELS.includes(level as never)) {
          return { cleanedReply, summary: `⚠ "${level}" is not a valid call permission class — nothing was changed.`, ok: false };
        }
        const r = await env.DB.prepare(
          "UPDATE mappings SET call_permission = ?, target_payload = json_set(target_payload, '$.callPermission', ?) WHERE project_id = ? AND target_type = 'person'",
        )
          .bind(level, level, projectId)
          .run();
        return { cleanedReply, summary: `✅ Applied: call permission class "${level}" set on ${r.meta.changes} people.`, ok: true };
      }
      default:
        return { cleanedReply, summary: `⚠ "${action.name}" is not an available action — nothing was changed.`, ok: false };
    }
  } catch (e) {
    return { cleanedReply, summary: `⚠ The fix failed: ${e instanceof Error ? e.message : e}`, ok: false };
  }
}

/** Workers AI models differ in response shape — normalise to text. */
function extractReply(result: Record<string, unknown>): string | null {
  if (typeof result.response === "string" && result.response.trim()) return result.response.trim();
  if (typeof result.output_text === "string" && result.output_text.trim()) return result.output_text.trim();
  const output = result.output;
  if (Array.isArray(output)) {
    const texts: string[] = [];
    for (const item of output) {
      const content = (item as any)?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (typeof c?.text === "string" && (c.type === "output_text" || c.type === "text")) texts.push(c.text);
        }
      }
    }
    if (texts.length) return texts.join("\n").trim();
  }
  return null;
}
