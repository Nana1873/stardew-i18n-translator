import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { logFrontendError } from "./tauri/commands";
import "./styles.css";

// Funnel otherwise-uncaught errors into the backend log file (Data/logs, v1.1.1)
// so they survive into a bug report. Both handlers are best-effort.
window.addEventListener("error", (event) => {
  const error = event.error;
  logFrontendError(
    "uncaught error",
    error instanceof Error
      ? `${error.message}\n${error.stack ?? ""}`
      : String(event.message),
  );
});
window.addEventListener("unhandledrejection", (event) => {
  logFrontendError("unhandled rejection", String(event.reason));
});

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root element #root not found");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
