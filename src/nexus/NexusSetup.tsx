import { useEffect, useState } from "react";
import {
  nexusSaveKey,
  nexusStatus,
  pickVortexExecutable,
  type NexusStatus,
} from "../tauri/commands";

export function NexusSetup({
  searchOnScan,
  onSearchOnScanChange,
  onKeySaved,
  vortexExecutable,
  onVortexExecutableChange,
}: {
  searchOnScan: boolean;
  onSearchOnScanChange: (value: boolean) => void;
  onKeySaved?: () => void;
  vortexExecutable?: string | null;
  onVortexExecutableChange?: (value: string | null) => void;
}) {
  const [status, setStatus] = useState<NexusStatus | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    nexusStatus()
      .then((value) => {
        if (active) setStatus(value);
      })
      .catch(() => {
        if (active) setError("Nexus status unavailable. You can retry below.");
      });
    return () => {
      active = false;
    };
  }, []);
  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const next = key.trim()
        ? await nexusSaveKey(key.trim())
        : await nexusStatus(true);
      setStatus(next);
      if (key.trim()) {
        setKey("");
        onKeySaved?.();
      }
    } catch {
      // Never display or log a credential-bearing native failure.
      setError(
        "Could not validate Nexus access. Check your key and connection, then retry.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="nexus-setup" aria-label="Optional Nexus setup">
      <h3>Nexus Mods · optional</h3>
      <label className="wizard__field">
        <span>Vortex executable</span>
        <input
          readOnly
          value={vortexExecutable ?? ""}
          placeholder="Select Vortex.exe"
        />
      </label>
      <button
        className="translator-button translator-button-quiet"
        type="button"
        disabled={busy || !onVortexExecutableChange}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const selected = await pickVortexExecutable();
            if (selected) onVortexExecutableChange?.(selected);
          } catch {
            setError(
              "Could not select Vortex.exe. Choose an existing Vortex executable.",
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        Choose Vortex.exe
      </button>
      <p>
        Vortex uses its own Nexus account. Save these settings to enable
        handoff; this app cannot verify Vortex login, downloads or deployment.
      </p>
      <p>
        Find possible existing translations for your scanned mods. Search sends
        Nexus mod IDs and the target language; local translation text stays on
        your computer.
      </p>
      <p role="status">
        {status?.configured
          ? `NEXUS_API_KEY configured · ${!status.validated ? "Not tested yet" : status.premium ? "Premium: direct ZIP downloads available" : "No Premium: open Nexus for manual downloads; in-app ZIP import requires Premium"}`
          : "No Nexus key configured. You can skip this and configure it later in Settings."}
      </p>
      <label className="wizard__field">
        <span>Nexus API key</span>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={key}
          disabled={busy}
          onChange={(event) => setKey(event.target.value)}
        />
      </label>
      <p>
        A validated key is stored in this Windows user's NEXUS_API_KEY
        environment variable, outside portable app data.
      </p>
      <button
        type="button"
        className="translator-button translator-button-quiet"
        disabled={busy}
        onClick={() => void connect()}
      >
        {busy
          ? "Checking…"
          : key.trim()
            ? "Validate and save key"
            : "Test existing key"}
      </button>
      {error && <p role="alert">{error}</p>}
      <label className="nexus-checkbox">
        <input
          type="checkbox"
          checked={searchOnScan}
          onChange={(event) => onSearchOnScanChange(event.target.checked)}
        />{" "}
        Search Nexus for existing translations when scanning
      </label>
    </section>
  );
}
