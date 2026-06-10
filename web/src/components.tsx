import { ReactNode } from "react";

export function Pill({ tone, children }: { tone: string; children: ReactNode }) {
  const cls =
    { green: "green", amber: "amber", red: "red", done: "green", pushed: "green", validated: "blue", failed: "red", pushing: "blue", queued: "blue", pending: "grey", draft: "grey", parsed: "green", parsing: "blue", rolled_back: "grey", rolling_back: "blue", validating: "blue", skipped: "grey", new: "grey" }[
      tone
    ] ?? "grey";
  return <span className={`pill ${cls}`}>{children}</span>;
}

export function Card({ title, sub, actions, children, tight }: { title?: string; sub?: string; actions?: ReactNode; children: ReactNode; tight?: boolean }) {
  return (
    <section className="card">
      {title && (
        <div className="card-head">
          <h2 className="card-title">{title}</h2>
          {sub && <span className="card-sub">{sub}</span>}
          {actions}
        </div>
      )}
      <div className={tight ? "card-body tight" : "card-body"}>{children}</div>
    </section>
  );
}

export function Empty({ glyph, children }: { glyph?: string; children: ReactNode }) {
  return (
    <div className="empty">
      <div className="glyph">{glyph ?? "○"}</div>
      {children}
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" aria-label="loading" />;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="card-head">
          <h2 className="card-title">{title}</h2>
          <button className="btn sm" style={{ marginLeft: "auto" }} onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="card-body">{children}</div>
      </div>
    </div>
  );
}

export function Alert({ tone, children }: { tone: "error" | "ok" | "info"; children: ReactNode }) {
  return <div className={`alert ${tone}`}>{children}</div>;
}
