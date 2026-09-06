import { useEffect, useRef, useState } from "react";
import {
  detectVortexExecutable,
  pickVortexExecutable,
  type AppSettings,
} from "../tauri/commands";

export function installationMethodFor(
  settings: Pick<AppSettings, "installationMethod" | "vortexExecutable"> | null,
) {
  return (
    settings?.installationMethod ??
    (settings?.vortexExecutable?.trim() ? "vortex" : "folder")
  );
}

export function InstallationSettings({
  method,
  onMethodChange,
  executable,
  onExecutableChange,
  disabled = false,
  active = true,
  compact = false,
}: {
  method: "folder" | "vortex";
  onMethodChange: (method: "folder" | "vortex") => void;
  executable: string | null;
  onExecutableChange: (value: string) => void;
  disabled?: boolean;
  active?: boolean;
  compact?: boolean;
}) {
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const detectionAttempted = useRef(false);
  const [detecting, setDetecting] = useState(false);
  useEffect(() => {
    generation.current++;
    setPicking(false);
    setDetecting(false);
    setError(null);
    return () => {
      generation.current++;
    };
  }, [method, active, disabled, executable]);
  useEffect(() => {
    let cancelled = false;
    setDetecting(false);
    if (method !== "vortex" || !active || disabled || executable?.trim())
      return;
    const stamp = generation.current;
    // Defer starting so StrictMode's discarded effect cannot consume the attempt.
    void Promise.resolve().then(async () => {
      if (cancelled || detectionAttempted.current) return;
      detectionAttempted.current = true;
      setDetecting(true);
      try {
        const detected = await detectVortexExecutable();
        if (
          !cancelled &&
          stamp === generation.current &&
          typeof detected === "string" &&
          detected.trim()
        )
          onExecutableChange(detected);
      } catch {
        // Manual selection remains available when local detection is unavailable.
      } finally {
        if (!cancelled && stamp === generation.current) setDetecting(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [method, active, disabled, executable]);
  async function choose() {
    const stamp = ++generation.current;
    detectionAttempted.current = true;
    setDetecting(false);
    setPicking(true);
    setError(null);
    try {
      const selected = await pickVortexExecutable();
      if (stamp === generation.current && selected)
        onExecutableChange(selected);
    } catch {
      if (stamp === generation.current)
        setError(
          "Could not select Vortex.exe. Choose an existing Vortex executable.",
        );
    } finally {
      if (stamp === generation.current) setPicking(false);
    }
  }
  const methodSelect = (
    <select
      className={compact ? "translator-select" : undefined}
      aria-label="Installation method"
      value={method}
      disabled={disabled || !active}
      onChange={(event) =>
        onMethodChange(event.target.value as "folder" | "vortex")
      }
    >
      <option value="folder">Manual / no mod manager</option>
      <option value="vortex">Vortex</option>
    </select>
  );
  const browse = (
    <button
      className="translator-button translator-button-quiet"
      type="button"
      aria-label="Choose Vortex.exe"
      disabled={disabled || picking || !active}
      onClick={() => void choose()}
    >
      {picking ? "Choosing…" : compact ? "Change" : "Choose Vortex.exe"}
    </button>
  );
  const feedback = (
    <>
      {!executable?.trim() && (
        <p role="status">
          {detecting
            ? "Looking for Vortex.exe…"
            : "Choose Vortex.exe if it was not found automatically."}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </>
  );
  if (compact)
    return (
      <section aria-label="Installation" className="translator-settings-group">
        <label className="translator-setting-line">
          <span className="translator-setting-copy">
            <strong>Installation method</strong>
          </span>
          {methodSelect}
        </label>
        {method === "vortex" && (
          <div className="translator-setting-line">
            <div className="translator-setting-copy">
              <strong>Vortex executable</strong>
              <span
                className="translator-vortex-path"
                aria-label="Vortex executable"
                title={executable || undefined}
              >
                {executable || "Not selected"}
              </span>
              {feedback}
            </div>
            {browse}
          </div>
        )}
      </section>
    );
  return (
    <section aria-label="Installation">
      <label className="wizard__field">
        <span>Installation method</span>
        {methodSelect}
      </label>
      <p>
        This choice controls how Nexus translations are added in this
        experimental build. Editing and export remain unchanged.
      </p>
      {method === "vortex" && (
        <>
          <label className="wizard__field">
            <span>Vortex executable</span>
            <input
              readOnly
              value={executable ?? ""}
              placeholder="Select Vortex.exe"
            />
          </label>
          {browse}
          {feedback}
        </>
      )}
    </section>
  );
}
