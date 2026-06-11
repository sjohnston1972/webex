import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";
import { api } from "../api";
import { Card, Empty, IngestCounts, Modal, Pill, Spinner } from "../components";
import { ChatModal, ChatTopic } from "../ChatModal";
import { ingestMethod } from "./SourcePage";
import type { ProjectContext } from "../App";
import { useEffect, useState } from "react";

// What each tile shows when clicked: where to fetch and which columns to render.
type TileSpec = { title: string; fetch: (projectId: string) => string; columns: { key: string; label: string; render?: (row: any) => unknown }[]; kind?: "greetings" };

const personName = (row: any) => {
  const p = JSON.parse(row.target_payload);
  return row.target_type === "person" ? (p.email ?? p.displayName) : (p.name ?? p.matchingPattern ?? p.cucmPattern);
};
const payloadCol = (key: string) => (row: any) => JSON.parse(row.target_payload)[key] ?? "—";

const ELIGIBLE_COLUMNS = [
  { key: "identity", label: "Identity", render: personName },
  { key: "number", label: "Number / Ext", render: (r: any) => { const p = JSON.parse(r.target_payload); return p.phoneNumber ?? p.extension ?? p.dialPattern ?? "—"; } },
  { key: "location", label: "Location", render: payloadCol("locationName") },
  { key: "confidence", label: "Readiness", render: (r: any) => (r.confidence === "red" ? "blocked" : r.confidence === "amber" ? "review" : "ready") },
  { key: "selected", label: "Selected", render: (r: any) => (r.selected ? "yes" : "no") },
];

const TILE_SPECS: Record<string, TileSpec> = {
  users: { title: "End users", fetch: (id) => `/api/projects/${id}/objects/users`, columns: [
    { key: "userid", label: "User ID" },
    { key: "name", label: "Name", render: (r) => [r.first_name, r.last_name].filter(Boolean).join(" ") || "—" },
    { key: "email", label: "Email" },
    { key: "primary_extension", label: "Extension" },
  ] },
  phones: { title: "Phones", fetch: (id) => `/api/projects/${id}/objects/phones`, columns: [
    { key: "device_name", label: "Device" },
    { key: "model", label: "Model" },
    { key: "owner_userid", label: "Owner" },
    { key: "device_pool", label: "Device pool" },
    { key: "lines_json", label: "Lines" },
  ] },
  lines: { title: "Directory numbers", fetch: (id) => `/api/projects/${id}/objects/lines`, columns: [
    { key: "pattern", label: "Pattern" },
    { key: "partition_name", label: "Partition" },
    { key: "description", label: "Description" },
  ] },
  hunt_pilots: { title: "Hunt pilots", fetch: (id) => `/api/projects/${id}/objects/hunt_pilots`, columns: [
    { key: "pattern", label: "Pilot" },
    { key: "description", label: "Description" },
    { key: "algorithm", label: "Algorithm" },
    { key: "hunt_list", label: "Hunt list" },
  ] },
  hunt_members: { title: "Hunt members", fetch: (id) => `/api/projects/${id}/objects/hunt_members`, columns: [
    { key: "hunt_pilot_pattern", label: "Pilot" },
    { key: "member_dn", label: "Member DN" },
    { key: "position", label: "Order" },
  ] },
  pickup_groups: { title: "Pickup groups", fetch: (id) => `/api/projects/${id}/objects/pickup_groups`, columns: [
    { key: "name", label: "Name" },
    { key: "pattern", label: "Number" },
    { key: "members_json", label: "Members" },
  ] },
  vm_boxes: { title: "Unity mailboxes", fetch: (id) => `/api/projects/${id}/objects/vm_boxes`, columns: [
    { key: "alias", label: "Alias" },
    { key: "display_name", label: "Display name" },
    { key: "extension", label: "Extension" },
    { key: "email", label: "Email" },
  ] },
  vm_greetings: { title: "Greeting files", kind: "greetings", fetch: (id) => `/api/projects/${id}/objects/vm_greetings`, columns: [
    { key: "filename", label: "File" },
    { key: "matched_alias", label: "Matched mailbox" },
  ] },
  call_handlers: { title: "Unity call handlers", fetch: (id) => `/api/projects/${id}/objects/call_handlers`, columns: [
    { key: "name", label: "Handler" },
    { key: "extension", label: "Extension" },
    { key: "menu", label: "Menu keys", render: (r) => {
      try {
        const menu = JSON.parse(r.menu_json ?? "[]") as any[];
        const live = menu.filter((m) => String(m.Action ?? "0") !== "0");
        return live.length ? live.map((m) => m.TouchtoneKey).join(", ") : "—";
      } catch { return "—"; }
    } },
  ] },
  trans_patterns: { title: "Translation patterns", fetch: (id) => `/api/projects/${id}/objects/trans_patterns`, columns: [
    { key: "pattern", label: "Pattern" },
    { key: "called_party_mask", label: "Mask" },
    { key: "prefix_digits", label: "Prefix" },
    { key: "description", label: "Description" },
  ] },
  dialplan: { title: "Dial plan objects", fetch: (id) => `/api/projects/${id}/objects/dialplan`, columns: [
    { key: "object_type", label: "Type", render: (r) => String(r.object_type).replace(/_/g, " ") },
    { key: "name", label: "Pattern / Name" },
    { key: "partition_name", label: "Partition" },
    { key: "description", label: "Description" },
  ] },
  unattached: { title: "Unattached DNs (no migration path)", fetch: (id) => `/api/projects/${id}/reports/unattached-dns`, columns: [
    { key: "pattern", label: "DN" },
    { key: "device", label: "On device" },
    { key: "model", label: "Model" },
    { key: "owner", label: "Owner" },
  ] },
};

