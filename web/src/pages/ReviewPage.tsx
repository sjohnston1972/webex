import { useCallback, useEffect, useState } from "react";
import { useOutletContext, useParams } from "react-router-dom";
import { api, Mapping } from "../api";
import { Alert, Card, Empty, Modal, Pill, Spinner } from "../components";
import { ChatModal } from "../ChatModal";
import type { ProjectContext } from "../App";

const TYPE_LABELS: Record<string, string> = {
  person: "People (users + numbers + voicemail)",
  hunt_group: "Hunt groups",
  call_pickup: "Call pickup groups",
  translation_pattern: "Translation patterns (deselected by default — review digit manipulation)",
  route_pattern: "Route patterns (→ Webex dial plans, premises PSTN)",
  workspace: "Workspaces (owner-less / common-area phones)",
  call_park: "Call park (→ Webex call park extensions)",
};

type RouteTarget = { type: "TRUNK" | "ROUTE_GROUP"; id: string; name: string };

// Editable payload fields per mapping type — every pattern is user-correctable.
const EDIT_FIELDS: Record<string, { key: string; label: string; hint?: string }[]> = {
  person: [
    { key: "email", label: "Email" },
    { key: "firstName", label: "First name" },
    { key: "lastName", label: "Last name" },
    { key: "extension", label: "Extension", hint: "plain digits" },
    { key: "phoneNumber", label: "Phone number", hint: "E.164, e.g. +442071234567" },
    { key: "locationName", label: "Webex location" },
  ],
  workspace: [
    { key: "name", label: "Workspace name" },
    { key: "extension", label: "Extension", hint: "plain digits" },
    { key: "phoneNumber", label: "Phone number", hint: "E.164" },
    { key: "locationName", label: "Webex location" },
  ],
  hunt_group: [
    { key: "name", label: "Hunt group name" },
    { key: "extension", label: "Number / extension", hint: "plain digits" },
    { key: "locationName", label: "Webex location" },
  ],
  call_pickup: [
    { key: "name", label: "Pickup group name" },
    { key: "locationName", label: "Webex location" },
  ],
  translation_pattern: [
    { key: "name", label: "Name" },
    { key: "matchingPattern", label: "Matching pattern", hint: 'no "*+"' },
    { key: "replacementPattern", label: "Destination pattern", hint: 'no "*+", no X wildcards' },
  ],
  route_pattern: [
    { key: "name", label: "Name" },
    { key: "dialPattern", label: "Dial pattern", hint: "digits, X, [], !, *, #, +" },
  ],
  call_park: [
    { key: "name", label: "Park name" },
    { key: "extension", label: "Park extension", hint: "single number, plain digits" },
    { key: "locationName", label: "Webex location" },
  ],
};

type SiteMapping = { cucmSite: string; phones: number; webexLocation: string | null };

