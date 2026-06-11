import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

// Apply the saved theme before first paint (covers the landing page too).
const savedTheme = localStorage.getItem("wx-theme");
if (savedTheme === "dark") document.documentElement.dataset.theme = "dark";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
