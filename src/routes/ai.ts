import { Hono } from "hono";
import type { AppContext } from "../env";

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const SYSTEM_PROMPT = `You are the migration assistant inside "webexmigrate", a tool that migrates Cisco CUCM / Unity Connection telephony configuration to Webex Calling.
You are shown one migration item (a mapping from a CUCM object to a Webex object) including its readiness state and the tool's deterministic notes.
Your job: explain clearly why the item is flagged or blocked, and give a UC engineer practical, specific remediation options in Webex Calling terms.

Hard facts about Webex Calling you must respect:
- Translation patterns: "*+" is rejected anywhere; the destination (replacement) pattern cannot contain X wildcards — it must be literal digits (E.164 or extension). Matching patterns may use digits, X, [] ranges, ! and +.
- Dial plans (premises PSTN) route patterns to a trunk (Local Gateway) or route group; patterns use digits, X, [], !, *, #, + — there is no CUCM-style "pre-dot" digit stripping.
- Alternatives worth suggesting where relevant: assigning a DID directly to the person/workspace (replaces simple DID-alias translation patterns), virtual extensions (map an extension to an external PSTN number), auto attendants (replaces simple IVR/call-handler patterns), hunt groups, call queues, and Cloud PSTN (which removes the need for outbound route patterns entirely).
- People need an email; numbers must exist in the location's number inventory; locations must pre-exist.

Be concise: a short diagnosis sentence, then 2-4 bullet-point options, then a one-line recommendation. Under 250 words. No preamble.`;

export const ai = new Hono<AppContext>();

ai.post("/:id/ai/chat", async (c) => {
  const body = await c.req.json<{ mappingId?: string; messages?: { role: "user" | "assistant"; content: string }[] }>();
  if (!Array.isArray(body.messages) || body.messages.length === 0) return c.json({ error: "messages required" }, 400);
  if (body.messages.length > 30) return c.json({ error: "conversation too long" }, 400);

  let context = "";
  if (body.mappingId) {
    const mapping = await c.env.DB.prepare("SELECT target_type, target_payload, confidence, status, notes FROM mappings WHERE id = ? AND project_id = ?")
      .bind(body.mappingId, c.req.param("id"))
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

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...(context ? [{ role: "system", content: context }] : []),
    ...body.messages.map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000) })),
  ];

  try {
    const result = (await c.env.AI.run(MODEL as any, { messages, max_tokens: 800 })) as { response?: string };
    return c.json({ reply: result.response ?? "(no response)" });
  } catch (e) {
    return c.json({ error: `AI request failed: ${e instanceof Error ? e.message : e}` }, 502);
  }
});
