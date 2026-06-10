import { useEffect, useState } from "react";
import { useOutletContext, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { Alert, Card, Empty, Pill, Spinner } from "../components";
import type { ProjectContext } from "../App";

type Status = { connected: boolean; org_name?: string; org_id?: string; adminEmail?: string; expires_at?: string; error?: string };

export function WebexPage() {
  const { reload } = useOutletContext<ProjectContext>();
  const { projectId } = useParams();
  const [params] = useSearchParams();
  const [status, setStatus] = useState<Status | null>(null);
  const [locations, setLocations] = useState<any[] | null>(null);
  const [licenses, setLicenses] = useState<any[] | null>(null);

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
              <a className="btn sm" href={`/auth/login?project=${projectId}`}>
                Re-authorise
              </a>
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
