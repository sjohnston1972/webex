import { BrowserRouter, Link, NavLink, Outlet, Route, Routes, useLocation, useParams } from "react-router-dom";
import { useCallback, useEffect, useState } from "react";
import { api, Summary } from "./api";
import { Landing } from "./Landing";
import { ProjectsPage } from "./pages/ProjectsPage";
import { OverviewPage } from "./pages/OverviewPage";
import { SourcePage } from "./pages/SourcePage";
import { ReviewPage } from "./pages/ReviewPage";
import { DialPlanPage } from "./pages/DialPlanPage";
import { WebexPage } from "./pages/WebexPage";
import { PushPage } from "./pages/PushPage";
import { ReportsPage } from "./pages/ReportsPage";

export type ProjectContext = { summary: Summary; reload: () => void };

const STAGES = [
  { path: "", step: "Overview", name: "Status" },
  { path: "source", step: "Stage 1", name: "Source" },
  { path: "review", step: "Stage 2", name: "Review & select" },
  { path: "webex", step: "Stage 3", name: "Webex" },
  { path: "push", step: "Stage 4", name: "Validate & push" },
  { path: "reports", step: "Stage 5", name: "Reports" },
];

function ThemeToggle() {
  const [dark, setDark] = useState(document.documentElement.dataset.theme === "dark");
  const toggle = () => {
    const next = !dark;
    setDark(next);
    if (next) {
      document.documentElement.dataset.theme = "dark";
      localStorage.setItem("wx-theme", "dark");
    } else {
      delete document.documentElement.dataset.theme;
      localStorage.setItem("wx-theme", "light");
    }
  };
  return (
    <button className="theme-toggle" onClick={toggle} title="Toggle dark mode">
      {dark ? "☀ Light" : "☾ Dark"}
    </button>
  );
}

type AxlLive = { configured: boolean; connected: boolean; cucmVersion?: string; error?: string; checkedAt?: string; lastVerifiedAt?: string };

