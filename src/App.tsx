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
  type ExportResult,
  type ScanResult,
  type ScannedMod,
  type StringStatus,
  exportMod,
  loadSettings,
  saveSettings,
  scanMods,
} from "./tauri/commands";
import { SetupWizard } from "./setup/SetupWizard";
import { ModList } from "./mods/ModList";
import { StringTable, StringTableHeader } from "./strings/StringTable";
import { STATUS_META } from "./strings/status";
import { ExportDialog } from "./export/ExportDialog";

export function App() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const [scan, setScan] = useState<ScanResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [selectedModId, setSelectedModId] = useState<string | null>(null);
  const [modsWidth, setModsWidth] = useState(460);

  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StringStatus | "all">("all");

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

  async function handleExport() {
    if (!selectedMod) return;
    setExporting(true);
    setExportResult(null);
    setExportError(null);
    setExportOpen(true);
    try {
      const files = selectedMod.i18nFiles.map((file) => ({
        relativeDir: file.relativeDir,
        defaultPath: file.defaultPath,
        targetPath: file.targetPath,
      }));
      setExportResult(await exportMod(selectedMod.uniqueId, files));
    } catch (error) {
      setExportError(String(error));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="app">
      <Toolbar
        onScan={handleScan}
        scanEnabled={configured && !scanning}
        scanning={scanning}
        onExport={handleExport}
        exportEnabled={Boolean(selectedMod) && !exporting}
        exporting={exporting}
        onOpenSettings={() => setWizardOpen(true)}
        settingsEnabled={loaded}
        search={search}
        onSearch={setSearch}
        statusFilter={statusFilter}
        onStatusFilter={setStatusFilter}
        searchEnabled={Boolean(selectedMod)}
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
        <StringTablePanel mod={selectedMod} search={search} statusFilter={statusFilter} />
      </main>
      {wizardOpen && (
        <SetupWizard
          initial={settings}
          onComplete={handleComplete}
          onCancel={configured ? () => setWizardOpen(false) : undefined}
        />
      )}
      {exportOpen && (
        <ExportDialog
          modName={selectedMod?.name ?? ""}
          result={exporting ? null : exportResult}
          error={exportError}
          onClose={() => setExportOpen(false)}
        />
      )}
    </div>
  );
}

function Toolbar({
  onScan,
  scanEnabled,
  scanning,
  onExport,
  exportEnabled,
  exporting,
  onOpenSettings,
  settingsEnabled,
  search,
  onSearch,
  statusFilter,
  onStatusFilter,
  searchEnabled,
}: {
  onScan: () => void;
  scanEnabled: boolean;
  scanning: boolean;
  onExport: () => void;
  exportEnabled: boolean;
  exporting: boolean;
  onOpenSettings: () => void;
  settingsEnabled: boolean;
  search: string;
  onSearch: (value: string) => void;
  statusFilter: StringStatus | "all";
  onStatusFilter: (value: StringStatus | "all") => void;
  searchEnabled: boolean;
}) {
  return (
    <header className="toolbar" role="banner">
      <span className="toolbar__title">Stardew i18n Translator</span>
      <div className="toolbar__actions">
        <button type="button" onClick={onScan} disabled={!scanEnabled}>
          {scanning ? "Scanning…" : "Scan"}
        </button>
        <button
          type="button"
          onClick={onExport}
          disabled={!exportEnabled}
          title="Export the selected mod's translations to i18n/<lang>.json"
        >
          {exporting ? "Exporting…" : "Export"}
        </button>
        <button type="button" onClick={onOpenSettings} disabled={!settingsEnabled}>
          Settings
        </button>
      </div>
      <div className="toolbar__filters">
        <select
          className="toolbar__statusfilter"
          aria-label="Filter by status"
          value={statusFilter}
          onChange={(event) => onStatusFilter(event.target.value as StringStatus | "all")}
          disabled={!searchEnabled}
        >
          <option value="all">All statuses</option>
          {(Object.keys(STATUS_META) as StringStatus[]).map((status) => (
            <option key={status} value={status}>
              {STATUS_META[status].label}
            </option>
          ))}
        </select>
        <input
          className="toolbar__search"
          type="search"
          placeholder="Search…"
          aria-label="Search strings"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          disabled={!searchEnabled}
        />
      </div>
    </header>
  );
}

function StringTablePanel({
  mod,
  search,
  statusFilter,
}: {
  mod: ScannedMod | null;
  search: string;
  statusFilter: StringStatus | "all";
}) {
  return (
    <section className="panel panel--strings" aria-label="String table">
      <div className="panel__header">
        Strings{mod && <> · <StringTableHeader mod={mod} /></>}
      </div>
      {mod ? (
        <StringTable key={mod.uniqueId} mod={mod} search={search} statusFilter={statusFilter} />
      ) : (
        <div className="panel__empty">Select a mod to view its strings.</div>
      )}
    </section>
  );
}
