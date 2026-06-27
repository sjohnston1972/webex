import { useEffect, useState } from "react";
import { useOutletContext, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { Alert, Card, Empty, Pill, Spinner } from "../components";
import type { ProjectContext } from "../App";

type Status = { connected: boolean; org_name?: string; org_id?: string; adminEmail?: string; expires_at?: string; error?: string };

type Pstn = {
  locations: { id: string; name: string; connection: any; options: any[] }[];
  trunks: any[];
  routeGroups: any[];
  dialPlans: any[];
};

function PstnCard({ projectId }: { projectId: string }) {
  const [pstn, setPstn] = useState<Pstn | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<Pstn>(`/api/projects/${projectId}/webex/pstn`).then(setPstn).catch((e) => setError(e.message));
  }, [projectId]);

  return (
    <Card title="PSTN & route targets" sub="how calls leave Webex — targets for migrated route patterns" tight>
      {error && (
        <div className="card-body">
          <Alert tone="error">{error}</Alert>
        </div>
      )}
      {!pstn && !error ? (
        <div className="card-body">
          <Spinner />
        </div>
      ) : pstn && (
        <>
          <table className="data">
            <thead>
              <tr>
                <th>Location</th>
                <th>PSTN connection</th>
                <th>Available options</th>
              </tr>
            </thead>
            <tbody>
              {pstn.locations.map((l) => (
                <tr key={l.id}>
                  <td>{l.name}</td>
                  <td>
                    {l.connection ? (
                      <Pill tone="green">{(l.connection as any).type ?? (l.connection as any).name ?? "configured"}</Pill>
                    ) : (
                      <Pill tone="grey">none</Pill>
                    )}
                  </td>
                  <td className="notes">
                    {l.options.length > 0 ? l.options.map((o: any) => o.name ?? o.type ?? o.id).join(" · ") : <span className="dim">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="card-body small" style={{ borderTop: "1px solid var(--border)" }}>
            <strong>Premises routing:</strong>{" "}
            {pstn.trunks.length} trunk(s) · {pstn.routeGroups.length} route group(s) · {pstn.dialPlans.length} dial plan(s)
            {pstn.trunks.length + pstn.routeGroups.length === 0 && (
              <span className="dim"> — route patterns need a Local Gateway trunk or route group before they can push</span>
            )}
          </div>
        </>
      )}
    </Card>
  );
}

export function WebexPage() {
  const { reload } = useOutletContext<ProjectContext>();
  const { projectId } = useParams();
  const [params] = useSearchParams();
  const [status, setStatus] = useState<Status | null>(null);
  const [locations, setLocations] = useState<any[] | null>(null);
  const [licenses, setLicenses] = useState<any[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  async function refreshToken() {
    setRefreshing(true);
    setRefreshMsg(null);
    try {
      const r = await api.post<{ expires_at: string }>(`/api/projects/${projectId}/webex/refresh`);
      setStatus((s) => (s ? { ...s, expires_at: r.expires_at } : s));
      setRefreshMsg({ tone: "ok", text: `Token refreshed — now valid until ${new Date(r.expires_at).toLocaleString()}.` });
    } catch (e) {
      setRefreshMsg({ tone: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    api.get<Status>(`/api/projects/${projectId}/webex/status`).then((s) => {
      setStatus(s);
      if (s.connected) {
        api.get<any[]>(`/api/projects/${projectId}/webex/locations`).then(setLocations).catch(() => setLocations([]));
        api.get<any[]>(`/api/projects/${projectId}/webex/licenses`).then(setLicenses).catch(() => setLicenses([]));
        reload();
      }
    });
  }, [projectId, reload]);

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Webex organisation</h1>
        <p className="page-desc">Authorise the tool against the target Control Hub org with an admin account.</p>
      </div>

      {params.get("connected") === "1" && <Alert tone="ok">Webex connected successfully.</Alert>}

      <Card title="Connection">
        {!status ? (
          <Spinner />
        ) : status.connected ? (
          <div className="kv">
            <dt>Status</dt>
            <dd>
              <Pill tone="green">connected</Pill>
            </dd>
            <dt>Organisation</dt>
            <dd>{status.org_name ?? status.org_id}</dd>
            <dt>Authorised as</dt>
            <dd>{status.adminEmail ?? "—"}</dd>
            <dt>Token expires</dt>
            <dd>{status.expires_at ? new Date(status.expires_at).toLocaleString() : "—"} <span className="dim small">(auto-refreshed)</span></dd>
            <dt></dt>
            <dd>
              <button className="btn sm" onClick={refreshToken} disabled={refreshing}>
                {refreshing ? "Refreshing…" : "Refresh now"}
              </button>{" "}
              <a className="btn sm" href={`/auth/login?project=${projectId}`}>
                Re-authorise
              </a>
              {refreshMsg && (
                <div style={{ marginTop: 8 }}>
                  <Alert tone={refreshMsg.tone}>{refreshMsg.text}</Alert>
                </div>
              )}
            </dd>
          </div>
        ) : (
          <>
            {status.error && <Alert tone="error">{status.error}</Alert>}
            <p className="dim">
              You'll be redirected to Webex to sign in. Use an <strong>org administrator</strong> account (e.g. the sandbox admin) — the
              requested admin scopes only take effect for admins.
            </p>
            <a className="btn primary" href={`/auth/login?project=${projectId}`}>
              Connect to Webex →
            </a>
          </>
        )}
      </Card>

      {status?.connected && <PstnCard projectId={projectId!} />}

      {status?.connected && (
        <>
          <Card title="Locations" sub="targets for people, hunt groups and pickup groups" tight>
            {!locations ? (
              <div className="card-body">
                <Spinner />
              </div>
            ) : locations.length === 0 ? (
              <Empty>No locations found — create them in Control Hub first (v1 doesn't auto-create).</Empty>
            ) : (
              <table className="data">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>ID</th>
                  </tr>
                </thead>
                <tbody>
                  {locations.map((l) => (
                    <tr key={l.id}>
                      <td>{l.name}</td>
                      <td className="mono small dim">{l.id.slice(0, 28)}…</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
          <Card title="Licences" tight>
            {!licenses ? (
              <div className="card-body">
                <Spinner />
              </div>
            ) : (
              <table className="data">
                <thead>
                  <tr>
                    <th>Licence</th>
                    <th>Used / Total</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {licenses.map((l) => {
                    const calling = /webex calling/i.test(l.name);
                    const free = l.totalUnits === undefined || l.consumedUnits < l.totalUnits;
                    return (
                      <tr key={l.id}>
                        <td>{l.name}</td>
                        <td className="mono">
                          {l.consumedUnits ?? 0} / {l.totalUnits ?? "∞"}
                        </td>
                        <td>{calling && <Pill tone={free ? "green" : "red"}>{free ? "used for migration" : "exhausted"}</Pill>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </Card>
        </>
      )}
    </>
  );
}
