import { Hono } from "hono";
import type { AppContext } from "../env";

// Best-first model chain: gpt-oss reasons better; llama is the reliable fallback.
const MODELS = ["@cf/openai/gpt-oss-120b", "@cf/meta/llama-3.3-70b-instruct-fp8-fast"];

const SYSTEM_PROMPT = `You are the migration assistant inside "webexmigrate", a tool that migrates Cisco CUCM / Unity Connection telephony configuration to Webex Calling.
You are shown one migration item (a mapping from a CUCM object to a Webex object) including its readiness state and the tool's deterministic notes.

Hard facts about Webex Calling you must respect:
- Translation patterns (Call Routing): "*+" is rejected anywhere; the destination (replacement) pattern cannot contain X wildcards — it must be literal digits (E.164 or an extension). Matching patterns may use digits, X, [] ranges, ! and +. CUCM "prefix digits" instructions have no direct equivalent.
- Dial plans (premises PSTN) route dial patterns to a trunk (Local Gateway) or route group. There is no CUCM-style pre-dot digit stripping. Locations on Cloud Connected PSTN or Cisco Calling Plans don't need outbound route patterns at all.
- People need an email; numbers must already exist in the location's inventory; locations must pre-exist; one person owns a number (shared lines = shared line appearances configured on devices).

Webex features you may recommend — know what they are and where they live in Control Hub:
- **Virtual extension**: maps an internal extension (or extension range) to an EXTERNAL PSTN number, so users dial a short extension and Webex routes the call to the outside number. Ideal replacement for CUCM translation patterns that aliased an extension to an off-net destination. Control Hub: Calling → Service Settings (org-level) or per-location → Virtual Extensions; also available via API. You provide the extension, the E.164 external number, and a display name.
- **Auto attendant**: IVR menu with business/after-hours menus and key actions (transfer, mailbox, repeat). Control Hub: Calling → Features → Auto Attendant.
- **Hunt group / Call queue**: distribute calls to agents (queue adds queuing/announcements). Calling → Features.
- **Call park extension / group**, **Call pickup**: Calling → Features.
- **Outgoing calling permissions**: per-person classes (internal / toll-free / national / international). People → Calling → Outgoing call permissions.
- **Number inventory**: Calling → Numbers — numbers must be added (PSTN order or LGW range) before they can be assigned.

Answering style:
- For the FIRST question about an item: one-sentence diagnosis, then 2-4 concrete options as bullets, then a one-line recommendation. Under 220 words.
- For FOLLOW-UP questions: answer the actual question directly and specifically. If the user asks about a feature you mentioned (e.g. "virtual extension?"), define it, explain why it fits this item, and give the Control Hub steps to configure it for this item's specific numbers. Do NOT repeat the option list or the recommendation format.
- Use the item's actual numbers/patterns in your answers. No preamble, no apologies.`;

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

  let lastError = "";
  for (const model of MODELS) {
    try {
      const result = (await c.env.AI.run(model as any, { messages, max_tokens: 900 })) as Record<string, unknown>;
      const reply = extractReply(result);
      if (reply) return c.json({ reply, model });
      lastError = `model ${model} returned an empty/unrecognised response`;
    } catch (e) {
      lastError = `${model}: ${e instanceof Error ? e.message : e}`;
    }
  }
  return c.json({ error: `AI request failed: ${lastError}` }, 502);
});

/** Workers AI models differ in response shape — normalise to text. */
function extractReply(result: Record<string, unknown>): string | null {
  if (typeof result.response === "string" && result.response.trim()) return result.response.trim();
  if (typeof result.output_text === "string" && result.output_text.trim()) return result.output_text.trim();
  // gpt-oss "responses" shape: output: [{type:'message', content:[{type:'output_text', text}]}]
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
