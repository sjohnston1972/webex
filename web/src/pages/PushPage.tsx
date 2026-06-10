import { useCallback, useEffect, useRef, useState } from "react";
import { useOutletContext, useParams } from "react-router-dom";
import { api, Batch, BatchItem } from "../api";
import { Alert, Card, Empty, Pill, Spinner } from "../components";
import type { ProjectContext } from "../App";

export function PushPage() {
  const { summary, reload } = useOutletContext<ProjectContext>();
  const { projectId } = useParams();
  const [active, setActive] = useState<string | null>(summary.batches[0]?.id ?? null);
  const [msg, setMsg] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const createBatch = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.post<{ id: string; items: number }>(`/api/projects/${projectId}/batches`);
      setMsg({ tone: "ok", text: `Batch created with ${r.items} selected item(s). Run the dry-run next.` });
      setActive(r.id);
      reload();
    } catch (err) {
      setMsg({ tone: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head toolbar">
        <div>
          <h1 className="page-title">Validate & push</h1>
          <p className="page-desc">Batch up the selected mappings, dry-run them against Webex, then push. Every batch can be rolled back.</p>
        </div>
        <div className="grow" />
        <button className="btn primary" onClick={createBatch} disabled={busy}>
          {busy ? <Spinner /> : "+ New batch from selection"}
        </button>
      </div>

      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}

      {summary.batches.length === 0 ? (
        <Card>
          <Empty glyph="⇪">No batches yet. Select objects on the Review page, then create a batch.</Empty>
        </Card>
      ) : (
        <>
          <Card title="Batches" tight>
            <table className="data">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Created</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {summary.batches.map((b: Batch) => (
                  <tr key={b.id}>
                    <td>{b.name}</td>
                    <td>{new Date(b.created_at + "Z").toLocaleString()}</td>
                    <td>
                      <Pill tone={b.status}>{b.status}</Pill>
                    </td>
                    <td>
                      <button className="btn sm" onClick={() => setActive(b.id)} disabled={active === b.id}>
                        {active === b.id ? "viewing" : "view"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          {active && <BatchDetail projectId={projectId!} batchId={active} onChange={reload} />}
        </>
      )}
    </>
  );
}

function BatchDetail({ projectId, batchId, onChange }: { projectId: string; batchId: string; onChange: () => void }) {
  const [data, setData] = useState<{ batch: Batch; items: BatchItem[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null);
  const timer = useRef<number | null>(null);

  const load = useCallback(async () => {
    const d = await api.get<{ batch: Batch; items: BatchItem[] }>(`/api/projects/${projectId}/batches/${batchId}`);
    setData(d);
    return d;
  }, [projectId, batchId]);

  useEffect(() => {
    load();
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [load]);

  // Poll while a push/rollback is in flight.
  useEffect(() => {
    const inFlight = data && ["pushing", "rolling_back"].includes(data.batch.status);
    if (inFlight) {
      timer.current = window.setTimeout(async () => {
        const d = await load();
        if (!["pushing", "rolling_back"].includes(d.batch.status)) onChange();
      }, 2500);
    }
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [data, load, onChange]);

  const act = async (action: "validate" | "push" | "rollback", confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(action);
    setMsg(null);
    try {
      const r = await api.post<any>(`/api/projects/${projectId}/batches/${batchId}/${action}`);
      if (action === "validate") setMsg({ tone: "ok", text: `Dry run complete — ${r.green} green, ${r.amber} amber, ${r.red} red.` });
      else setMsg({ tone: "info", text: `${action === "push" ? "Push" : "Rollback"} started (${r.queued} job(s) queued).` });
      await load();
      onChange();
    } catch (err) {
      setMsg({ tone: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  if (!data) return <Spinner />;
  const { batch, items } = data;
  const doneCount = items.filter((i) => ["done", "failed", "skipped", "rolled_back"].includes(i.push_status)).length;
  const inFlight = ["pushing", "rolling_back"].includes(batch.status);

  return (
    <Card
      title={`Batch: ${batch.name}`}
      sub={`${items.length} items`}
      actions={
        <span style={{ display: "inline-flex", gap: 6 }}>
          <button className="btn sm" onClick={() => act("validate")} disabled={busy !== null || inFlight}>
            {busy === "validate" ? <Spinner /> : "Dry run"}
          </button>
          <button
            className="btn sm primary"
            onClick={() => act("push", "Push this batch to the live Webex org?")}
            disabled={busy !== null || inFlight || !["validated", "failed", "pushed"].includes(batch.status)}
          >
            {busy === "push" ? <Spinner /> : "Push to Webex"}
          </button>
          <button
            className="btn sm danger"
            onClick={() => act("rollback", "Undo everything this batch created in Webex?")}
            disabled={busy !== null || inFlight || !["pushed", "failed"].includes(batch.status)}
          >
            Rollback
          </button>
        </span>
      }
      tight
    >
      {msg && (
        <div style={{ padding: "12px 14px 0" }}>
          <Alert tone={msg.tone}>{msg.text}</Alert>
        </div>
      )}
      {inFlight && (
        <div style={{ padding: "12px 14px" }}>
          <div className="toolbar small" style={{ marginBottom: 6 }}>
            <Spinner /> {batch.status === "pushing" ? "Pushing to Webex…" : "Rolling back…"} {doneCount}/{items.length}
          </div>
          <div className="progressbar">
            <div style={{ width: `${(doneCount / Math.max(items.length, 1)) * 100}%` }} />
          </div>
        </div>
      )}
      <table className="data">
        <thead>
          <tr>
            <th>Object</th>
            <th>Identity</th>
            <th>Dry run</th>
            <th>Push</th>
            <th>Webex ID</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => {
            const p = JSON.parse(i.target_payload);
            return (
              <tr key={i.id}>
                <td>{i.target_type.replace("_", " ")}</td>
                <td>{i.target_type === "person" ? (p.email ?? p.displayName) : p.name}</td>
                <td>{i.validate_status ? <Pill tone={i.validate_status}>{i.validate_status}</Pill> : <span className="dim">—</span>}</td>
                <td>
                  <Pill tone={i.push_status}>{i.push_status}</Pill>
                </td>
                <td className="mono small dim">{i.webex_resource_id ? `${i.webex_resource_id.slice(0, 18)}…` : "—"}</td>
                <td className="notes">
                  {i.validate_notes && <div>{i.validate_notes}</div>}
                  {i.error_text && <div style={{ color: "var(--red)" }}>{i.error_text}</div>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}
