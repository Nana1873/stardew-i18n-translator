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
  loadGlossary,
  loadSettings,
  saveSettings,
  scanMods,
} from "./tauri/commands";
import { SetupWizard } from "./setup/SetupWizard";
import { SettingsDialog } from "./settings/SettingsDialog";
import { ModList } from "./mods/ModList";
import { ScanDialog } from "./mods/ScanDialog";
import { StringTable, StringTableHeader } from "./strings/StringTable";
import { STATUS_META } from "./strings/status";
import { ExportDialog } from "./export/ExportDialog";

export function App() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const [scan, setScan] = useState<ScanResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanDialogOpen, setScanDialogOpen] = useState(false);
  const [selectedModId, setSelectedModId] = useState<string | null>(null);
  const [modQuery, setModQuery] = useState("");
  const [modsWidth, setModsWidth] = useState(460);

  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportTitle, setExportTitle] = useState("");
  const [exportModsWritten, setExportModsWritten] = useState<number | null>(null);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StringStatus | "all">("all");
  const [glossary, setGlossaryTerms] = useState<Record<string, string> | null>(null);

  function refreshGlossary() {
    loadGlossary()
      .then((g) => setGlossaryTerms(g && g.termCount > 0 ? g.terms : null))
      .catch(() => setGlossaryTerms(null));
  }

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
    refreshGlossary();
    return () => {
      active = false;
    };
  }, []);

  async function handleComplete(next: AppSettings) {
    // The wizard does not edit the AI connection — carry the existing one through
    // so re-running setup to change folders never wipes the local-AI config.
    const merged: AppSettings = { ...next, llm: settings?.llm ?? null };
    await persist(merged);
    setWizardOpen(false);
    refreshGlossary(); // the wizard may have just built the glossary
  }

  async function handleSaveSettings(next: AppSettings) {
    await persist(next);
    setSettingsOpen(false);
    refreshGlossary(); // settings may have just built the glossary
  }

  async function persist(next: AppSettings) {
    try {
      await saveSettings(next);
    } catch {
      /* keep in-memory settings even if persistence fails */
    }
    setSettings(next);
  }

  async function handleScan() {
    if (!settings?.modsPath) return;
    setScanning(true);
    setScanError(null);
    setSelectedModId(null);
    setScanDialogOpen(true);
    try {
      const result = await scanMods(settings.modsPath, settings.targetLang ?? "");
      setScan(result);
      // A clean scan auto-closes; keep the dialog open only to review warnings.
      if (result.warnings.length === 0) setScanDialogOpen(false);
    } catch (error) {
      setScanError(String(error));
    } finally {
      setScanning(false);
    }
  }

  const configured = Boolean(settings?.stardewPath);
  const selectedMod = scan?.mods.find((mod) => mod.uniqueId === selectedModId) ?? null;

  function filesOf(mod: ScannedMod) {
    return mod.i18nFiles.map((file) => ({
      relativeDir: file.relativeDir,
      defaultPath: file.defaultPath,
      targetPath: file.targetPath,
    }));
  }

  function beginExport(title: string) {
    setExporting(true);
    setExportResult(null);
    setExportError(null);
    setExportModsWritten(null);
    setExportTitle(title);
    setExportOpen(true);
  }

  async function handleExport() {
    if (!selectedMod) return;
    beginExport(selectedMod.name);
    try {
      setExportResult(await exportMod(selectedMod.uniqueId, filesOf(selectedMod)));
    } catch (error) {
      setExportError(String(error));
    } finally {
      setExporting(false);
    }
  }

  async function handleExportAll() {
    if (!scan) return;
    beginExport("All mods");
    try {
      const merged: ExportResult = {
        files: [],
        skipped: [],
        filesWritten: 0,
        totalWrittenKeys: 0,
        totalUntranslated: 0,
        totalNotTranslatable: 0,
        totalOutdated: 0,
      };
      let modsWritten = 0;
      for (const mod of scan.mods) {
        if (mod.i18nFiles.length === 0) continue;
        const result = await exportMod(mod.uniqueId, filesOf(mod));
        merged.files.push(...result.files);
        // Prefix each skipped key with its mod so the summary stays unambiguous.
        merged.skipped.push(
          ...result.skipped.map((skip) => ({
            ...skip,
            relativeDir: `${mod.name} · ${skip.relativeDir}`,
          })),
        );
        merged.filesWritten += result.filesWritten;
        merged.totalWrittenKeys += result.totalWrittenKeys;
        merged.totalUntranslated += result.totalUntranslated;
        merged.totalNotTranslatable += result.totalNotTranslatable;
        merged.totalOutdated += result.totalOutdated;
        if (result.filesWritten > 0) modsWritten += 1;
      }
      setExportResult(merged);
      setExportModsWritten(modsWritten);
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
        onExportAll={handleExportAll}
        exportAllEnabled={Boolean(scan && scan.mods.length > 0) && !exporting}
        exporting={exporting}
        onOpenSettings={() => (settings ? setSettingsOpen(true) : setWizardOpen(true))}
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
          {scan && (
            <input
              className="modlist__search"
              type="search"
              placeholder="Filter mods…"
              aria-label="Filter mods"
              value={modQuery}
              onChange={(event) => setModQuery(event.target.value)}
            />
          )}
          {scan ? (
            <ModList
              mods={scan.mods}
              selectedId={selectedModId}
              onSelect={setSelectedModId}
              query={modQuery}
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
        <StringTablePanel
          mod={selectedMod}
          search={search}
          statusFilter={statusFilter}
          glossary={glossary}
        />
      </main>
      {wizardOpen && (
        <SetupWizard
          initial={settings}
          onComplete={handleComplete}
          onCancel={configured ? () => setWizardOpen(false) : undefined}
        />
      )}
      {settingsOpen && settings && (
        <SettingsDialog
          settings={settings}
          onSave={handleSaveSettings}
          onClose={() => setSettingsOpen(false)}
          onReRunSetup={() => {
            setSettingsOpen(false);
            setWizardOpen(true);
          }}
        />
      )}
      {scanDialogOpen && (
        <ScanDialog
          scanning={scanning}
          result={scan}
          error={scanError}
          onClose={() => setScanDialogOpen(false)}
        />
      )}
      {exportOpen && (
        <ExportDialog
          modName={exportTitle}
          modsWritten={exportModsWritten}
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
  onExportAll,
  exportAllEnabled,
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
  onExportAll: () => void;
  exportAllEnabled: boolean;
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
        <button
          type="button"
          onClick={onExportAll}
          disabled={!exportAllEnabled}
          title="Export every scanned mod's translations"
        >
          Export All
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
  glossary,
}: {
  mod: ScannedMod | null;
  search: string;
  statusFilter: StringStatus | "all";
  glossary: Record<string, string> | null;
}) {
  return (
    <section className="panel panel--strings" aria-label="String table">
      <div className="panel__header">
        Strings{mod && <> · <StringTableHeader mod={mod} /></>}
      </div>
      {mod ? (
        <StringTable
          key={mod.uniqueId}
          mod={mod}
          search={search}
          statusFilter={statusFilter}
          glossary={glossary}
        />
      ) : (
        <div className="panel__empty">Select a mod to view its strings.</div>
      )}
    </section>
  );
}