export function ReviewPage() {
  const { summary, reload } = useOutletContext<ProjectContext>();
  const { projectId } = useParams();
  const [mappings, setMappings] = useState<Mapping[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null);
  const [locations, setLocations] = useState<string[]>([]);
  const [location, setLocation] = useState("");
  const [routeTargets, setRouteTargets] = useState<RouteTarget[]>([]);
  const [routeTarget, setRouteTarget] = useState("");
  const [editing, setEditing] = useState<Mapping | null>(null);
  const [chatWith, setChatWith] = useState<Mapping | null>(null);

  const load = useCallback(() => {
    api.get<Mapping[]>(`/api/projects/${projectId}/mappings`).then(setMappings).catch((e) => setMsg({ tone: "error", text: e.message }));
  }, [projectId]);
  useEffect(load, [load]);

  useEffect(() => {
    if (summary.webex) {
      api
        .get<any[]>(`/api/projects/${projectId}/webex/locations`)
        .then((locs) => setLocations(locs.map((l) => l.name)))
        .catch(() => setLocations([]));
      api
        .get<{ trunks: any[]; routeGroups: any[] }>(`/api/projects/${projectId}/webex/pstn`)
        .then((p) =>
          setRouteTargets([
            ...(p.trunks ?? []).map((t) => ({ type: "TRUNK" as const, id: t.id, name: t.name })),
            ...(p.routeGroups ?? []).map((g) => ({ type: "ROUTE_GROUP" as const, id: g.id, name: g.name })),
          ]),
        )
        .catch(() => setRouteTargets([]));
    }
  }, [projectId, summary.webex]);

  const applyRouteTarget = async () => {
    const target = routeTargets.find((t) => t.id === routeTarget);
    if (!target) return;
    setBusy("route");
    try {
      await api.post(`/api/projects/${projectId}/mappings/bulk`, { action: "setRouteChoice", routeChoice: target });
      setMsg({ tone: "ok", text: `Route patterns will push into dial plan "CUCM via ${target.name}".` });
      load();
    } catch (err) {
      setMsg({ tone: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const generate = async () => {
    setBusy("generate");
    setMsg(null);
    try {
      const r = await api.post<{ generated: number }>(`/api/projects/${projectId}/mappings/generate`);
      setMsg({ tone: "ok", text: `Generated ${r.generated} mappings from source data (edited rows preserved).` });
      load();
      reload();
    } catch (err) {
      setMsg({ tone: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const setAllLocation = async () => {
    if (!location) return;
    setBusy("location");
    try {
      await api.post(`/api/projects/${projectId}/mappings/bulk`, { action: "setLocation", locationName: location });
      setMsg({ tone: "ok", text: `Webex location "${location}" applied to all mappings.` });
      load();
    } catch (err) {
      setMsg({ tone: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (m: Mapping) => {
    await api.patch(`/api/projects/${projectId}/mappings/${m.id}`, { selected: m.selected !== 1 });
    setMappings((prev) => prev?.map((x) => (x.id === m.id ? { ...x, selected: m.selected === 1 ? 0 : 1 } : x)) ?? null);
  };

  const bulkSelect = async (targetType: string, select: boolean) => {
    await api.post(`/api/projects/${projectId}/mappings/bulk`, { action: select ? "select" : "deselect", targetType });
    load();
  };

  const grouped = new Map<string, Mapping[]>();
  for (const m of mappings ?? []) {
    if (!grouped.has(m.target_type)) grouped.set(m.target_type, []);
    grouped.get(m.target_type)!.push(m);
  }

  return (
    <>
      <div className="page-head toolbar">
        <div>
          <h1 className="page-title">Review & select</h1>
          <p className="page-desc">Choose which objects migrate to Webex. Amber items carry caveats; red items are blocked until fixed.</p>
        </div>
        <div className="grow" />
        <button className="btn primary" onClick={generate} disabled={busy !== null}>
          {busy === "generate" ? <Spinner /> : "⟳ Generate mappings"}
        </button>
      </div>

      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}

      <SitesCard projectId={projectId!} locations={locations} onSaved={() => { generate(); }} />

      <Card title="Fallback: one Webex location for everything" sub="overrides per-site mapping on all mappings">
        <div className="toolbar">
          {locations.length > 0 ? (
            <div className="field" style={{ marginBottom: 0, minWidth: 260 }}>
              <select value={location} onChange={(e) => setLocation(e.target.value)}>
                <option value="">Choose a Control Hub location…</option>
                {locations.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div className="field" style={{ marginBottom: 0, minWidth: 260 }}>
              <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder={summary.webex ? "Location name" : "Connect Webex to list locations, or type a name"} />
            </div>
          )}
          <button className="btn" onClick={setAllLocation} disabled={!location || busy !== null}>
            {busy === "location" ? <Spinner /> : "Apply to all"}
          </button>
        </div>
      </Card>

      {!mappings ? (
        <Spinner />
      ) : mappings.length === 0 ? (
        <Card>
          <Empty glyph="⇄">No mappings yet — ingest source data, then hit “Generate mappings”.</Empty>
        </Card>
      ) : (
        [...grouped.entries()].map(([type, rows]) => (
          <Card
            key={type}
            title={TYPE_LABELS[type] ?? type}
            sub={`${rows.filter((r) => r.selected).length} of ${rows.length} selected`}
            actions={
              <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                {type === "route_pattern" && (
                  <>
                    <select
                      value={routeTarget}
                      onChange={(e) => setRouteTarget(e.target.value)}
                      style={{ padding: "4px 8px", border: "1px solid var(--border-strong)", borderRadius: 6, font: "inherit", fontSize: 12 }}
                    >
                      <option value="">Route via…</option>
                      {routeTargets.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name} ({t.type === "TRUNK" ? "trunk" : "route group"})
                        </option>
                      ))}
                    </select>
                    <button className="btn sm" onClick={applyRouteTarget} disabled={!routeTarget || busy !== null}>
                      Apply
                    </button>
                  </>
                )}
                <button className="btn sm" onClick={() => bulkSelect(type, true)}>
                  All
                </button>
                <button className="btn sm" onClick={() => bulkSelect(type, false)}>
                  None
                </button>
              </span>
            }
            tight
          >
            <div className="scroll-y" style={{ maxHeight: 480 }}>
            <table className="data">
              <thead>
                <tr>
                  <th style={{ width: 34 }}></th>
                  <th>Identity</th>
                  <th>Number / Ext</th>
                  <th>Location</th>
                  <th>Readiness</th>
                  <th>Notes</th>
                  <th style={{ width: 44 }}></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => {
                  const p = JSON.parse(m.target_payload);
                  return (
                    <tr key={m.id}>
                      <td>
                        <input type="checkbox" checked={m.selected === 1} onChange={() => toggle(m)} />
                      </td>
                      <td>
                        {type === "person" ? (
                          <>
                            <div>{p.displayName}</div>
                            <div className="dim small">{p.email ?? "no email"}</div>
                          </>
                        ) : (
                          <>
                            <div>{p.name}</div>
                            {type === "hunt_group" && <div className="dim small">policy: {p.policy}{p.agentEmails?.length ? ` · ${p.agentEmails.length} agents` : ""}</div>}
                            {type === "call_pickup" && <div className="dim small">{p.agentEmails?.length ?? 0} members</div>}
                            {type === "translation_pattern" && <div className="dim small mono">{p.matchingPattern} → {p.replacementPattern ?? "?"}</div>}
                            {type === "route_pattern" && <div className="dim small mono">{p.cucmPattern} → {p.dialPattern}</div>}
                            {type === "workspace" && <div className="dim small">{p.deviceModel ?? "phone"} · {p.deviceName}</div>}
                          </>
                        )}
                      </td>
                      <td className="mono">{type === "translation_pattern" ? (p.cucmPartition ?? "—") : (p.phoneNumber ?? p.extension ?? "—")}</td>
                      <td>
                        {type === "route_pattern" ? (
                          p.routeChoice ? <span>{p.routeChoice.name}</span> : <span className="dim">no route target</span>
                        ) : type === "translation_pattern" ? (
                          <span className="dim">org-wide</span>
                        ) : (
                          <>
                            {p.locationName ?? <span className="dim">unset</span>}
                            {p.cucmSite && <div className="dim small">CUCM: {p.cucmSite}</div>}
                          </>
                        )}
                      </td>
                      <td>
                        <Pill tone={m.confidence}>
                          {m.confidence === "red"
                            ? "blocked"
                            : m.status === "edited"
                              ? "fixed"
                              : m.confidence === "amber"
                                ? "review"
                                : "ready"}
                        </Pill>
                        {(m.confidence === "red" || m.confidence === "amber") && (
                          <>
                            {" "}
                            <button className="chat-pill" onClick={() => setChatWith(m)} title="Ask the migration assistant">
                              ✦ chat
                            </button>
                          </>
                        )}
                      </td>
                      <td className="notes">{m.notes ?? ""}</td>
                      <td>
                        <button className="btn sm" onClick={() => setEditing(m)} title="Edit this mapping">
                          ✎
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          </Card>
        ))
      )}

      {chatWith && <ChatModal projectId={projectId!} mapping={chatWith} onClose={() => setChatWith(null)} />}

      {editing && (
        <EditMappingModal
          projectId={projectId!}
          mapping={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </>
  );
}

function EditMappingModal({ projectId, mapping, onClose, onSaved }: { projectId: string; mapping: Mapping; onClose: () => void; onSaved: () => void }) {
  const initial = JSON.parse(mapping.target_payload);
  const fields = EDIT_FIELDS[mapping.target_type] ?? [{ key: "name", label: "Name" }];
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(fields.map((f) => [f.key, initial[f.key] ?? ""])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {};
      for (const f of fields) payload[f.key] = values[f.key].trim() === "" ? null : values[f.key].trim();
      await api.patch(`/api/projects/${projectId}/mappings/${mapping.id}`, { payload });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={`Edit ${mapping.target_type.replace(/_/g, " ")}`} onClose={onClose}>
      {error && <Alert tone="error">{error}</Alert>}
      {mapping.notes && (
        <Alert tone="info">
          <span className="small">{mapping.notes}</span>
        </Alert>
      )}
      {fields.map((f) => (
        <div className="field" key={f.key}>
          <label>{f.label}</label>
          <input value={values[f.key]} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />
          {f.hint && <div className="hint">{f.hint}</div>}
        </div>
      ))}
      <div className="toolbar">
        <div className="grow" />
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" onClick={save} disabled={busy}>
          {busy ? <Spinner /> : "Save & re-check"}
        </button>
      </div>
    </Modal>
  );
}

function SitesCard({ projectId, locations, onSaved }: { projectId: string; locations: string[]; onSaved: () => void }) {
  const [sites, setSites] = useState<SiteMapping[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    api.get<SiteMapping[]>(`/api/projects/${projectId}/site-mappings`).then(setSites).catch(() => setSites([]));
  }, [projectId]);

  if (!sites || sites.length === 0) return null;

  const setSite = (cucmSite: string, webexLocation: string) => {
    setSites((prev) => prev!.map((s) => (s.cucmSite === cucmSite ? { ...s, webexLocation: webexLocation || null } : s)));
  };

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await api.put(`/api/projects/${projectId}/site-mappings`, {
        mappings: sites.map((s) => ({ cucmSite: s.cucmSite, webexLocation: s.webexLocation })),
      });
      setMsg({ tone: "ok", text: "Site mappings saved — regenerating mappings to apply locations." });
      onSaved();
    } catch (err) {
      setMsg({ tone: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="CUCM sites → Webex locations" sub="from device pools / CUCM locations on phones" tight>
      {msg && (
        <div style={{ padding: "12px 14px 0" }}>
          <Alert tone={msg.tone}>{msg.text}</Alert>
        </div>
      )}
      <table className="data">
        <thead>
          <tr>
            <th>CUCM site</th>
            <th>Phones</th>
            <th>Webex location</th>
          </tr>
        </thead>
        <tbody>
          {sites.map((s) => (
            <tr key={s.cucmSite}>
              <td>{s.cucmSite}</td>
              <td className="mono">{s.phones}</td>
              <td>
                {locations.length > 0 ? (
                  <select value={s.webexLocation ?? ""} onChange={(e) => setSite(s.cucmSite, e.target.value)} style={{ padding: "5px 8px", border: "1px solid var(--border-strong)", borderRadius: 6, font: "inherit" }}>
                    <option value="">— not mapped —</option>
                    {locations.map((l) => (
                      <option key={l} value={l}>
                        {l}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input value={s.webexLocation ?? ""} onChange={(e) => setSite(s.cucmSite, e.target.value)} placeholder="Webex location name" style={{ padding: "5px 8px", border: "1px solid var(--border-strong)", borderRadius: 6, font: "inherit" }} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ padding: "12px 14px" }}>
        <button className="btn primary" onClick={save} disabled={busy}>
          {busy ? <Spinner /> : "Save & apply to mappings"}
        </button>
      </div>
    </Card>
  );
}
