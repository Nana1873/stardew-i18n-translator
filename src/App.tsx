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
  type ClaudeBatchItem,
  type ClaudeExportOutcome,
  type ClaudeImportSummary,
  type ExportResult,
  type ScanResult,
  type ScannedMod,
  type StringStatus,
  type TranslationResult,
  exportClaudeBatch,
  exportMod,
  importClaudeBatch,
  loadGlossary,
  loadSettings,
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
import { ExportDialog } from "./export/ExportDialog";
import { ClaudeImportDialog } from "./claude/ClaudeBatchDialog";

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

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StringStatus | "all">("all");
  const [glossary, setGlossaryTerms] = useState<Record<string, string> | null>(
    null,
  );

  // Claude-Code batch import (M4): summary dialog + table reload trigger.
  const [importSummary, setImportSummary] =
    useState<ClaudeImportSummary | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

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
      const result = await scanMods(
        settings.modsPath,
        settings.targetLang ?? "",
      );
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
  const selectedMod =
    scan?.mods.find((mod) => mod.uniqueId === selectedModId) ?? null;
  const reviewTotal =
    scan?.mods.reduce((sum, mod) => sum + mod.reviewNeeded, 0) ?? 0;

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
    ? (source: string): Promise<TranslationResult> =>
        translateString(
          llm!.baseUrl,
          llm!.model,
          source,
          languageLabel,
          llm!.temperature,
        )
    : undefined;

  // Claude-Code batch export (M4): needs a target language for the batch
  // metadata/instructions; absent → the menu item explains why it's disabled.
  const targetLang = settings?.targetLang;
  const claudeExport = targetLang
    ? (
        mod: ScannedMod,
        items: ClaudeBatchItem[],
      ): Promise<ClaudeExportOutcome | null> =>
        exportClaudeBatch(
          mod.uniqueId,
          mod.name,
          targetLang,
          languageLabel,
          items,
        )
    : undefined;

  /** Import a translated Claude-Code batch for the selected mod (M4). */
  async function handleImportBatch() {
    if (!selectedMod) return;
    setImportSummary(null);
    setImportError(null);
    try {
      const summary = await importClaudeBatch(
        selectedMod.uniqueId,
        filesOf(selectedMod),
      );
      if (!summary) return; // picker cancelled
      setImportSummary(summary);
      setImportOpen(true);
      // State on disk changed behind the table's back — force a reload.
      setReloadToken((token) => token + 1);
    } catch (error) {
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

  async function handleExport() {
    if (!selectedMod) return;
    beginExport(selectedMod.name);
    try {
      setExportResult(
        await exportMod(selectedMod.uniqueId, filesOf(selectedMod)),
      );
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
        totalOutdated: 0,
        totalReviewNeeded: 0,
        totalOrphanKeys: 0,
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
        merged.totalOutdated += result.totalOutdated;
        merged.totalReviewNeeded += result.totalReviewNeeded;
        merged.totalOrphanKeys += result.totalOrphanKeys;
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

  // "German (de-DE)" subtitle fragment for the dashboard.
  const languageLine = settings?.targetLang
    ? `${languageLabel} (${settings.targetLang})`
    : "No target language yet";

  return (
    <div className="app">
      <Toolbar
        homeActive={view === "home"}
        onHome={() => setView("home")}
        onScan={handleScan}
        scanEnabled={configured && !scanning}
        scanning={scanning}
        onExport={handleExport}
        exportEnabled={Boolean(selectedMod) && !exporting}
        onExportAll={handleExportAll}
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
              Mods{scan ? ` · ${scan.modCount}` : ""}
              {scan && scan.warnings.length > 0 && (
                <span className="panel__warn">
                  {" "}
                  · {scan.warnings.length} skipped
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
            onClaudeExport={claudeExport}
            onCountsChange={handleCountsChange}
            onShowReview={() => setStatusFilter("review-needed")}
            reloadToken={reloadToken}
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
          onClose={() => setExportOpen(false)}
        />
      )}
      {importOpen && (
        <ClaudeImportDialog
          summary={importSummary}
          error={importError}
          modName={selectedMod?.name ?? ""}
          onClose={() => setImportOpen(false)}
        />
      )}
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
      {/* Brand = Home: the toolbar is the only navigation chrome (SPEC §7.0). */}
      <button
        type="button"
        className={`toolbar__title${homeActive ? " toolbar__title--active" : ""}`}
        onClick={onHome}
        title="Dashboard"
      >
        <span aria-hidden>⌂</span> Stardew i18n Translator
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
          title="Import a translated Claude-Code batch result for the selected mod"
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
  onClaudeExport,
  onCountsChange,
  onShowReview,
  reloadToken,
}: {
  mod: ScannedMod | null;
  search: string;
  statusFilter: StringStatus | "all";
  onStatusFilter: (value: StringStatus | "all") => void;
  glossary: Record<string, string> | null;
  onTranslate?: (source: string) => Promise<TranslationResult>;
  onClaudeExport?: (
    mod: ScannedMod,
    items: ClaudeBatchItem[],
  ) => Promise<ClaudeExportOutcome | null>;
  onCountsChange?: (
    modId: string,
    translatedKeys: number,
    statusCounts: Record<StringStatus, number>,
  ) => void;
  /** Filter the table down to the strings that still need review. */
  onShowReview?: () => void;
  reloadToken?: number;
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
          onClaudeExport={
            onClaudeExport ? (items) => onClaudeExport(mod, items) : undefined
          }
          reloadToken={reloadToken}
          onCountsChange={(translatedKeys, statusCounts) =>
            onCountsChange?.(mod.uniqueId, translatedKeys, statusCounts)
          }
        />
      ) : (
        <div className="panel__empty">Select a mod to view its strings.</div>
      )}
    </section>
  );
}
