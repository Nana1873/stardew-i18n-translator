/**
 * Application shell — Milestone 1.
 *
 * Toolbar + two-panel layout (SPEC §7.3), plus the Setup Wizard which opens
 * on first launch (no saved Stardew path) and is re-openable via Settings.
 * The mod list and string table are still placeholders — wired up in later
 * M1/M2 issues. Kept flat per SCOPE_GUARDRAILS (2 panels + toolbar).
 */
import { useEffect, useState } from "react";
import { type AppSettings, loadSettings, saveSettings } from "./tauri/commands";
import { SetupWizard } from "./setup/SetupWizard";

export function App() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    loadSettings()
      .then((loadedSettings) => {
        if (!active) return;
        setSettings(loadedSettings);
        setWizardOpen(!loadedSettings.stardewPath);
      })
      .catch(() => {
        // No backend / first run — show the wizard so the user can configure.
        if (active) setWizardOpen(true);
      })
      .finally(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, []);

  async function handleComplete(next: AppSettings) {
    try {
      await saveSettings(next);
    } catch {
      /* keep the in-memory settings even if persistence fails */
    }
    setSettings(next);
    setWizardOpen(false);
  }

  const configured = Boolean(settings?.stardewPath);

  return (
    <div className="app">
      <Toolbar onOpenSettings={() => setWizardOpen(true)} settingsEnabled={loaded} />
      <main className="workspace">
        <ModListPanel />
        <StringTablePanel />
      </main>
      {wizardOpen && (
        <SetupWizard
          initial={settings}
          onComplete={handleComplete}
          onCancel={configured ? () => setWizardOpen(false) : undefined}
        />
      )}
    </div>
  );
}

function Toolbar({
  onOpenSettings,
  settingsEnabled,
}: {
  onOpenSettings: () => void;
  settingsEnabled: boolean;
}) {
  return (
    <header className="toolbar" role="banner">
      <span className="toolbar__title">Stardew i18n Translator</span>
      <div className="toolbar__actions">
        {/* Scan/Export are enabled by their own M1–M3 issues. */}
        <button type="button" disabled>
          Scan
        </button>
        <button type="button" disabled>
          Export
        </button>
        <button type="button" onClick={onOpenSettings} disabled={!settingsEnabled}>
          Settings
        </button>
      </div>
      <input
        className="toolbar__search"
        type="search"
        placeholder="Search…"
        aria-label="Search strings"
        disabled
      />
    </header>
  );
}

function ModListPanel() {
  return (
    <section className="panel panel--mods" aria-label="Mod list">
      <div className="panel__header">Mods</div>
      <div className="panel__empty">No mods scanned yet.</div>
    </section>
  );
}

function StringTablePanel() {
  return (
    <section className="panel panel--strings" aria-label="String table">
      <div className="panel__header">Strings</div>
      <div className="panel__empty">Select a mod to view its strings.</div>
    </section>
  );
}
