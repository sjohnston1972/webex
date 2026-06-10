import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, Project } from "../api";
import { Alert, Empty, Modal, Pill, Spinner } from "../components";

export function ProjectsPage() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [name, setName] = useState("");
  const [customer, setCustomer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => api.get<Project[]>("/api/projects").then(setProjects).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/projects", { name, customer });
      setShowNew(false);
      setName("");
      setCustomer("");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head toolbar">
        <div>
          <h1 className="page-title">Migration projects</h1>
          <p className="page-desc">Each project tracks one CUCM/Unity environment being moved to Webex Calling.</p>
        </div>
        <div className="grow" />
        <button className="btn primary" onClick={() => setShowNew(true)}>
          + New project
        </button>
      </div>

      {error && <Alert tone="error">{error}</Alert>}
      {!projects ? (
        <Spinner />
      ) : projects.length === 0 ? (
        <Empty glyph="◳">
          No projects yet. Create one to start pulling CUCM config.
        </Empty>
      ) : (
        <div className="projects-grid">
          {projects.map((p) => (
            <Link to={`/projects/${p.id}`} className="project-card" key={p.id}>
              <h3>{p.name}</h3>
              <div className="customer">{p.customer ?? "—"}</div>
              <div className="meta">
                <Pill tone="grey">{p.user_count ?? 0} users</Pill>
                <Pill tone={p.webex_connected ? "green" : "grey"}>{p.webex_connected ? "Webex linked" : "Webex not linked"}</Pill>
                <Pill tone={p.selected_count ? "blue" : "grey"}>{p.selected_count ?? 0} selected</Pill>
              </div>
            </Link>
          ))}
        </div>
      )}

      {showNew && (
        <Modal title="New migration project" onClose={() => setShowNew(false)}>
          <form onSubmit={create}>
            <div className="field">
              <label>Project name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Acme HQ cutover" autoFocus required />
            </div>
            <div className="field">
              <label>Customer (optional)</label>
              <input value={customer} onChange={(e) => setCustomer(e.target.value)} placeholder="e.g. Acme Ltd" />
            </div>
            <div className="toolbar">
              <div className="grow" />
              <button type="button" className="btn" onClick={() => setShowNew(false)}>
                Cancel
              </button>
              <button type="submit" className="btn primary" disabled={busy || !name.trim()}>
                {busy ? <Spinner /> : "Create project"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
