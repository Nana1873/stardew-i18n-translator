import { useEffect, useState } from "react";
import { openUrl } from "../tauri/commands";
import {
  paraTranzConnect,
  paraTranzConnection,
  paraTranzDisconnect,
  type ParaTranzConnection,
} from "./commands";

export function ParaTranzSettings({
  active,
  projectId,
  onProjectId,
}: {
  active: boolean;
  projectId: number | null;
  onProjectId: (id: number | null) => void;
}) {
  const [token, setToken] = useState("");
  const [connection, setConnection] = useState<ParaTranzConnection | null>(
    null,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    let current = true;
    void paraTranzConnection()
      .then((value) => {
        if (current) setConnection(value);
      })
      .catch((cause) => {
        if (current) setError(String(cause));
      });
    return () => {
      current = false;
    };
  }, [active]);
  async function connect() {
    setPending(true);
    setError(null);
    try {
      setConnection(await paraTranzConnect(projectId ?? 0, token));
      setToken("");
    } catch (cause) {
      setError(String(cause));
    } finally {
      setPending(false);
    }
  }
  async function disconnect() {
    setPending(true);
    setError(null);
    try {
      await paraTranzDisconnect();
      setConnection(null);
      setToken("");
    } catch (cause) {
      setError(String(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <section
      id="settings-panel-paratranz"
      className={"translator-settings-page" + (active ? " is-active" : "")}
      role="tabpanel"
      aria-label="ParaTranz"
      hidden={!active}
    >
      <h3>ParaTranz</h3>
      <p>
        Optional collaboration. Connect an English-source project for your
        current target language. Choose ParaTranz in Workspace to upload sources
        or pull translations.
      </p>
      <div className="paratranz-fields">
        <label>
          Project ID
          <input
            type="number"
            min="1"
            step="1"
            aria-label="ParaTranz project ID"
            value={projectId ?? ""}
            disabled={pending}
            onChange={(event) => {
              onProjectId(
                event.target.value ? Number(event.target.value) : null,
              );
              setError(null);
            }}
          />
        </label>
        <label>
          API token
          <input
            type="password"
            autoComplete="off"
            aria-label="ParaTranz API token"
            value={token}
            disabled={pending}
            onChange={(event) => setToken(event.target.value)}
          />
        </label>
      </div>
      <p>
        The token is kept only for this app session. Enter it again after
        restarting. Find it in your ParaTranz profile settings.
      </p>
      <div className="paratranz-actions">
        <button
          type="button"
          className="translator-button"
          disabled={
            pending ||
            !Number.isSafeInteger(projectId) ||
            !projectId ||
            !token.trim()
          }
          onClick={() => void connect()}
        >
          {pending ? "Connecting…" : "Connect ParaTranz"}
        </button>
        <button
          type="button"
          className="translator-button translator-button-quiet"
          disabled={pending || !connection}
          onClick={() => void disconnect()}
        >
          Disconnect ParaTranz
        </button>
        <button
          type="button"
          className="translator-button translator-button-quiet"
          onClick={() => void openUrl("https://paratranz.cn/users/my")}
        >
          Open ParaTranz profile
        </button>
      </div>
      {connection && (
        <p role="status">
          Connected: {connection.project.name} · {connection.project.source} →{" "}
          {connection.project.dest} ·{" "}
          {connection.project.privacy === 2 ? "Private" : "Public or internal"}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="translator-flow-callout">
        Uploads send the selected component's English text to ParaTranz. Local
        translations are never uploaded. Pulled text enters Review; export into
        Mods remains a separate action.
      </div>
    </section>
  );
}
