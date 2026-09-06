import { useEffect, useRef, useState } from "react";
import { nexusSaveKey, nexusStatus, type NexusStatus } from "../tauri/commands";
import { NexusAccountSummary } from "./NexusAccountSummary";

export function NexusSetup({ onKeySaved }: { onKeySaved?: () => void }) {
  const [status, setStatus] = useState<NexusStatus | null>(null);
  const [editingKey, setEditingKey] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    alive.current = true;
    let active = true;
    const stamp = generation.current;
    nexusStatus()
      .then((value) => {
        if (active && generation.current === stamp) setStatus(value);
      })
      .catch(() => {
        if (active && generation.current === stamp)
          setError(
            "Connection details unavailable. You can still connect a key.",
          );
      });
    return () => {
      active = false;
      alive.current = false;
    };
  }, []);
  async function connect() {
    if (!key.trim() || busy) return;
    generation.current++;
    setBusy(true);
    setError(null);
    try {
      const next = await nexusSaveKey(key.trim());
      if (!alive.current) return;
      setStatus(next);
      setKey("");
      setEditingKey(false);
      onKeySaved?.();
    } catch {
      if (alive.current)
        setError(
          "Could not connect. Check your key and connection; your previous key is kept.",
        );
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function refreshAccount() {
    generation.current++;
    setBusy(true);
    setError(null);
    try {
      const next = await nexusStatus(true);
      if (alive.current) setStatus(next);
    } catch {
      if (alive.current)
        setError("Could not refresh account details. Try again later.");
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section className="nexus-setup" aria-label="Optional Nexus setup">
      <h3>Nexus Mods · optional</h3>
      <p>
        Use Find translations on Nexus when you want to search. Scanning mods
        never contacts Nexus; your translation text stays on this computer.
      </p>
      <NexusAccountSummary status={status} />
      <p>
        Search works with Free and Premium accounts. Direct ZIP import requires
        Premium; Free users download through the Nexus website. Vortex uses its
        own account.
      </p>
      {editingKey ? (
        <>
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
          <small>
            Use your personal API key from Nexus account settings. It stays with
            your Windows user and is never shown here.
          </small>
          <div className="nexus-actions">
            <button
              type="button"
              className="translator-button translator-button-primary"
              disabled={busy || !key.trim()}
              onClick={() => void connect()}
            >
              {busy ? "Connecting…" : "Connect key"}
            </button>
            <button
              type="button"
              className="translator-button translator-button-quiet"
              disabled={busy}
              onClick={() => {
                setKey("");
                setEditingKey(false);
              }}
            >
              Cancel
            </button>
          </div>
        </>
      ) : (
        <div className="nexus-actions">
          <button
            type="button"
            className="translator-button translator-button-quiet"
            disabled={busy}
            onClick={() => setEditingKey(true)}
          >
            {status?.configured ? "Replace key" : "Connect Nexus"}
          </button>
          {status?.configured && (
            <button
              type="button"
              className="translator-button translator-button-quiet"
              disabled={busy}
              onClick={() => void refreshAccount()}
            >
              {busy ? "Refreshing…" : "Refresh account"}
            </button>
          )}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
