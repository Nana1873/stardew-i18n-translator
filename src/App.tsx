/**
 * Application shell — Milestone 1.
 *
 * Toolbar + two-panel layout (SPEC §7.3): left = mod list tree, right = string
 * table (still a placeholder until M2). The Setup Wizard opens on first launch
 * and via Settings. Scan runs the Rust scanner and fills the tree.
 */
import { type MouseEvent as ReactMouseEvent, useEffect, useState } from "react";
import {
  type AppSettings,
  type ScanResult,
  type ScannedMod,
  loadSettings,
  saveSettings,
  scanMods,
} from "./tauri/commands";
import { SetupWizard } from "./setup/SetupWizard";
import { ModList } from "./mods/ModList";

export function App() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const [scan, setScan] = useState<ScanResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [selectedModId, setSelectedModId] = useState<string | null>(null);
  const [modsWidth, setModsWidth] = useState(460);

  function startResize(event: ReactMouseEvent) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = modsWidth;
    const onMove = (move: MouseEvent) => {
      const next = startWidth + (move.clientX - startX);
      setModsWidth(Math.min(900, Math.max(300, next)));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  useEffect(() => {
    let active = true;
    loadSettings()
      .then((loadedSettings) => {
        if (!active) return;
        setSettings(loadedSettings);
        setWizardOpen(!loadedSettings.stardewPath);
      })
      .catch(() => {
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
      /* keep in-memory settings even if persistence fails */
    }
    setSettings(next);
    setWizardOpen(false);
  }

  async function handleScan() {
    if (!settings?.modsPath) return;
    setScanning(true);
    setScanError(null);
    setSelectedModId(null);
    try {
      setScan(await scanMods(settings.modsPath, settings.targetLang ?? ""));
    } catch (error) {
      setScanError(String(error));
    } finally {
      setScanning(false);
    }
  }

  const configured = Boolean(settings?.stardewPath);
  const selectedMod = scan?.mods.find((mod) => mod.uniqueId === selectedModId) ?? null;

  return (
    <div className="app">
      <Toolbar
        onScan={handleScan}
        scanEnabled={configured && !scanning}
        scanning={scanning}
        onOpenSettings={() => setWizardOpen(true)}
        settingsEnabled={loaded}
      />
      <main className="workspace">
        <section
          className="panel panel--mods"
          aria-label="Mod list"
          style={{ width: modsWidth, flex: "0 0 auto" }}
        >
          <div className="panel__header">
            Mods{scan ? ` · ${scan.modCount}` : ""}
            {scan && scan.warnings.length > 0 && (
              <span className="panel__warn"> · {scan.warnings.length} skipped</span>
            )}
          </div>
          {scan ? (
            <ModList
              mods={scan.mods}
              selectedId={selectedModId}
              onSelect={setSelectedModId}
            />
          ) : (
            <div className="panel__empty">
              {scanError ?? (scanning ? "Scanning…" : "No mods scanned yet.")}
            </div>
          )}
        </section>
        <div
          className="splitter"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize mod list"
          onMouseDown={startResize}
        />
        <StringTablePanel mod={selectedMod} />
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
  onScan,
  scanEnabled,
  scanning,
  onOpenSettings,
  settingsEnabled,
}: {
  onScan: () => void;
  scanEnabled: boolean;
  scanning: boolean;
  onOpenSettings: () => void;
  settingsEnabled: boolean;
}) {
  return (
    <header className="toolbar" role="banner">
      <span className="toolbar__title">Stardew i18n Translator</span>
      <div className="toolbar__actions">
        <button type="button" onClick={onScan} disabled={!scanEnabled}>
          {scanning ? "Scanning…" : "Scan"}
        </button>
        {/* Export is enabled by its own M3 issue. */}
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

function StringTablePanel({ mod }: { mod: ScannedMod | null }) {
  return (
    <section className="panel panel--strings" aria-label="String table">
      <div className="panel__header">Strings</div>
      {mod ? (
        <div className="panel__selected">
          <h3>{mod.name}</h3>
          <p className="panel__muted">
            {mod.version && <>v{mod.version} · </>}
            {mod.translatedKeys}/{mod.totalKeys} strings translated
            {mod.totalKeys > 0 && <> · {Math.round(mod.progress * 100)}%</>}
          </p>
          <ul className="panel__filelist">
            {mod.i18nFiles.map((file) => (
              <li key={file.relativeDir}>
                <code>{file.relativeDir}/default.json</code>{" "}
                <span className="panel__muted">
                  ({file.translatedKeys}/{file.totalKeys})
                </span>
                {file.targetExists && <span className="panel__ok"> · translation present</span>}
              </li>
            ))}
          </ul>
          <p className="panel__muted">String editing arrives in Milestone 2.</p>
        </div>
      ) : (
        <div className="panel__empty">Select a mod to view its strings.</div>
      )}
    </section>
  );
}
