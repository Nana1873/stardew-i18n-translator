/**
 * Application shell — Milestone 1.
 *
 * Toolbar + two-panel layout (SPEC §7.3): left = mod list tree, right = string
 * table (still a placeholder until M2). The Setup Wizard opens on first launch
 * and via Settings. Scan runs the Rust scanner and fills the tree.
 */
import {
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  type AppSettings,
  type LlmBatchItem,
  type LlmExportOutcome,
  type LlmImportSummary,
  type ExportResult,
  type SkippedKey,
  type ScanResult,
  type ScannedMod,
  type StringStatus,
  type TranslationResult,
  exportLlmBatch,
  exportMod,
  importLlmBatch,
  importLlmBatchPath,
  loadGlossary,
  loadSettings,
  logFrontendError,
  saveSettings,
  scanMods,
  translateString,
} from "./tauri/commands";
import { TARGET_LANGUAGES } from "./languages";
import { SetupWizard } from "./setup/SetupWizard";
import { SettingsDialog } from "./settings/SettingsDialog";
import { Dashboard } from "./dashboard/Dashboard";
import { ModList } from "./mods/ModList";
import { ScanDialog } from "./mods/ScanDialog";
import { StringTable, StringTableHeader } from "./strings/StringTable";
import { STATUS_META, statusTint } from "./strings/status";
import { ExportConfirmDialog } from "./export/ExportConfirmDialog";
import { ExportDialog } from "./export/ExportDialog";
import { LlmImportDialog } from "./llm-batch/LlmBatchDialog";
import {
  type FileDragDropEvent,
  listenForFileDrops,
} from "./llm-batch/dragDrop";
import { resolveShortcuts, type ResolvedShortcuts } from "./shortcuts";

