import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { logFrontendError } from "./tauri/commands";
import "./styles.css";
import "./translator.css";
import "./translator-overrides.css";
import "./desktop.css";

// Funnel otherwise-uncaught errors into the portable backend log file
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

function render(): void {
  createRoot(container!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

// `corepack pnpm dev:preview` runs the UI in a plain browser tab on synthetic
// fixtures (see src/tauri/previewBridge.ts). The gate is compile-time dead in
// production builds, so released screens never show demo data.
if (
  import.meta.env.DEV &&
  import.meta.env.MODE === "preview" &&
  !("__TAURI_INTERNALS__" in window)
) {
  void import("./tauri/previewBridge")
    .then(({ installPreviewBridge }) => installPreviewBridge())
    .catch((error) =>
      console.error("[preview] Could not load the browser preview:", error),
    )
    .finally(render);
} else {
  render();
}
