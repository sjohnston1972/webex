import { Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

// Apply the saved theme before first paint (covers the landing page too).
const savedTheme = localStorage.getItem("wx-theme");
if (savedTheme === "dark") document.documentElement.dataset.theme = "dark";

// Last-resort boundary: a render-time throw (e.g. a malformed target_payload
// parsed during a .map) would otherwise unmount the whole app to a blank page.
// This shows a recoverable card with a reload instead.
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ maxWidth: 560, margin: "12vh auto", padding: 24, fontFamily: "system-ui, sans-serif" }}>
        <h1 style={{ fontSize: 18, marginBottom: 8 }}>Something went wrong on this page</h1>
        <p style={{ color: "#6b7680", fontSize: 14, marginBottom: 16 }}>
          The app hit an unexpected error while rendering. Your data is safe — reloading usually clears it.
        </p>
        <pre style={{ background: "#f5f6f7", padding: 12, borderRadius: 8, fontSize: 12, overflowX: "auto" }}>
          {this.state.error.message}
        </pre>
        <button
          onClick={() => { this.setState({ error: null }); location.reload(); }}
          style={{ marginTop: 16, padding: "8px 16px", borderRadius: 8, border: "1px solid #d3d7db", cursor: "pointer" }}
        >
          Reload
        </button>
      </div>
    );
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