function setupComplete(settings: AppSettings): boolean {
  return Boolean(
    settings.stardewPath && settings.modsPath && settings.targetLang,
  );
}

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
  // Dashboard home vs. two-panel work view (SPEC §7.0 rollout ④). The brand
  // button is the only way back home — the toolbar is the only nav chrome.
  const [view, setView] = useState<"home" | "work">("home");
  // modId → epoch ms of the last open, persisted so "continue where you left
  // off" survives restarts. localStorage is fine — it's a convenience cache.
  const [lastOpened, setLastOpened] = useState<Record<string, number>>(() => {
    try {
      return JSON.parse(
        localStorage.getItem("sit:lastOpened") ?? "{}",
      ) as Record<string, number>;
    } catch {
      return {};
    }
  });

  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportTitle, setExportTitle] = useState("");
  const [exportModsWritten, setExportModsWritten] = useState<number | null>(
    null,
  );
  const [exportConfirm, setExportConfirm] = useState<{
    kind: "selected" | "all";
    title: string;
    files: number;
    mods: number | null;
  } | null>(null);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StringStatus | "all">("all");
  const [glossary, setGlossaryTerms] = useState<Record<string, string> | null>(
    null,
  );

  // External LLM batch import (M4): summary dialog + table reload trigger.
  const [importSummary, setImportSummary] = useState<LlmImportSummary | null>(
    null,
  );
  const [importError, setImportError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [dropPaths, setDropPaths] = useState<string[] | null>(null);

  function refreshGlossary() {
    loadGlossary()
      .then((g) => setGlossaryTerms(g && g.termCount > 0 ? g.terms : null))
      .catch((error) => {
        logFrontendError("loadGlossary", String(error));
        setGlossaryTerms(null);
      });
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
        const complete = setupComplete(loadedSettings);
        setWizardOpen(!complete);
        if (complete) void runScan(loadedSettings, false, () => active);
      })
      .catch((error) => {
        logFrontendError("loadSettings", String(error));
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
    const merged: AppSettings = {
      ...next,
      llm: settings?.llm ?? null,
      shortcuts: settings?.shortcuts ?? {},
      diagnosticLogging: settings?.diagnosticLogging ?? true,
    };
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
    } catch (error) {
      // Keep in-memory settings even if persistence fails, but record why.
      logFrontendError("saveSettings", String(error));
    }
    setSettings(next);
  }

  async function runScan(
    scanSettings: AppSettings,
    showProgress: boolean,
    isActive: () => boolean = () => true,
  ) {
    if (!scanSettings.modsPath || !scanSettings.targetLang) return;
    setScanning(true);
    setScanError(null);
    setSelectedModId(null);
    setScanDialogOpen(showProgress);
    try {
      const result = await scanMods(
        scanSettings.modsPath,
        scanSettings.targetLang,
      );
      if (!isActive()) return;
      setScan(result);
      // A clean scan auto-closes; keep the dialog open for actionable scan
      // diagnostics, including stale keys in existing target files.
      setScanDialogOpen(
        result.warnings.length > 0 || (result.extraKeys?.length ?? 0) > 0,
      );
    } catch (error) {
      logFrontendError("scanMods", String(error));
      if (!isActive()) return;
      setScanError(String(error));
      setScanDialogOpen(true);
    } finally {
      if (isActive()) setScanning(false);
    }
  }

  async function handleScan() {
    if (!settings) return;
    await runScan(settings, true);
  }

  const configured = Boolean(settings && setupComplete(settings));
  const shortcuts = resolveShortcuts(settings?.shortcuts);
  const selectedMod =
    scan?.mods.find((mod) => mod.uniqueId === selectedModId) ?? null;
  const selectedModRef = useRef<ScannedMod | null>(selectedMod);
  selectedModRef.current = selectedMod;
  const reviewTotal =
    scan?.mods.reduce((sum, mod) => sum + mod.reviewNeeded, 0) ?? 0;
  const inProgressMods =
    scan?.mods.filter(
      (mod) => mod.translatedKeys > 0 && mod.translatedKeys < mod.totalKeys,
    ).length ?? 0;

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let mounted = true;
    listenForFileDrops((event) => {
      if (!mounted) return;
      handleFileDragDrop(event);
    })
      .then((stop) => {
        if (mounted) unlisten = stop;
        else stop();
      })
      .catch(() => {
        // Browser previews and tests have no native Tauri webview.
      });
    return () => {
      mounted = false;
      unlisten?.();
    };
  }, []);

  function handleFileDragDrop(event: FileDragDropEvent) {
    if (event.type === "enter") {
      setDropPaths(event.paths);
    } else if (event.type === "leave") {
      setDropPaths(null);
    } else if (event.type === "drop") {
      setDropPaths(null);
      void handleDroppedBatch(event.paths);
    }
  }

  async function handleDroppedBatch(paths: string[]) {
    const mod = selectedModRef.current;
    setImportSummary(null);
    setImportError(null);
    if (!mod) {
      setImportError("Select a mod before dropping an LLM batch result.");
      setImportOpen(true);
      return;
    }
    if (paths.length !== 1) {
      setImportError("Drop exactly one LLM batch/result JSON file.");
      setImportOpen(true);
      return;
    }
    const path = paths[0];
    if (!path.toLowerCase().endsWith(".json")) {
      setImportError("Only JSON batch/result files can be imported.");
      setImportOpen(true);
      return;
    }
    try {
      const summary = await importLlmBatchPath(
        mod.uniqueId,
        filesOf(mod),
        path,
      );
      setImportSummary(summary);
      setImportOpen(true);
      setReloadToken((token) => token + 1);
    } catch (error) {
      logFrontendError("importLlmBatchPath", String(error));
      setImportError(String(error));
      setImportOpen(true);
    }
  }

  /** Open a mod in the work view and remember it for the resume cards. */
  function openMod(uniqueId: string) {
    setSelectedModId(uniqueId);
    setView("work");
    setLastOpened((prev) => {
      const next = { ...prev, [uniqueId]: Date.now() };
      try {
        localStorage.setItem("sit:lastOpened", JSON.stringify(next));
      } catch {
        /* cache only */
      }
      return next;
    });
  }

  /** Jump from the dashboard queue straight into a mod's review backlog. */
  function openReview(uniqueId: string) {
    setStatusFilter("review-needed");
    openMod(uniqueId);
  }

  /** Keep the mod list / header counts fresh after edits (no rescan needed).
   * `i18nFiles` keeps its reference so the string table does not reload. */
  function handleCountsChange(
    modId: string,
    translatedKeys: number,
    statusCounts: Record<StringStatus, number>,
  ) {
    setScan((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        mods: prev.mods.map((mod) => {
          if (mod.uniqueId !== modId) return mod;
          const progress =
            mod.totalKeys > 0 ? translatedKeys / mod.totalKeys : 0;
          const status =
            mod.totalKeys === 0
              ? "none"
              : translatedKeys >= mod.totalKeys
                ? "translated"
                : "untranslated";
          return {
            ...mod,
            translatedKeys,
            progress,
            status,
            statusCounts,
            reviewNeeded: statusCounts["review-needed"] ?? 0,
          } as ScannedMod;
        }),
      };
    });
  }

  // Human-readable target language ("German"), for AI prompts + batch files.
  const languageLabel =
    TARGET_LANGUAGES.find(
      (l) => l.code === settings?.targetLang,
    )?.label.replace(/ \(.*\)$/, "") ??
    settings?.targetLang ??
    "the target language";

  // A local-AI translate callback, only when a model is configured (M6). Passed
  // to the editor; absent → the editor shows a "configure AI" hint on Ctrl+F5.
  const llm = settings?.llm;
  const aiReady = Boolean(llm?.baseUrl && llm?.model);
  const translate = aiReady
    ? (source: string, section?: string | null): Promise<TranslationResult> =>
        translateString(
          llm!.baseUrl,
          llm!.model,
          source,
          languageLabel,
          section,
          llm!.temperature,
        )
    : undefined;

  // External LLM batch export (M4): needs a target language for the batch
  // metadata/instructions; absent → the menu item explains why it's disabled.
  const targetLang = settings?.targetLang;
  const llmBatchExport = targetLang
    ? (
        mod: ScannedMod,
        items: LlmBatchItem[],
      ): Promise<LlmExportOutcome | null> =>
        exportLlmBatch(mod.uniqueId, mod.name, targetLang, languageLabel, items)
    : undefined;

  /** Import a translated external LLM batch for the selected mod (M4). */
  async function handleImportBatch() {
    if (!selectedMod) return;
    setImportSummary(null);
    setImportError(null);
    try {
      const summary = await importLlmBatch(
        selectedMod.uniqueId,
        filesOf(selectedMod),
      );
      if (!summary) return; // picker cancelled
      setImportSummary(summary);
      setImportOpen(true);
      // State on disk changed behind the table's back — force a reload.
      setReloadToken((token) => token + 1);
    } catch (error) {
      logFrontendError("importLlmBatch", String(error));
      setImportError(String(error));
      setImportOpen(true);
    }
  }

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

  function withExportContext(
    result: ExportResult,
    mod: ScannedMod,
  ): ExportResult {
    return {
      ...result,
      skipped: result.skipped.map((skip) => ({
        ...skip,
        modUniqueId: mod.uniqueId,
        modName: mod.name,
      })),
    };
  }

  function requestExport() {
    if (!selectedMod) return;
    const files = selectedMod.i18nFiles.filter(
      (file) => file.targetExists,
    ).length;
    if (files === 0) {
      void handleExport();
      return;
    }
    setExportConfirm({
      kind: "selected",
      title: selectedMod.name,
      files,
      mods: null,
    });
  }

  function requestExportAll() {
    if (!scan) return;
    const affected = scan.mods.filter((mod) =>
      mod.i18nFiles.some((file) => file.targetExists),
    );
    const files = affected.reduce(
      (sum, mod) =>
        sum + mod.i18nFiles.filter((file) => file.targetExists).length,
      0,
    );
    if (files === 0) {
      void handleExportAll();
      return;
    }
    setExportConfirm({
      kind: "all",
      title: "All mods",
      files,
      mods: affected.length,
    });
  }

  function markExportedTargets(modId: string, result: ExportResult) {
    const written = new Set(
      result.files
        .filter((file) => file.written)
        .map((file) => file.relativeDir),
    );
    if (written.size === 0) return;
    setScan((current) =>
      current
        ? {
            ...current,
            mods: current.mods.map((mod) =>
              mod.uniqueId === modId
                ? {
                    ...mod,
                    i18nFiles: mod.i18nFiles.map((file) =>
                      written.has(file.relativeDir)
                        ? { ...file, targetExists: true }
                        : file,
                    ),
                  }
                : mod,
            ),
          }
        : current,
    );
  }

  async function handleExport() {
    if (!selectedMod) return;
    beginExport(selectedMod.name);
    try {
      const result = await exportMod(
        selectedMod.uniqueId,
        filesOf(selectedMod),
      );
      markExportedTargets(selectedMod.uniqueId, result);
      setExportResult(withExportContext(result, selectedMod));
    } catch (error) {
      logFrontendError("exportMod", String(error));
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
        totalOutdated: 0,
        totalReviewNeeded: 0,
        totalOrphanKeys: 0,
        blocked: false,
      };
      let modsWritten = 0;
      for (const mod of scan.mods) {
        if (mod.i18nFiles.length === 0) continue;
        const result = await exportMod(mod.uniqueId, filesOf(mod));
        markExportedTargets(mod.uniqueId, result);
        merged.files.push(...result.files);
        // Prefix each skipped key with its mod so the summary stays unambiguous.
        merged.skipped.push(
          ...result.skipped.map((skip) => ({
            ...skip,
            relativeDir: `${mod.name} · ${skip.relativeDir}`,
            modUniqueId: mod.uniqueId,
            modName: mod.name,
          })),
        );
        merged.filesWritten += result.filesWritten;
        merged.totalWrittenKeys += result.totalWrittenKeys;
        merged.totalUntranslated += result.totalUntranslated;
        merged.totalOutdated += result.totalOutdated;
        merged.totalReviewNeeded += result.totalReviewNeeded;
        merged.totalOrphanKeys += result.totalOrphanKeys;
        merged.blocked ||= result.blocked;
        if (result.filesWritten > 0) modsWritten += 1;
      }
      setExportResult(merged);
      setExportModsWritten(modsWritten);
    } catch (error) {
      logFrontendError("exportAll", String(error));
      setExportError(String(error));
    } finally {
      setExporting(false);
    }
  }

  function inspectSkippedKey(skip: SkippedKey) {
    if (skip.modUniqueId) openMod(skip.modUniqueId);
    else setView("work");
    setStatusFilter("all");
    setSearch(skip.key);
    setExportOpen(false);
  }

  // "German (de-DE)" subtitle fragment for the dashboard.
  const languageLine = settings?.targetLang
    ? `${languageLabel} (${settings.targetLang})`
    : "No target language yet";

  return (
    <div className="app">
      <Toolbar
        homeActive={view === "home"}
        onHome={() => setView(view === "home" ? "work" : "home")}
        onScan={handleScan}
        scanEnabled={configured && !scanning}
        scanning={scanning}
        onExport={requestExport}
        exportEnabled={Boolean(selectedMod) && !exporting}
        onExportAll={requestExportAll}
        exportAllEnabled={Boolean(scan && scan.mods.length > 0) && !exporting}
        exporting={exporting}
        onImportBatch={() => void handleImportBatch()}
        importBatchEnabled={Boolean(selectedMod)}
        onOpenSettings={() =>
          settings ? setSettingsOpen(true) : setWizardOpen(true)
        }
        settingsEnabled={loaded}
        reviewTotal={reviewTotal}
        onReview={() => setView("home")}
        search={search}
        onSearch={setSearch}
        searchEnabled={Boolean(selectedMod) && view === "work"}
      />
      {view === "home" ? (
        <Dashboard
          scan={scan}
          scanning={scanning}
          languageLine={languageLine}
          onScan={handleScan}
          scanEnabled={configured && !scanning}
          onOpenMod={openMod}
          onOpenReview={openReview}
          onBrowse={() => setView("work")}
          lastOpened={lastOpened}
        />
      ) : (
        <main className="workspace">
          <section
            className="panel panel--mods"
            aria-label="Mod list"
            style={{ width: modsWidth, flex: "0 0 auto" }}
          >
            <div className="panel__header">
              <span>Mods{scan ? ` · ${scan.modCount}` : ""}</span>
              {scan &&
                (inProgressMods > 0 ||
                  scan.warnings.length > 0 ||
                  (scan.extraKeys?.length ?? 0) > 0) && (
                  <span className="panel__header-meta">
                    {inProgressMods > 0 && (
                      <span className="panel__header-tail">
                        {inProgressMods} in progress
                      </span>
                    )}
                    {scan.warnings.length > 0 && (
                      <span className="panel__warn">
                        {scan.warnings.length} skipped
                      </span>
                    )}
                    {(scan.extraKeys?.length ?? 0) > 0 && (
                      <span className="panel__warn">
                        {scan.extraKeys!.length} extra{" "}
                        {scan.extraKeys!.length === 1 ? "key" : "keys"}
                      </span>
                    )}
                  </span>
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
                onSelect={openMod}
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
            onStatusFilter={setStatusFilter}
            glossary={glossary}
            onTranslate={translate}
            onLlmBatchExport={llmBatchExport}
            onCountsChange={handleCountsChange}
            onShowReview={() => setStatusFilter("review-needed")}
            onOpenReviewQueue={() => setView("home")}
            onClearFilters={() => {
              setSearch("");
              setStatusFilter("all");
            }}
            reloadToken={reloadToken}
            shortcuts={shortcuts}
          />
        </main>
      )}
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
          onInspectSkip={inspectSkippedKey}
          onClose={() => setExportOpen(false)}
        />
      )}
      {exportConfirm && (
        <ExportConfirmDialog
          modName={exportConfirm.title}
          files={exportConfirm.files}
          mods={exportConfirm.mods}
          onCancel={() => setExportConfirm(null)}
          onConfirm={() => {
            const kind = exportConfirm.kind;
            setExportConfirm(null);
            if (kind === "selected") void handleExport();
            else void handleExportAll();
          }}
        />
      )}
      {importOpen && (
        <LlmImportDialog
          summary={importSummary}
          error={importError}
          modName={selectedMod?.name ?? ""}
          onClose={() => setImportOpen(false)}
        />
      )}
      {dropPaths && (
        <LlmBatchDropOverlay
          paths={dropPaths}
          modName={selectedMod?.name ?? null}
        />
      )}
    </div>
  );
}

