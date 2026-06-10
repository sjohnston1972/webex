import { FormEvent, useEffect, useRef, useState } from "react";
import { api, Mapping } from "./api";
import { Modal, Spinner } from "./components";

type ChatMessage = { role: "user" | "assistant"; content: string };

/** Builds the pre-injected opening question based on the item's type and state. */
export function suggestedQuestion(m: Mapping): string {
  const p = JSON.parse(m.target_payload);
  const blocked = m.confidence === "red";
  switch (m.target_type) {
    case "translation_pattern":
      return blocked
        ? `Can you suggest an alternative method of implementing this unsupported translation pattern? CUCM pattern "${p.cucmPattern ?? p.matchingPattern}" → "${p.replacementPattern ?? "(no destination)"}".`
        : `What should I check before migrating this translation pattern ("${p.matchingPattern}" → "${p.replacementPattern}")?`;
    case "route_pattern":
      return blocked
        ? `This CUCM route pattern "${p.cucmPattern}" can't be expressed as a Webex dial pattern — what are my routing options?`
        : `How should I route CUCM pattern "${p.cucmPattern}" in Webex Calling, and what should I verify first?`;
    case "person":
      return blocked
        ? `This user (${p.displayName ?? p.email ?? "unknown"}) is blocked from migration — what are my options to get them into Webex Calling?`
        : `What should I review before migrating ${p.displayName ?? p.email} to Webex Calling?`;
    case "workspace":
      return blocked
        ? `This common-area phone (${p.name}) is blocked — how can I migrate it to a Webex workspace?`
        : `What should I check before migrating common-area phone "${p.name}" as a Webex workspace?`;
    case "hunt_group":
      return blocked
        ? `This hunt group ("${p.name}") is blocked — how do I get it into Webex Calling?`
        : `What should I review on this hunt group ("${p.name}") before pushing it to Webex?`;
    default:
      return blocked ? `This item is blocked — what are my options?` : `Explain this flagged item and what I should check before migrating it.`;
  }
}

export function ChatModal({ projectId, mapping, onClose }: { projectId: string; mapping: Mapping; onClose: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const startedRef = useRef(false);

  const ask = async (history: ChatMessage[]) => {
    setBusy(true);
    try {
      const r = await api.post<{ reply: string }>(`/api/projects/${projectId}/ai/chat`, {
        mappingId: mapping.id,
        messages: history,
      });
      setMessages([...history, { role: "assistant", content: r.reply }]);
    } catch (e) {
      setMessages([...history, { role: "assistant", content: `Sorry — the assistant is unavailable: ${e instanceof Error ? e.message : e}` }]);
    } finally {
      setBusy(false);
    }
  };

  // Pre-inject the suitable question and ask immediately.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const opening: ChatMessage[] = [{ role: "user", content: suggestedQuestion(mapping) }];
    setMessages(opening);
    ask(opening);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  const send = (e: FormEvent) => {
    e.preventDefault();
    if (!input.trim() || busy) return;
    const next: ChatMessage[] = [...messages, { role: "user", content: input.trim() }];
    setMessages(next);
    setInput("");
    ask(next);
  };

  const p = JSON.parse(mapping.target_payload);
  const label = mapping.target_type === "person" ? (p.email ?? p.displayName) : (p.name ?? p.matchingPattern ?? p.cucmPattern);

  return (
    <Modal title="Migration assistant" onClose={onClose}>
      <div className="chat-modal">
        <div className="chat-context">
          {mapping.target_type.replace(/_/g, " ")} · <strong>{label}</strong> ·{" "}
          {mapping.confidence === "red" ? "blocked" : mapping.confidence === "amber" ? "needs review" : "ready"}
        </div>
        <div className="chat-log" ref={logRef}>
          {messages.map((m, i) => (
            <div key={i} className={`chat-msg ${m.role}`}>
              {m.content}
            </div>
          ))}
          {busy && <div className="chat-msg assistant thinking">thinking…</div>}
        </div>
        <form className="chat-compose" onSubmit={send}>
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask a follow-up…" disabled={busy} />
          <button className="btn primary" disabled={busy || !input.trim()}>
            Send
          </button>
        </form>
      </div>
    </Modal>
  );
}
