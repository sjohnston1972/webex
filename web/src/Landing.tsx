import { FormEvent, useState } from "react";
import { api } from "./api";
import { Spinner } from "./components";

export function Landing({ onUnlocked }: { onUnlocked: () => void }) {
  const [pinValue, setPinValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/pin", { pin: pinValue });
      onUnlocked();
    } catch {
      setError("Incorrect PIN");
      setPinValue("");
      setBusy(false);
    }
  };

  return (
    <div className="landing">
      <div className="landing-card">
        <div className="landing-brand">
          webex<span className="accent">migrate</span>
        </div>
        <p className="landing-tag">
          Move Cisco CUCM &amp; Unity Connection to Webex Calling — pull live config over AXL, review every mapping, dry-run against your
          org, push with full rollback.
        </p>
        <ul className="landing-points">
          <li>Live AXL pull: users, phones, hunt groups, pickup, full route plan</li>
          <li>Deterministic readiness checks with AI-assisted remediation</li>
          <li>Traffic-light dry runs, idempotent push, one-click rollback</li>
        </ul>
        <form onSubmit={submit}>
          <div className="field">
            <label>Access PIN</label>
            <input
              className="pin-input"
              type="password"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={pinValue}
              onChange={(e) => setPinValue(e.target.value.replace(/\D/g, ""))}
              autoFocus
              placeholder="••••••"
            />
          </div>
          {error && <div className="alert error">{error}</div>}
          <button className="btn primary" style={{ width: "100%", justifyContent: "center" }} disabled={busy || pinValue.length < 6}>
            {busy ? <Spinner /> : "Enter"}
          </button>
        </form>
        <div className="landing-foot">Cloudflare Workers · D1 · R2 · Workers AI</div>
      </div>
    </div>
  );
}
