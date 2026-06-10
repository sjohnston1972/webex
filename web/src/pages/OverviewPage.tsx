import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";
import { api } from "../api";
import { Card, Empty, IngestCounts, Pill } from "../components";
import type { ProjectContext } from "../App";
import { useState } from "react";

const COUNT_LABELS: Record<string, string> = {
  users: "End users",
  phones: "Phones",
  lines: "Directory numbers",
  hunt_pilots: "Hunt pilots",
  hunt_members: "Hunt members",
  pickup_groups: "Pickup groups",
  vm_boxes: "Unity mailboxes",
  trans_patterns: "Translation patterns",
  dialplan: "Dial plan objects",
};

export function OverviewPage() {
  const { summary } = useOutletContext<ProjectContext>();
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const total = Object.values(summary.counts).reduce((a, b) => a + b, 0);
  const mapTotals = { green: 0, amber: 0, red: 0, selected: 0 };
  for (const m of summary.mappings) {
    mapTotals[m.confidence as "green" | "amber" | "red"] += m.n;
    mapTotals.selected += m.selected ?? 0;
  }

  const remove = async () => {
    setBusy(true);
    await api.delete(`/api/projects/${projectId}`);
    navigate("/");
  };

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">{summary.project.name}</h1>
        <p className="page-desc">Created {new Date(summary.project.created_at + "Z").toLocaleString()} · ID <span className="mono">{summary.project.id}</span></p>
      </div>

      <div className="tiles">
        {Object.entries(COUNT_LABELS).map(([key, label]) => (
          <div className="tile" key={key}>
            <div className="tile-value">{summary.counts[key] ?? 0}</div>
            <div className="tile-label">{label}</div>
          </div>
        ))}
      </div>

      <Card title="Pipeline status">
        <div className="kv">
          <dt>Source data</dt>
          <dd>
            {total > 0 ? (
              <Pill tone="green">{total} objects ingested</Pill>
            ) : (
              <>
                <Pill tone="grey">nothing ingested</Pill> <Link to={`/projects/${projectId}/source`}>Pull from CUCM →</Link>
              </>
            )}
          </dd>
          <dt>AXL connection</dt>
          <dd>
            {summary.axl ? (
              <>
                <Pill tone={summary.axl.verified_at ? "green" : "amber"}>{summary.axl.verified_at ? `verified · CUCM ${summary.axl.cucm_version ?? "?"}` : "saved, not verified"}</Pill>{" "}
                <span className="mono small dim">{summary.axl.base_url}</span>
              </>
            ) : (
              <Pill tone="grey">not configured</Pill>
            )}
          </dd>
          <dt>Mappings</dt>
          <dd>
            {mapTotals.green + mapTotals.amber + mapTotals.red > 0 ? (
              <>
                <Pill tone="green">{mapTotals.green} ready</Pill> <Pill tone="amber">{mapTotals.amber} review</Pill> <Pill tone="red">{mapTotals.red} blocked</Pill>{" "}
                <span className="dim small">{mapTotals.selected} selected for migration</span>
              </>
            ) : (
              <>
                <Pill tone="grey">not generated</Pill> <Link to={`/projects/${projectId}/review`}>Review & select →</Link>
              </>
            )}
          </dd>
          <dt>Webex org</dt>
          <dd>
            {summary.webex ? (
              <Pill tone="green">
                {summary.webex.org_name && !summary.webex.org_name.startsWith("Y2lzY29zcGFyaz") ? summary.webex.org_name : "Connected"}
              </Pill>
            ) : (
              <>
                <Pill tone="grey">not connected</Pill> <Link to={`/projects/${projectId}/webex`}>Connect →</Link>
              </>
            )}
          </dd>
          <dt>Batches</dt>
          <dd>
            {summary.batches.length > 0 ? (
              summary.batches.slice(0, 4).map((b) => (
                <span key={b.id} style={{ marginRight: 8 }}>
                  <Pill tone={b.status}>{b.name}: {b.status}</Pill>
                </span>
              ))
            ) : (
              <Pill tone="grey">none yet</Pill>
            )}
          </dd>
        </div>
      </Card>

      <Card title="Recent ingests" tight>
        {summary.snapshots.length === 0 ? (
          <Empty>No source data pulled or uploaded yet.</Empty>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>When</th>
                <th>Type</th>
                <th>Method</th>
                <th>Status</th>
                <th>Objects</th>
              </tr>
            </thead>
            <tbody>
              {summary.snapshots.slice(0, 6).map((s) => (
                <tr key={s.id}>
                  <td>{new Date(s.created_at + "Z").toLocaleString()}</td>
                  <td>{s.type.toUpperCase()}</td>
                  <td>{s.source === "axl" ? "AXL pull" : "File upload"}</td>
                  <td>
                    <Pill tone={s.status === "parsed" ? "green" : s.status === "failed" ? "red" : "blue"}>{s.status}</Pill>
                  </td>
                  <td><IngestCounts json={s.counts_json} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Danger zone">
        {!confirmDelete ? (
          <button className="btn danger" onClick={() => setConfirmDelete(true)}>
            Delete project…
          </button>
        ) : (
          <div className="toolbar">
            <span>Deletes all parsed data, mappings, batch history and uploaded files for this project. Webex objects already pushed are untouched.</span>
            <button className="btn" onClick={() => setConfirmDelete(false)}>
              Keep it
            </button>
            <button className="btn danger" onClick={remove} disabled={busy}>
              Delete permanently
            </button>
          </div>
        )}
      </Card>
    </>
  );
}