function LlmBatchDropOverlay({
  paths,
  modName,
}: {
  paths: string[];
  modName: string | null;
}) {
  const valid =
    Boolean(modName) &&
    paths.length === 1 &&
    paths[0].toLowerCase().endsWith(".json");
  let title = `Import into ${modName}`;
  let detail = "Release to import this LLM batch result.";
  if (!modName) {
    title = "Select a mod first";
    detail = "The result must be matched against one selected mod.";
  } else if (paths.length !== 1) {
    title = "Drop one file";
    detail = "Batch results are imported one JSON file at a time.";
  } else if (!paths[0].toLowerCase().endsWith(".json")) {
    title = "JSON files only";
    detail = "Drop an *.llm-result.json or translated batch JSON file.";
  }
  return (
    <div
      className={`batchdrop${valid ? " batchdrop--valid" : " batchdrop--invalid"}`}
      role="status"
      aria-live="polite"
    >
      <div className="batchdrop__card">
        <span className="batchdrop__icon" aria-hidden>
          {valid ? "↓" : "×"}
        </span>
        <strong>{title}</strong>
        <span>{detail}</span>
        {paths.length === 1 && <code>{paths[0]}</code>}
      </div>
    </div>
  );
}

function Toolbar({
  homeActive,
  onHome,
  onScan,
  scanEnabled,
  scanning,
  onExport,
  exportEnabled,
  onExportAll,
  exportAllEnabled,
  exporting,
  onImportBatch,
  importBatchEnabled,
  onOpenSettings,
  settingsEnabled,
  reviewTotal,
  onReview,
  search,
  onSearch,
  searchEnabled,
}: {
  homeActive: boolean;
  onHome: () => void;
  onScan: () => void;
  scanEnabled: boolean;
  scanning: boolean;
  onExport: () => void;
  exportEnabled: boolean;
  onExportAll: () => void;
  exportAllEnabled: boolean;
  exporting: boolean;
  onImportBatch: () => void;
  importBatchEnabled: boolean;
  onOpenSettings: () => void;
  settingsEnabled: boolean;
  /** Unreviewed AI suggestions across every scanned mod (0 hides the pill). */
  reviewTotal: number;
  onReview: () => void;
  search: string;
  onSearch: (value: string) => void;
  searchEnabled: boolean;
}) {
  return (
    <header className="toolbar" role="banner">
      {/* Toggles dashboard ⇄ work view, labelled with the destination so the
          navigation explains itself (the app name lives in the OS title bar).
          The toolbar is the only navigation chrome (SPEC §7.8). */}
      <button
        type="button"
        className="toolbar__title"
        onClick={onHome}
        title={
          homeActive ? "Switch to the mod list" : "Switch to the dashboard"
        }
      >
        <span aria-hidden>{homeActive ? "▤" : "⌂"}</span>{" "}
        {homeActive ? "Mod list" : "Dashboard"}
      </button>
      <div className="toolbar__actions">
        <button
          type="button"
          className="toolbar__primary"
          onClick={onScan}
          disabled={!scanEnabled}
        >
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
        <button
          type="button"
          onClick={onImportBatch}
          disabled={!importBatchEnabled}
          title="Import a translated LLM batch result for the selected mod"
        >
          Import batch…
        </button>
        <button
          type="button"
          onClick={onOpenSettings}
          disabled={!settingsEnabled}
        >
          Settings
        </button>
      </div>
      <div className="toolbar__filters">
        {reviewTotal > 0 && (
          <button
            type="button"
            className="panel__review"
            title="Open the review queue on the dashboard"
            onClick={onReview}
          >
            <span aria-hidden>⚑</span> {reviewTotal} to review
          </button>
        )}
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

/** Status filter chips above the table (SPEC §7.4): one pill per status with
 * glyph + live count, plus "All". Replaces the old toolbar dropdown. */
function FilterChips({
  value,
  onChange,
  counts,
  total,
}: {
  value: StringStatus | "all";
  onChange: (value: StringStatus | "all") => void;
  counts: Record<StringStatus, number> | null;
  total: number;
}) {
  const order: StringStatus[] = [
    "untranslated",
    "translated",
    "review-needed",
    "outdated",
  ];
  const allActive = value === "all";
  return (
    <div className="filterchips" role="group" aria-label="Filter by status">
      <button
        type="button"
        className={`filterchip${allActive ? " filterchip--active" : ""}`}
        aria-pressed={allActive}
        style={
          allActive
            ? {
                background: "var(--gold-tint)",
                color: "#f0e0bd",
                borderColor: "rgba(227, 169, 78, 0.45)",
              }
            : undefined
        }
        onClick={() => onChange("all")}
      >
        All <span className="filterchip__count">{total}</span>
      </button>
      {order.map((status) => {
        const meta = STATUS_META[status];
        const count = counts?.[status] ?? 0;
        const active = value === status;
        return (
          <button
            key={status}
            type="button"
            className={`filterchip${active ? " filterchip--active" : ""}`}
            aria-pressed={active}
            aria-label={`${meta.label} (${count})`}
            title={meta.label}
            style={{
              color: meta.color,
              borderColor: statusTint(meta.color, active ? 0.6 : 0.3),
              background: statusTint(meta.color, active ? 0.2 : 0.1),
            }}
            onClick={() => onChange(active ? "all" : status)}
          >
            <span aria-hidden>{meta.glyph}</span>
            <span className="filterchip__count">{count}</span>
          </button>
        );
      })}
    </div>
  );
}

function StringTablePanel({
  mod,
  search,
  statusFilter,
  onStatusFilter,
  glossary,
  onTranslate,
  onLlmBatchExport,
  onCountsChange,
  onShowReview,
  onOpenReviewQueue,
  onClearFilters,
  reloadToken,
  shortcuts,
}: {
  mod: ScannedMod | null;
  search: string;
  statusFilter: StringStatus | "all";
  onStatusFilter: (value: StringStatus | "all") => void;
  glossary: Record<string, string> | null;
  onTranslate?: (
    source: string,
    section?: string | null,
  ) => Promise<TranslationResult>;
  onLlmBatchExport?: (
    mod: ScannedMod,
    items: LlmBatchItem[],
  ) => Promise<LlmExportOutcome | null>;
  onCountsChange?: (
    modId: string,
    translatedKeys: number,
    statusCounts: Record<StringStatus, number>,
  ) => void;
  /** Filter the table down to the strings that still need review. */
  onShowReview?: () => void;
  /** Return to the dashboard's cross-mod review queue. */
  onOpenReviewQueue?: () => void;
  /** Reset search + status filter (the no-results escape hatch). */
  onClearFilters?: () => void;
  reloadToken?: number;
  shortcuts: ResolvedShortcuts;
}) {
  return (
    <section className="panel panel--strings" aria-label="String table">
      <div className="panel__header">
        Strings
        {mod && (
          <>
            {" "}
            · <StringTableHeader mod={mod} onShowReview={onShowReview} />
          </>
        )}
      </div>
      {mod && (
        <FilterChips
          value={statusFilter}
          onChange={onStatusFilter}
          counts={mod.statusCounts ?? null}
          total={mod.totalKeys}
        />
      )}
      {mod ? (
        <StringTable
          key={mod.uniqueId}
          mod={mod}
          search={search}
          statusFilter={statusFilter}
          glossary={glossary}
          onTranslate={onTranslate}
          onLlmBatchExport={
            onLlmBatchExport
              ? (items) => onLlmBatchExport(mod, items)
              : undefined
          }
          onClearFilters={onClearFilters}
          reloadToken={reloadToken}
          shortcuts={shortcuts}
          onCountsChange={(translatedKeys, statusCounts) =>
            onCountsChange?.(mod.uniqueId, translatedKeys, statusCounts)
          }
        />
      ) : (
        <div className="workspace-empty">
          <span className="workspace-empty__icon" aria-hidden>
            ▤
          </span>
          <strong>Select a mod to start translating</strong>
          <span>
            Pick one from the list, or{" "}
            <button type="button" onClick={onOpenReviewQueue}>
              open the review queue
            </button>{" "}
            to work the backlog across all mods.
          </span>
        </div>
      )}
    </section>
  );
}
