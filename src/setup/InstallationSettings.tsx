import { useEffect, useRef, useState } from "react";
import { pickVortexExecutable, type AppSettings } from "../tauri/commands";

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
}: {
  method: "folder" | "vortex";
  onMethodChange: (method: "folder" | "vortex") => void;
  executable: string | null;
  onExecutableChange: (value: string) => void;
  disabled?: boolean;
  active?: boolean;
}) {
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setPicking(false);
    setError(null);
    return () => {
      generation.current++;
    };
  }, [method, active, disabled]);
  async function choose() {
    const stamp = generation.current;
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
  return (
    <section aria-label="Installation">
      <label className="wizard__field">
        <span>Installation method</span>
        <select
          value={method}
          disabled={disabled}
          onChange={(event) =>
            onMethodChange(event.target.value as "folder" | "vortex")
          }
        >
          <option value="folder">Manual / no mod manager</option>
          <option value="vortex">Vortex</option>
        </select>
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
          <button
            className="translator-button translator-button-quiet"
            type="button"
            disabled={disabled || picking || !active}
            onClick={() => void choose()}
          >
            {picking ? "Choosing…" : "Choose Vortex.exe"}
          </button>
          <p role="status">
            {executable?.trim()
              ? "Vortex uses its own Nexus account. Save to use this selection."
              : "Choose Vortex.exe before sending translations to Vortex. You can save now and continue working offline."}
          </p>
          {error && <p role="alert">{error}</p>}
        </>
      )}
    </section>
  );
}
