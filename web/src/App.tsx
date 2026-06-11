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
