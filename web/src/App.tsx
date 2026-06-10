import { useEffect, useState } from "react";

type Health = { ok: boolean; d1: boolean; r2: boolean; time: string };

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json() as Promise<Health>)
      .then(setHealth)
      .catch((e) => setError(String(e)));
  }, []);

  return (
    <main style={{ fontFamily: "system-ui", margin: "4rem auto", maxWidth: 480 }}>
      <h1>Webex Migration Tool</h1>
      <p>CUCM / Unity Connection → Webex Calling</p>
      {error && <p style={{ color: "crimson" }}>Health check failed: {error}</p>}
      {!health && !error && <p>Checking health…</p>}
      {health && (
        <ul style={{ listStyle: "none", padding: 0 }}>
          <li>Worker: {health.ok ? "✅ ok" : "❌ degraded"}</li>
          <li>D1: {health.d1 ? "✅ connected" : "❌ unavailable"}</li>
          <li>R2: {health.r2 ? "✅ connected" : "❌ unavailable"}</li>
          <li>Server time: {health.time}</li>
        </ul>
      )}
    </main>
  );
}