function PipelinePanel({ projectId, pathname }: { projectId: string; pathname: string }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  // null while the live CUCM ping is in flight; resolved object = live result.
  const [axlLive, setAxlLive] = useState<AxlLive | null>(null);

  useEffect(() => {
    api.get<Summary>(`/api/projects/${projectId}/summary`).then(setSummary).catch(() => setSummary(null));
  }, [projectId, pathname]);

  // Live reachability check, so the dot reflects "is CUCM up right now", not "was it ever verified".
  const axlConfigured = !!summary?.axl;
  useEffect(() => {
    if (!axlConfigured) {
      setAxlLive(null);
      return;
    }
    let cancelled = false;
    setAxlLive(null); // show "checking…" while we ping
    api
      .get<AxlLive>(`/api/projects/${projectId}/axl/status`)
      .then((r) => !cancelled && setAxlLive(r))
      .catch(() => !cancelled && setAxlLive({ configured: true, connected: false, error: "status check failed" }));
    return () => {
      cancelled = true;
    };
  }, [projectId, pathname, axlConfigured]);

  if (!summary) return null;
  const total = Object.values(summary.counts).reduce((a, b) => a + b, 0);
  const mapTotals = { green: 0, amber: 0, red: 0 };
  for (const m of summary.mappings) mapTotals[m.confidence as "green" | "amber" | "red"] += m.n;
  const selected = (summary.mappingsByType ?? []).reduce((a, m) => a + (m.selected ?? 0), 0);
  const latestBatch = summary.batches[0];

  const Row = ({ label, dot, value, pop }: { label: string; dot: string; value: string; pop?: { title: string; rows: [string, string][] } }) => (
    <div className="pipe-row">
      <span className="pipe-label">{label}</span>
      <span className="pipe-value">
        <span>{value}</span>
        <span className={`pipe-dot ${dot}`} />
      </span>
      {pop && (
        <div className="pipe-pop">
          <div className="pipe-pop-head">{pop.title}</div>
          <div className="pipe-pop-body">
            {pop.rows.map(([k, v], i) => (
              <div className="pipe-pop-row" key={i}>
                <span className="k">{k}</span>
                <span className="v">{v}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );

  const countRows: [string, string][] = Object.entries(summary.counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => [k.replace(/_/g, " "), String(n)]);
  const byType: [string, string][] = (summary.mappingsByType ?? []).map((m) => [m.target_type.replace(/_/g, " "), `${m.selected ?? 0} / ${m.n}`]);
  const lastIngest = summary.snapshots[0];

  return (
    <div className="pipeline">
      <div className="nav-section">Pipeline</div>
      <Row
        label="Source"
        dot={total > 0 ? "green" : "grey"}
        value={total > 0 ? `${total} objects` : "none"}
        pop={{
          title: "Source data",
          rows: [
            ...countRows,
            ...(lastIngest ? ([["last ingest", new Date(lastIngest.created_at + "Z").toLocaleString()]] as [string, string][]) : []),
          ],
        }}
      />
      <Row
        label="CUCM (AXL)"
        dot={!summary.axl ? "grey" : axlLive === null ? "amber" : axlLive.connected ? "green" : "red"}
        value={
          !summary.axl
            ? "not linked"
            : axlLive === null
              ? "checking…"
              : axlLive.connected
                ? `CUCM ${axlLive.cucmVersion ?? summary.axl.cucm_version ?? ""}`
                : "unreachable"
        }
        pop={
          summary.axl
            ? {
                title: "CUCM via AXL",
                rows: [
                  ["endpoint", summary.axl.base_url],
                  ["username", summary.axl.username],
                  ["version", (axlLive?.connected ? axlLive.cucmVersion : summary.axl.cucm_version) ?? "—"],
                  axlLive === null
                    ? (["live check", "pinging…"] as [string, string])
                    : axlLive.connected
                      ? (["live check", `reachable · ${axlLive.checkedAt ? new Date(axlLive.checkedAt).toLocaleTimeString() : "now"}`] as [string, string])
                      : (["live check", `unreachable — ${(axlLive.error ?? "no response").slice(0, 80)}`] as [string, string]),
                  ["last verified", summary.axl.verified_at ? new Date(summary.axl.verified_at).toLocaleString() : "not yet"],
                ],
              }
            : { title: "CUCM via AXL", rows: [["status", "not configured — see Source"]] }
        }
      />
      <Row
        label="Unity (CUPI)"
        dot={summary.unity?.verified_at ? "green" : summary.unity ? "amber" : "grey"}
        value={summary.unity?.verified_at ? `Unity ${summary.unity.unity_version ?? ""}` : summary.unity ? "unverified" : "not linked"}
        pop={
          summary.unity
            ? {
                title: "Unity via CUPI",
                rows: [
                  ["endpoint", summary.unity.base_url],
                  ["version", summary.unity.unity_version ?? "—"],
                  ["mailboxes", String(summary.counts.vm_boxes ?? 0)],
                  ["greetings", String(summary.counts.vm_greetings ?? 0)],
                  ["verified", summary.unity.verified_at ? new Date(summary.unity.verified_at).toLocaleString() : "not yet"],
                ],
              }
            : { title: "Unity via CUPI", rows: [["status", "not configured — see Source"]] }
        }
      />
      <Row
        label="Mappings"
        dot={mapTotals.red > 0 ? "red" : mapTotals.amber > 0 ? "amber" : mapTotals.green > 0 ? "green" : "grey"}
        value={mapTotals.green + mapTotals.amber + mapTotals.red > 0 ? `${mapTotals.green}✓ ${mapTotals.amber}! ${mapTotals.red}✗` : "none"}
        pop={{
          title: "Mapping readiness",
          rows: [
            ["ready", String(mapTotals.green)],
            ["needs review", String(mapTotals.amber)],
            ["blocked", String(mapTotals.red)],
          ],
        }}
      />
      <Row
        label="Selected"
        dot={selected > 0 ? "blue" : "grey"}
        value={String(selected)}
        pop={{ title: "Selected for migration (by type)", rows: byType.length ? byType : [["status", "nothing mapped yet"]] }}
      />
      <Row
        label="Webex"
        dot={summary.webex ? "green" : "grey"}
        value={summary.webex ? (summary.webex.org_name && !summary.webex.org_name.startsWith("Y2lzY29zcGFyaz") ? summary.webex.org_name : "connected") : "not linked"}
        pop={
          summary.webex
            ? {
                title: "Webex organisation",
                rows: [
                  ["org", summary.webex.org_name && !summary.webex.org_name.startsWith("Y2lzY29zcGFyaz") ? summary.webex.org_name : "connected"],
                  ["token expires", new Date(summary.webex.expires_at).toLocaleString()],
                  ["connected", new Date(summary.webex.updated_at + "Z").toLocaleString()],
                ],
              }
            : { title: "Webex organisation", rows: [["status", "not connected — see Webex stage"]] }
        }
      />
      <Row
        label="Last batch"
        dot={latestBatch ? (latestBatch.status === "pushed" ? "green" : latestBatch.status === "failed" ? "red" : latestBatch.status.includes("roll") ? "grey" : "blue") : "grey"}
        value={latestBatch ? latestBatch.status.replace(/_/g, " ") : "none"}
        pop={{
          title: "Recent batches",
          rows: summary.batches.length
            ? summary.batches.slice(0, 5).map((b): [string, string] => [b.name, b.status.replace(/_/g, " ")])
            : [["status", "no batches yet"]],
        }}
      />
    </div>
  );
}

function Sidebar() {
  const location = useLocation();
  const projectMatch = location.pathname.match(/^\/projects\/([^/]+)/);
  const projectId = projectMatch?.[1];

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-name">
          webex<span className="accent">migrate</span>
        </div>
        <div className="brand-sub">CUCM → Webex Calling</div>
      </div>
      <nav className="nav">
        <div className="nav-section">Workspace</div>
        <NavLink to="/" end>
          ⌂ Projects
        </NavLink>
        {projectId && (
          <>
            <div className="nav-section">Reference</div>
            <NavLink to={`/projects/${projectId}/dialplan`}>☎ Dial plan</NavLink>
          </>
        )}
      </nav>
      {projectId && <PipelinePanel projectId={projectId} pathname={location.pathname} />}
      <div className="sidebar-foot" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span>Workers · D1 · R2</span>
        <ThemeToggle />
      </div>
    </aside>
  );
}

function ProjectShell() {
  const { projectId } = useParams<{ projectId: string }>();
  const location = useLocation();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    api
      .get<Summary>(`/api/projects/${projectId}/summary`)
      .then(setSummary)
      .catch((e) => setError(e.message));
  }, [projectId]);

  useEffect(reload, [reload, location.pathname]);

  if (error)
    return (
      <div className="content">
        <div className="alert error">{error}</div>
        <Link to="/" className="btn">
          ← Back to projects
        </Link>
      </div>
    );
  if (!summary)
    return (
      <div className="content">
        <span className="spinner" /> Loading project…
      </div>
    );

  const base = `/projects/${projectId}`;
  return (
    <>
      <div className="topbar">
        <Link to="/" className="crumb">
          Projects
        </Link>
        <span className="crumb-sep">/</span>
        <span className="crumb-here">{summary.project.name}</span>
        {summary.project.customer && <span className="crumb dim">· {summary.project.customer}</span>}
        <div className="topbar-spacer" />
        <span className="crumb">{summary.webex ? `Webex: ${summary.webex.org_name ?? "connected"}` : "Webex not connected"}</span>
      </div>
      <div className="content">
        <nav className="stages">
          {STAGES.map((s) => (
            <NavLink key={s.path} to={s.path === "" ? base : `${base}/${s.path}`} end={s.path === ""} className={({ isActive }) => `stage${isActive ? " active" : ""}`}>
              <span className="stage-step">{s.step}</span>
              <span className="stage-name">{s.name}</span>
            </NavLink>
          ))}
        </nav>
        <Outlet context={{ summary, reload } satisfies ProjectContext} />
      </div>
    </>
  );
}

export default function App() {
  const [unlocked, setUnlocked] = useState<boolean | null>(null);

  useEffect(() => {
    api
      .get<{ ok: boolean }>("/api/pin/status")
      .then((r) => setUnlocked(r.ok))
      .catch(() => setUnlocked(false));
  }, []);

  if (unlocked === null)
    return (
      <div className="landing">
        <span className="spinner" />
      </div>
    );
  if (!unlocked) return <Landing onUnlocked={() => setUnlocked(true)} />;

  return (
    <BrowserRouter>
      <div className="frame">
        <Sidebar />
        <div className="main">
          <Routes>
            <Route
              path="/"
              element={
                <>
                  <div className="topbar">
                    <span className="crumb-here">Projects</span>
                  </div>
                  <div className="content">
                    <ProjectsPage />
                  </div>
                </>
              }
            />
            <Route path="/projects/:projectId" element={<ProjectShell />}>
              <Route index element={<OverviewPage />} />
              <Route path="source" element={<SourcePage />} />
              <Route path="review" element={<ReviewPage />} />
              <Route path="dialplan" element={<DialPlanPage />} />
              <Route path="webex" element={<WebexPage />} />
              <Route path="push" element={<PushPage />} />
              <Route path="reports" element={<ReportsPage />} />
            </Route>
          </Routes>
        </div>
      </div>
    </BrowserRouter>
  );
}
