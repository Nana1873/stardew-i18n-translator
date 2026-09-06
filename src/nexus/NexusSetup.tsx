import { useEffect, useRef, useState } from "react";
import { nexusSaveKey, nexusStatus, type NexusStatus } from "../tauri/commands";
import { NexusAccountSummary } from "./NexusAccountSummary";

export function useNexusSetup(onKeySaved?: () => void) {
  const [status, setStatus] = useState<NexusStatus | null>(null);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(false);
  const generation = useRef(0);
  const saving = useRef(false);
  useEffect(() => {
    alive.current = true;
    let active = true;
    const stamp = generation.current;
    nexusStatus()
      .then((value) => {
        if (active && generation.current === stamp) setStatus(value);
      })
      .catch(() => {});
    return () => {
      active = false;
      alive.current = false;
    };
  }, []);
  async function save() {
    if (saving.current) return false;
    if (!key.trim()) return true;
    saving.current = true;
    generation.current++;
    setError(null);
    try {
      const next = await nexusSaveKey(key.trim());
      if (!alive.current) return false;
      setStatus(next);
      setKey("");
      onKeySaved?.();
      return true;
    } catch {
      if (alive.current)
        setError(
          "Could not save the key. Check your key and connection; the previous key is kept.",
        );
      return false;
    } finally {
      saving.current = false;
    }
  }
  return { status, key, setKey, error, save };
}

export function NexusSetup({
  connection,
  disabled = false,
}: {
  connection: ReturnType<typeof useNexusSetup>;
  disabled?: boolean;
}) {
  return (
    <section className="nexus-setup" aria-label="Optional Nexus setup">
      <h3>Nexus Mods · optional</h3>
      <label className="wizard__field">
        <span>Nexus API key</span>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={
            connection.status?.configured ? "••••••••" : "Enter API key"
          }
          value={connection.key}
          disabled={disabled}
          onChange={(event) => connection.setKey(event.target.value)}
        />
      </label>
      <NexusAccountSummary status={connection.status} />
      {connection.error && <p role="alert">{connection.error}</p>}
    </section>
  );
}
