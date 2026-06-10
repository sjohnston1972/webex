import { FormEvent, useRef, useState } from "react";
import { useOutletContext, useParams } from "react-router-dom";
import { api } from "../api";
import { Alert, Card, Empty, Pill, Spinner } from "../components";
import type { ProjectContext } from "../App";

export function SourcePage() {
  const { summary, reload } = useOutletContext<ProjectContext>();
  const { projectId } = useParams();

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Source data</h1>
        <p className="page-desc">Pull configuration live from CUCM over AXL, or upload BAT/Unity export files.</p>
      </div>
      <AxlCard projectId={projectId!} axl={summary.axl} onChange={reload} />
      <UploadCard projectId={projectId!} onChange={reload} />
      <Card title="Ingest history" tight>
        {summary.snapshots.length === 0 ? (
          <Empty>Nothing ingested yet.</Empty>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>When</th>
                <th>Type</th>
                <th>Method</th>
                <th>Status</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {summary.snapshots.map((s) => (
                <tr key={s.id}>
                  <td>{new Date(s.created_at + "Z").toLocaleString()}</td>
                  <td>{s.type.toUpperCase()}</td>
                  <td>{s.source === "axl" ? "AXL pull" : "File upload"}</td>
                  <td>
                    <Pill tone={s.status === "parsed" ? "green" : s.status === "failed" ? "red" : "blue"}>{s.status}</Pill>
                  </td>
                  <td className="notes">
                    {s.counts_json && <div className="mono small">{s.counts_json}</div>}
                    {s.error_text && <div className="small" style={{ color: "var(--amber)" }}>{s.error_text}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}

function AxlCard({ projectId, axl, onChange }: { projectId: string; axl: ProjectContext["summary"]["axl"]; onChange: () => void }) {
  const [baseUrl, setBaseUrl] = useState(axl?.base_url ?? "");
  const [username, setUsername] = useState(axl?.username ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy("save");
    setMsg(null);
    try {
      await api.put(`/api/projects/${projectId}/axl`, { baseUrl, username, password: password || undefined });
      setMsg({ tone: "ok", text: "Connection saved. Test it to verify reachability." });
      setPassword("");
      onChange();
    } catch (err) {
      setMsg({ tone: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy("test");
    setMsg(null);
    try {
      const r = await api.post<{ ok: boolean; cucmVersion?: string; error?: string }>(`/api/projects/${projectId}/axl/test`);
      setMsg(r.ok ? { tone: "ok", text: `Connected — CUCM version ${r.cucmVersion}` } : { tone: "error", text: r.error ?? "Failed" });
      onChange();
    } catch (err) {
      setMsg({ tone: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const pull = async () => {
    setBusy("pull");
    setMsg({ tone: "info", text: "Pulling configuration from CUCM — this can take a minute on larger systems…" });
    try {
      const r = await api.post<{ counts: Record<string, number>; warnings: string[] }>(`/api/projects/${projectId}/axl/pull`);
      const summary = Object.entries(r.counts)
        .map(([k, v]) => `${v} ${k}`)
        .join(", ");
      setMsg({ tone: "ok", text: `Pull complete: ${summary}${r.warnings.length ? ` — ${r.warnings.length} warning(s), see ingest history` : ""}` });
      onChange();
    } catch (err) {
      setMsg({ tone: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card
      title="CUCM via AXL"
      sub={axl?.verified_at ? `verified ${new Date(axl.verified_at).toLocaleString()} · CUCM ${axl.cucm_version ?? "?"}` : "live pull"}
    >
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <form onSubmit={save}>
        <div className="form-row">
          <div className="field">
            <label>AXL base URL</label>
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://cucm-axl.example.com" required />
            <div className="hint">
              Workers can only reach ports 80/443. If CUCM publishes AXL on 8443, front it with a Cloudflare Tunnel (e.g.{" "}
              <span className="mono">cloudflared</span> → <span className="mono">https://cucm:8443</span> with TLS verify off) and use the tunnel
              hostname here.
            </div>
          </div>
        </div>
        <div className="form-row">
          <div className="field">
            <label>AXL username</label>
            <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="axl-api-user" required />
          </div>
          <div className="field">
            <label>Password {axl ? "(leave blank to keep saved)" : ""}</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={axl ? "••••••••" : ""} />
            <div className="hint">Needs the “Standard AXL API Access” role. Stored encrypted (AES-256-GCM).</div>
          </div>
        </div>
        <div className="toolbar">
          <button className="btn" type="submit" disabled={busy !== null}>
            {busy === "save" ? <Spinner /> : "Save connection"}
          </button>
          <button className="btn" type="button" onClick={test} disabled={busy !== null || !axl}>
            {busy === "test" ? <Spinner /> : "Test connection"}
          </button>
          <div className="grow" />
          <button className="btn primary" type="button" onClick={pull} disabled={busy !== null || !axl}>
            {busy === "pull" ? <Spinner /> : "⤓ Pull configuration"}
          </button>
        </div>
      </form>
    </Card>
  );
}

function UploadCard({ projectId, onChange }: { projectId: string; onChange: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [type, setType] = useState<"cucm" | "unity">("cucm");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const upload = async (e: FormEvent) => {
    e.preventDefault();
    const files = fileRef.current?.files;
    if (!files || files.length === 0) return;
    setBusy(true);
    setMsg(null);
    try {
      const form = new FormData();
      form.set("type", type);
      for (const f of Array.from(files)) form.append("file", f);
      const up = await api.upload<{ snapshotId: string }>(`/api/projects/${projectId}/uploads`, form);
      const parsed = await api.post<{ counts: Record<string, number>; warnings: string[] }>(
        `/api/projects/${projectId}/snapshots/${up.snapshotId}/parse`,
      );
      const detail = Object.entries(parsed.counts)
        .map(([k, v]) => `${v} ${k}`)
        .join(", ");
      setMsg({ tone: "ok", text: `Parsed: ${detail || "no recognisable rows"}${parsed.warnings.length ? ` — ${parsed.warnings.join("; ")}` : ""}` });
      if (fileRef.current) fileRef.current.value = "";
      onChange();
    } catch (err) {
      setMsg({ tone: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="File upload" sub="fallback — BAT / Unity CSV exports">
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <form onSubmit={upload}>
        <div className="form-row">
          <div className="field">
            <label>Export type</label>
            <select value={type} onChange={(e) => setType(e.target.value as "cucm" | "unity")}>
              <option value="cucm">CUCM (BAT export CSVs)</option>
              <option value="unity">Unity Connection (mailbox CSV)</option>
            </select>
          </div>
          <div className="field">
            <label>Files</label>
            <input ref={fileRef} type="file" multiple accept=".csv,.txt" />
            <div className="hint">Headers are auto-detected (users, phones, lines, mailboxes).</div>
          </div>
        </div>
        <button className="btn" type="submit" disabled={busy}>
          {busy ? <Spinner /> : "Upload & parse"}
        </button>
      </form>
    </Card>
  );
}