function eligibleSpec(targetType: string, label: string): TileSpec {
  return { title: label, fetch: (id) => `/api/projects/${id}/mappings?type=${targetType}`, columns: ELIGIBLE_COLUMNS };
}

function TileModal({ projectId, spec, onClose }: { projectId: string; spec: TileSpec; onClose: () => void }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState<any | null>(null);
  useEffect(() => {
    api.get<any[]>(spec.fetch(projectId)).then(setRows).catch((e) => setError(e.message));
  }, [projectId, spec]);

  const audioUrl = (row: any) => `/api/projects/${projectId}/greetings/${row.id}/audio`;

  return (
    <Modal title={spec.title} onClose={onClose} xl>
      {error && <div className="alert error">{error}</div>}
      {!rows && !error ? (
        <Spinner />
      ) : rows && rows.length === 0 ? (
        <Empty>Nothing here yet.</Empty>
      ) : rows && (
        <div className="scroll-y" style={{ maxHeight: "56vh" }}>
          <table className="data">
            <thead>
              <tr>
                {spec.columns.map((c) => <th key={c.key}>{c.label}</th>)}
                {spec.kind === "greetings" && <th style={{ width: 130 }}>Audio</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.id ?? i}>
                  {spec.columns.map((c) => (
                    <td key={c.key} className="small">{String((c.render ? c.render(r) : r[c.key]) ?? "—")}</td>
                  ))}
                  {spec.kind === "greetings" && (
                    <td>
                      <span style={{ display: "inline-flex", gap: 6 }}>
                        <button className="btn sm" onClick={() => setPlaying(r)} title="Play in browser">
                          ▶ Play
                        </button>
                        <a className="btn sm" href={`${audioUrl(r)}?download`} title="Download WAV">
                          ⤓
                        </a>
                      </span>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {playing && (
        <div className="scrim" style={{ zIndex: 60 }} onClick={(e) => e.target === e.currentTarget && setPlaying(null)}>
          <div className="player-card">
            <div className="player-glyph">♪</div>
            <div className="player-title">{playing.filename}</div>
            <div className="player-sub">
              {playing.matched_alias ? `mailbox: ${playing.matched_alias}` : "no matched mailbox"} · Unity greeting
            </div>
            <audio controls autoPlay src={audioUrl(playing)} style={{ width: "100%", marginTop: 14 }} />
            <div className="toolbar" style={{ marginTop: 14 }}>
              <a className="btn sm" href={`${audioUrl(playing)}?download`}>
                ⤓ Download
              </a>
              <div className="grow" />
              <button className="btn sm" onClick={() => setPlaying(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

const COUNT_LABELS: Record<string, string> = {
  users: "End users",
  phones: "Phones",
  lines: "Directory numbers",
  hunt_pilots: "Hunt pilots",
  hunt_members: "Hunt members",
  pickup_groups: "Pickup groups",
  vm_boxes: "Unity mailboxes",
  vm_greetings: "Greeting files",
  call_handlers: "Call handlers",
  trans_patterns: "Translation patterns",
  dialplan: "Dial plan objects",
};

const ELIGIBLE_LABELS: Record<string, string> = {
  person: "People",
  hunt_group: "Hunt groups",
  call_pickup: "Call pickup",
  translation_pattern: "Translation patterns",
  route_pattern: "Route patterns",
  workspace: "Workspaces (common area)",
  call_park: "Call park extensions",
  auto_attendant: "Auto attendants",
};

export function OverviewPage() {
  const { summary } = useOutletContext<ProjectContext>();
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tile, setTile] = useState<TileSpec | null>(null);
  const [issues, setIssues] = useState<{ severity: "red" | "amber" | "info"; title: string; detail: string }[] | null>(null);
  const [chatTopic, setChatTopic] = useState<ChatTopic | null>(null);

  useEffect(() => {
    api
      .get<{ issues: { severity: "red" | "amber" | "info"; title: string; detail: string }[] }>(`/api/projects/${projectId}/issues`)
      .then((r) => setIssues(r.issues))
      .catch(() => setIssues([]));
  }, [projectId, summary]);

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

      <Card
        title="Attention"
        sub={issues === null ? "checking…" : issues.length === 0 ? "no issues found" : `${issues.length} item(s)`}
        tight
      >
        {issues === null ? (
          <div className="card-body">
            <Spinner /> <span className="dim small">Checking licence capacity and readiness…</span>
          </div>
        ) : issues.length === 0 ? (
          <div className="card-body">
            <Pill tone="green">all clear</Pill> <span className="dim small">No capacity or readiness issues detected for the current scope.</span>
          </div>
        ) : (
          <table className="data">
            <tbody>
              {issues.map((iss, i) => (
                <tr key={i}>
                  <td style={{ width: 150 }}>
                    <span className="pill-row">
                      <Pill tone={iss.severity === "info" ? "blue" : iss.severity}>{iss.severity === "red" ? "blocking" : iss.severity === "amber" ? "review" : "info"}</Pill>
                      <button
                        className="chat-pill"
                        title="Ask the migration assistant about this issue"
                        onClick={() =>
                          setChatTopic({
                            label: `readiness issue · ${iss.title}`,
                            question: `Regarding this migration readiness issue: "${iss.title}" — ${iss.detail} What are my options to resolve or work around it?`,
                            context: `${iss.title}: ${iss.detail}`,
                          })
                        }
                      >
                        ✦ chat
                      </button>
                    </span>
                  </td>
                  <td style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{iss.title}</td>
                  <td className="notes">{iss.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <div className="tiles">
        {Object.entries(COUNT_LABELS).map(([key, label]) => (
          <button className="tile tile-click" key={key} onClick={() => TILE_SPECS[key] && setTile(TILE_SPECS[key])}>
            <div className="tile-value">{summary.counts[key] ?? 0}</div>
            <div className="tile-label">{label}</div>
          </button>
        ))}
      </div>

      {(summary.mappingsByType?.length ?? 0) > 0 && (
        <>
          <h2 style={{ fontSize: 13, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--ink-faint)", margin: "4px 0 10px" }}>
            Eligible for migration
          </h2>
          <div className="tiles">
            {summary.mappingsByType.map((m) => (
              <button
                className="tile tile-click"
                key={m.target_type}
                onClick={() => setTile(eligibleSpec(m.target_type, ELIGIBLE_LABELS[m.target_type] ?? m.target_type))}
              >
                <div className="tile-value">{m.n}</div>
                <div className="tile-label">{ELIGIBLE_LABELS[m.target_type] ?? m.target_type} · {m.selected ?? 0} selected</div>
              </button>
            ))}
            {(summary.unattachedDns ?? 0) > 0 && (
              <button className="tile tile-click" style={{ boxShadow: "0 1px 2px rgba(32,41,47,0.05), 0 0 0 1px #ecc7c5" }} onClick={() => setTile(TILE_SPECS.unattached)}>
                <div className="tile-value" style={{ color: "var(--red)" }}>{summary.unattachedDns}</div>
                <div className="tile-label">Unattached DNs · no migration path</div>
              </button>
            )}
          </div>
        </>
      )}

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
          <dt>Unity connection</dt>
          <dd>
            {summary.unity ? (
              <>
                <Pill tone={summary.unity.verified_at ? "green" : "amber"}>
                  {summary.unity.verified_at ? `verified · Unity ${summary.unity.unity_version ?? "?"}` : "saved, not verified"}
                </Pill>{" "}
                <span className="mono small dim">{summary.unity.base_url}</span>
                {(summary.counts.vm_boxes ?? 0) > 0 && <span className="dim small"> · {summary.counts.vm_boxes} mailboxes</span>}
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
                  <td style={{ whiteSpace: "nowrap" }}>{new Date(s.created_at + "Z").toLocaleString()}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{s.type.toUpperCase()}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{ingestMethod(s.source)}</td>
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

      {tile && <TileModal projectId={projectId!} spec={tile} onClose={() => setTile(null)} />}
      {chatTopic && <ChatModal projectId={projectId!} topic={chatTopic} onClose={() => setChatTopic(null)} />}

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
