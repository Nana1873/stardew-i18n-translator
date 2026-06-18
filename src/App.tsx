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
  type GlossaryEntry,
  type LlmBatchItem,
  type LlmExportOutcome,
  type LlmImportSummary,
  type ExportResult,
  type ScanResult,
  type ScannedMod,
  type StringStatus,
  type TranslationResult,
  type ZipBuildOutcome,
  type ZipComponentInput,
  type ZipPreview,
  buildTranslationZip,
  exportLlmBatch,
  exportMod,
  importLlmBatch,
  importLlmBatchPath,
  loadGlossary,
  loadSettings,
  logFrontendError,
  openFolder,
  pickTranslationZipDestination,
  previewTranslationZip,
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
import {
  type SavedStringSnapshot,
  StringTable,
  StringTableHeader,
} from "./strings/StringTable";
import { GlobalStringSearch } from "./strings/GlobalStringSearch";
import { STATUS_META, statusTint } from "./strings/status";
import { validate } from "./strings/validation";
import { ExportConfirmDialog } from "./export/ExportConfirmDialog";
import {
  TranslationZipDialog,
  ZipOverwriteDialog,
} from "./release/TranslationZipDialog";
import { ReleaseNotesDialog } from "./release/ReleaseNotesDialog";
import {
  type ResultProblem,
  type ResultTrayData,
  ResultTray,
} from "./results/ResultTray";
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
  const [resultTray, setResultTray] = useState<ResultTrayData | null>(null);
  const [zipPreview, setZipPreview] = useState<ZipPreview | null>(null);
  const [zipError, setZipError] = useState<string | null>(null);
  const [zipBuilding, setZipBuilding] = useState(false);
  const [zipContext, setZipContext] = useState<{
    packageName: string;
    components: ZipComponentInput[];
  } | null>(null);
  const [zipOverwrite, setZipOverwrite] = useState<{
    destination: string;
    version: string;
  } | null>(null);
  const [lastZipRelease, setLastZipRelease] = useState<{
    preview: ZipPreview;
    initialVersion: string;
    archiveFileName: string;
  } | null>(null);
  const [releaseNotes, setReleaseNotes] = useState<{
    preview: ZipPreview | null;
    error: string | null;
    initialVersion: string;
    archiveFileName: string | null;
  } | null>(null);
  const [exportConfirm, setExportConfirm] = useState<{
    kind: "selected" | "all";
    title: string;
    files: number;
    mods: number | null;
  } | null>(null);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StringStatus | "all">("all");
  const [glossary, setGlossaryTerms] = useState<GlossaryEntry[] | null>(null);

  // External LLM batch import (M4): persistent result tray + reload trigger.
  const [reloadToken, setReloadToken] = useState(0);
  const [dropPaths, setDropPaths] = useState<string[] | null>(null);

  function refreshGlossary(lang: string | null | undefined) {
    // The glossary is cached per target language; with none selected, or for a
    // game-unsupported language (no cache file), there are simply no hints.
    if (!lang) {
      setGlossaryTerms(null);
      return;
    }
    loadGlossary(lang)
      .then((g) =>
        setGlossaryTerms(g && g.entries.length > 0 ? g.entries : null),
      )
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
        refreshGlossary(loadedSettings.targetLang); // load the active language's cache
        if (complete) void runScan(loadedSettings, false, () => active);
      })
      .catch((error) => {
        logFrontendError("loadSettings", String(error));
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
    // The wizard may have built a glossary, or the target language changed —
    // reload the cache for the now-active language.
    refreshGlossary(merged.targetLang);
  }

  async function handleSaveSettings(next: AppSettings) {
    const languageChanged = settings?.targetLang !== next.targetLang;
    await persist(next);
    setSettingsOpen(false);
    // Settings may have built a glossary or switched language — reload per-language.
    refreshGlossary(next.targetLang);
    if (languageChanged && setupComplete(next)) {
      // A language switch changes target files and saved state roots, so refresh
      // the workspace immediately. Keep optional extra-key cleanup quiet here:
      // those hints are useful on manual scans, but noisy during a deliberate
      // language switch.
      await runScan(next, false, () => true, {
        clearExisting: true,
        showExtraKeyDialog: false,
      });
    }
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
    options: {
      clearExisting?: boolean;
      showExtraKeyDialog?: boolean;
    } = {},
  ) {
    if (!scanSettings.modsPath || !scanSettings.targetLang) return;
    setScanning(true);
    setScanError(null);
    setSelectedModId(null);
    if (options.clearExisting) setScan(null);
    setScanDialogOpen(showProgress);
    try {
      const result = await scanMods(
        scanSettings.modsPath,
        scanSettings.targetLang,
      );
      if (!isActive()) return;
      setScan(result);
      // A clean scan auto-closes; keep the dialog open for actionable scan
      // diagnostics, including unused keys in existing target files.
      setScanDialogOpen(
        result.warnings.length > 0 ||
          (options.showExtraKeyDialog !== false &&
            (result.extraKeys?.length ?? 0) > 0),
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
    if (!mod) {
      showImportResult(
        null,
        "Select a mod before dropping an LLM batch result.",
        "LLM batch",
        null,
      );
      return;
    }
    if (paths.length !== 1) {
      showImportResult(
        null,
        "Drop exactly one LLM batch/result JSON file.",
        mod.name,
        mod,
      );
      return;
    }
    const path = paths[0];
    if (!path.toLowerCase().endsWith(".json")) {
      showImportResult(
        null,
        "Only JSON batch/result files can be imported.",
        mod.name,
        mod,
      );
      return;
    }
    try {
      const summary = await importLlmBatchPath(
        mod.uniqueId,
        filesOf(mod),
        path,
      );
      showImportResult(summary, null, mod.name, mod);
      setReloadToken((token) => token + 1);
    } catch (error) {
      logFrontendError("importLlmBatchPath", String(error));
      showImportResult(null, String(error), mod.name, mod);
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

  /** Drop the current mod selection to return to the cross-mod global search. */
  function clearModSelection() {
    setSelectedModId(null);
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
          settings?.targetLang ?? "",
          languageLabel,
          section,
          llm!.temperature,
        )
    : undefined;

  // External LLM batch export (M4): needs a target language for the batch
  // metadata/instructions; absent → the menu item explains why it's disabled.
  const targetLang = settings?.targetLang;
  const llmBatchExport = targetLang
    ? async (
        mod: ScannedMod,
        items: LlmBatchItem[],
      ): Promise<LlmExportOutcome | null> => {
        try {
          const outcome = await exportLlmBatch(
            mod.uniqueId,
            mod.name,
            targetLang,
            languageLabel,
            items,
          );
          if (outcome) {
            setResultTray({
              kind: "batch-export",
              title: mod.name,
              collapsed: false,
              pending: false,
              error: null,
              outcome,
              problems: [],
            });
          }
          return outcome;
        } catch (error) {
          logFrontendError("exportLlmBatch", String(error));
          setResultTray({
            kind: "batch-export",
            title: mod.name,
            collapsed: false,
            pending: false,
            error: String(error),
            outcome: null,
            problems: [],
          });
          throw error;
        }
      }
    : undefined;

  /** Import a translated external LLM batch for the selected mod (M4). */
  async function handleImportBatch() {
    if (!selectedMod) return;
    try {
      const summary = await importLlmBatch(
        selectedMod.uniqueId,
        filesOf(selectedMod),
      );
      if (!summary) return; // picker cancelled
      showImportResult(summary, null, selectedMod.name, selectedMod);
      // State on disk changed behind the table's back — force a reload.
      setReloadToken((token) => token + 1);
    } catch (error) {
      logFrontendError("importLlmBatch", String(error));
      showImportResult(null, String(error), selectedMod.name, selectedMod);
    }
  }

  function filesOf(mod: ScannedMod) {
    return mod.i18nFiles.map((file) => ({
      relativeDir: file.relativeDir,
      defaultPath: file.defaultPath,
      targetPath: file.targetPath,
    }));
  }

  function zipComponents(packageName: string): ZipComponentInput[] {
    return (scan?.mods ?? [])
      .filter((mod) => mod.packageId === packageName)
      .map((mod) => ({
        uniqueId: mod.uniqueId,
        name: mod.name,
        version: mod.version,
        folderPath: mod.folderPath,
        files: filesOf(mod),
      }));
  }

  async function requestTranslationZip() {
    if (!selectedMod || !settings?.modsPath || !settings.targetLang) return;
    const packageName = selectedMod.packageId;
    const components = zipComponents(packageName);
    setLastZipRelease(null);
    setZipContext({ packageName, components });
    setZipPreview(null);
    setZipError(null);
    try {
      setZipPreview(
        await previewTranslationZip(
          settings.modsPath,
          packageName,
          settings.targetLang,
          languageLabel,
          components,
        ),
      );
    } catch (error) {
      logFrontendError("previewTranslationZip", String(error));
      setZipError(String(error));
    }
  }

  async function requestReleaseNotes() {
    if (!selectedMod || !settings?.modsPath || !settings.targetLang) return;
    const packageName = selectedMod.packageId;
    const components = zipComponents(packageName);
    setReleaseNotes({
      preview: null,
      error: null,
      initialVersion: "",
      archiveFileName: null,
    });
    try {
      const preview = await previewTranslationZip(
        settings.modsPath,
        packageName,
        settings.targetLang,
        languageLabel,
        components,
      );
      setReleaseNotes({
        preview,
        error: null,
        initialVersion: preview.selectedVersion,
        archiveFileName: null,
      });
    } catch (error) {
      logFrontendError("previewReleaseNotes", String(error));
      setReleaseNotes({
        preview: null,
        error: String(error),
        initialVersion: "",
        archiveFileName: null,
      });
    }
  }

  function openReleaseNotesFromZip(version: string, archiveFileName: string) {
    if (!zipPreview) return;
    setReleaseNotes({
      preview: zipPreview,
      error: null,
      initialVersion: version,
      archiveFileName,
    });
  }

  function inspectZipProblem(problem: { modUniqueId: string; key: string }) {
    setReleaseNotes(null);
    setZipPreview(null);
    setZipError(null);
    setZipContext(null);
    openMod(problem.modUniqueId);
    setStatusFilter("all");
    setSearch(problem.key);
  }

  function showZipOutcome(outcome: ZipBuildOutcome, version: string) {
    if (zipPreview) {
      setLastZipRelease({
        preview: zipPreview,
        initialVersion: version,
        archiveFileName: outcome.fileName,
      });
    }
    setZipPreview(null);
    setZipContext(null);
    setZipOverwrite(null);
    setResultTray({
      kind: "zip",
      title: outcome.fileName,
      collapsed: false,
      pending: false,
      error: null,
      outcome,
      problems: [],
    });
  }

  async function buildZipAt(
    destination: string,
    overwrite: boolean,
    version: string,
  ) {
    if (!zipContext || !settings?.modsPath || !settings.targetLang) {
      return;
    }
    setZipBuilding(true);
    setZipError(null);
    try {
      const outcome = await buildTranslationZip(
        settings.modsPath,
        zipContext.packageName,
        settings.targetLang,
        languageLabel,
        zipContext.components,
        destination,
        overwrite,
      );
      showZipOutcome(outcome, version);
    } catch (error) {
      if (String(error).includes("OVERWRITE_REQUIRED")) {
        setZipOverwrite({ destination, version });
      } else {
        logFrontendError("buildTranslationZip", String(error));
        setZipError(String(error));
      }
    } finally {
      setZipBuilding(false);
    }
  }

  async function chooseZipDestination(version: string, fileName: string) {
    const destination = await pickTranslationZipDestination(fileName);
    if (destination) await buildZipAt(destination, false, version);
  }

  function problemId(
    modUniqueId: string,
    relativeDir: string,
    key: string,
  ): string {
    return `${modUniqueId}\u0000${relativeDir}\u0000${key}`;
  }

  function exportProblems(result: ExportResult): ResultProblem[] {
    return result.skipped.map((skip) => ({
      id: problemId(skip.modUniqueId ?? "", skip.relativeDir, skip.key),
      modUniqueId: skip.modUniqueId ?? "",
      modName: skip.modName ?? "",
      relativeDir: skip.relativeDir,
      key: skip.key,
      reason: skip.reason,
      resolved: false,
    }));
  }

  function importProblems(
    summary: LlmImportSummary,
    mod: ScannedMod | null,
  ): ResultProblem[] {
    if (!mod) return [];
    const entries =
      summary.tokenIssueEntries ??
      summary.tokenIssueKeys.map((key) => ({
        relativeDir: mod.i18nFiles[0]?.relativeDir ?? "i18n",
        key,
        reason: "Missing protected tokens",
      }));
    return entries.map((problem) => ({
      id: problemId(mod.uniqueId, problem.relativeDir, problem.key),
      modUniqueId: mod.uniqueId,
      modName: mod.name,
      relativeDir: problem.relativeDir,
      key: problem.key,
      reason: problem.reason,
      resolved: false,
    }));
  }

  function showImportResult(
    summary: LlmImportSummary | null,
    error: string | null,
    title: string,
    mod: ScannedMod | null,
  ) {
    setResultTray({
      kind: "import",
      title,
      collapsed: false,
      pending: false,
      error,
      summary,
      problems: summary ? importProblems(summary, mod) : [],
    });
  }

  function beginExport(
    title: string,
    retry: { kind: "selected"; modUniqueId: string } | { kind: "all" },
  ) {
    setExporting(true);
    setResultTray({
      kind: "export",
      title,
      collapsed: false,
      pending: true,
      error: null,
      result: null,
      modsWritten: null,
      problems: [],
      retry,
    });
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

  async function handleExport(mod = selectedMod) {
    if (!mod) return;
    beginExport(mod.name, { kind: "selected", modUniqueId: mod.uniqueId });
    try {
      const result = await exportMod(mod.uniqueId, filesOf(mod));
      markExportedTargets(mod.uniqueId, result);
      const contextual = withExportContext(result, mod);
      setResultTray((current) =>
        current?.kind === "export"
          ? {
              ...current,
              pending: false,
              result: contextual,
              problems: exportProblems(contextual),
            }
          : current,
      );
    } catch (error) {
      logFrontendError("exportMod", String(error));
      setResultTray((current) =>
        current?.kind === "export"
          ? { ...current, pending: false, error: String(error) }
          : current,
      );
    } finally {
      setExporting(false);
    }
  }

  async function handleExportAll() {
    if (!scan) return;
    beginExport("All mods", { kind: "all" });
    try {
      const merged: ExportResult = {
        files: [],
        skipped: [],
        filesWritten: 0,
        filesRemoved: 0,
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
            modUniqueId: mod.uniqueId,
            modName: mod.name,
          })),
        );
        merged.filesWritten += result.filesWritten;
        merged.filesRemoved += result.filesRemoved;
        merged.totalWrittenKeys += result.totalWrittenKeys;
        merged.totalUntranslated += result.totalUntranslated;
        merged.totalOutdated += result.totalOutdated;
        merged.totalReviewNeeded += result.totalReviewNeeded;
        merged.totalOrphanKeys += result.totalOrphanKeys;
        merged.blocked ||= result.blocked;
        if (result.filesWritten > 0) modsWritten += 1;
      }
      setResultTray((current) =>
        current?.kind === "export"
          ? {
              ...current,
              pending: false,
              result: merged,
              modsWritten,
              problems: exportProblems(merged),
            }
          : current,
      );
    } catch (error) {
      logFrontendError("exportAll", String(error));
      setResultTray((current) =>
        current?.kind === "export"
          ? { ...current, pending: false, error: String(error) }
          : current,
      );
    } finally {
      setExporting(false);
    }
  }

  function inspectResultProblem(problem: ResultProblem) {
    if (problem.modUniqueId) openMod(problem.modUniqueId);
    else setView("work");
    setStatusFilter("all");
    setSearch(problem.key);
  }

  function handleStringSaved(snapshot: SavedStringSnapshot) {
    const id = problemId(
      snapshot.modUniqueId,
      snapshot.relativeDir,
      snapshot.key,
    );
    setResultTray((current) => {
      if (!current || !current.problems.some((problem) => problem.id === id)) {
        return current;
      }
      const errors = validate(
        snapshot.source,
        snapshot.target,
        snapshot.targetPresent,
      ).filter((issue) => issue.severity === "error");
      return {
        ...current,
        problems: current.problems.map((problem) =>
          problem.id === id
            ? {
                ...problem,
                resolved: errors.length === 0,
                reason: errors.map((issue) => issue.message).join(" "),
              }
            : problem,
        ),
      };
    });
  }

  function retryResultExport() {
    if (resultTray?.kind !== "export") return;
    const retry = resultTray.retry;
    if (retry.kind === "all") {
      void handleExportAll();
      return;
    }
    const mod = scan?.mods.find(
      (candidate) => candidate.uniqueId === retry.modUniqueId,
    );
    if (mod) void handleExport(mod);
  }

  // "German (de-DE)" subtitle fragment for the dashboard.
  const languageLine = settings?.targetLang
    ? `${languageLabel} (${settings.targetLang})`
    : "No target language yet";
  const focusedDialogOpen = Boolean(
    wizardOpen ||
    settingsOpen ||
    scanDialogOpen ||
    exportConfirm ||
    zipPreview ||
    zipError ||
    zipContext ||
    releaseNotes ||
    zipOverwrite,
  );
  const trayCollapsed = Boolean(resultTray?.collapsed || focusedDialogOpen);
  const trayScrollClearance = resultTray ? (trayCollapsed ? 58 : 260) : 0;

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
        exporting={exporting}
        onBuildZip={() => void requestTranslationZip()}
        buildZipEnabled={Boolean(selectedMod) && !zipBuilding}
        onReleaseNotes={() => void requestReleaseNotes()}
        releaseNotesEnabled={Boolean(selectedMod)}
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
        searchEnabled={Boolean(scan?.mods.length) && view === "work"}
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
              {scan && (inProgressMods > 0 || scan.warnings.length > 0) && (
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
            mods={scan?.mods ?? []}
            search={search}
            statusFilter={statusFilter}
            onStatusFilter={setStatusFilter}
            glossary={glossary}
            onTranslate={translate}
            onLlmBatchExport={llmBatchExport}
            onCountsChange={handleCountsChange}
            onShowReview={() => setStatusFilter("review-needed")}
            onOpenReviewQueue={() => setView("home")}
            onOpenMod={openMod}
            onClearSelection={clearModSelection}
            onClearFilters={() => {
              setSearch("");
              setStatusFilter("all");
            }}
            onStringSaved={handleStringSaved}
            onEditorOpen={() =>
              setResultTray((current) =>
                current ? { ...current, collapsed: true } : current,
              )
            }
            bottomClearance={trayScrollClearance}
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
      {resultTray && (
        <ResultTray
          data={
            trayCollapsed && !resultTray.collapsed
              ? { ...resultTray, collapsed: true }
              : resultTray
          }
          onToggle={() =>
            setResultTray((current) =>
              current ? { ...current, collapsed: !current.collapsed } : current,
            )
          }
          onClose={() => setResultTray(null)}
          onInspect={inspectResultProblem}
          onRetry={retryResultExport}
          onOpenFolder={(path) => void openFolder(path)}
          onReleaseNotes={
            resultTray.kind === "zip" && lastZipRelease
              ? () =>
                  setReleaseNotes({
                    preview: lastZipRelease.preview,
                    error: null,
                    initialVersion: lastZipRelease.initialVersion,
                    archiveFileName: lastZipRelease.archiveFileName,
                  })
              : undefined
          }
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
      {(zipPreview || zipError || zipContext) && !releaseNotes && (
        <TranslationZipDialog
          key={zipPreview?.defaultFileName ?? "loading"}
          preview={zipPreview}
          error={zipError}
          building={zipBuilding}
          onInspect={inspectZipProblem}
          onReleaseNotes={openReleaseNotesFromZip}
          onBuild={(version, fileName) =>
            void chooseZipDestination(version, fileName)
          }
          onClose={() => {
            setZipPreview(null);
            setZipError(null);
            setZipContext(null);
          }}
        />
      )}
      {releaseNotes && (
        <ReleaseNotesDialog
          key={`${releaseNotes.preview?.defaultFileName ?? "loading"}:${releaseNotes.initialVersion}:${releaseNotes.archiveFileName ?? ""}`}
          preview={releaseNotes.preview}
          error={releaseNotes.error}
          initialVersion={releaseNotes.initialVersion}
          archiveFileName={releaseNotes.archiveFileName}
          onInspect={inspectZipProblem}
          onClose={() => setReleaseNotes(null)}
        />
      )}
      {zipOverwrite && (
        <ZipOverwriteDialog
          fileName={
            zipOverwrite.destination.split(/[\\/]/).pop() ??
            zipOverwrite.destination
          }
          onCancel={() => setZipOverwrite(null)}
          onConfirm={() => {
            const destination = zipOverwrite.destination;
            const version = zipOverwrite.version;
            setZipOverwrite(null);
            void buildZipAt(destination, true, version);
          }}
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
  exporting,
  onBuildZip,
  buildZipEnabled,
  onReleaseNotes,
  releaseNotesEnabled,
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
  exporting: boolean;
  onBuildZip: () => void;
  buildZipEnabled: boolean;
  onReleaseNotes: () => void;
  releaseNotesEnabled: boolean;
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
  const [openMenu, setOpenMenu] = useState<"export" | "import" | null>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const exportMenuEnabled = exportEnabled || buildZipEnabled || exporting;

  useEffect(() => {
    if (!openMenu) return;
    const closeOutside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !actionsRef.current?.contains(event.target)
      ) {
        setOpenMenu(null);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenu(null);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openMenu]);

  function selectMenuAction(action: () => void) {
    setOpenMenu(null);
    action();
  }

  return (
    <header className="toolbar" role="banner">
      <div
        className="toolbar__workflow"
        role="group"
        aria-label="Translation workflow"
        ref={actionsRef}
      >
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
        <button
          type="button"
          className="toolbar__primary"
          onClick={onScan}
          disabled={!scanEnabled}
        >
          {scanning ? "Scanning…" : "Scan"}
        </button>
        <div className="toolbar__menu">
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={openMenu === "export"}
            onClick={() =>
              setOpenMenu((current) => (current === "export" ? null : "export"))
            }
            disabled={!exportMenuEnabled}
          >
            {exporting ? "Exporting..." : "Export..."}
          </button>
          {openMenu === "export" && (
            <div
              className="toolbar__menu-popover"
              role="menu"
              aria-label="Export"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => selectMenuAction(onExport)}
                disabled={!exportEnabled}
              >
                Export to mod folder
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => selectMenuAction(onBuildZip)}
                disabled={!buildZipEnabled}
              >
                Build release ZIP
              </button>
            </div>
          )}
        </div>
        <div className="toolbar__menu">
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={openMenu === "import"}
            onClick={() =>
              setOpenMenu((current) => (current === "import" ? null : "import"))
            }
            disabled={!importBatchEnabled}
          >
            Import...
          </button>
          {openMenu === "import" && (
            <div
              className="toolbar__menu-popover"
              role="menu"
              aria-label="Import"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => selectMenuAction(onImportBatch)}
              >
                Import LLM batch translation
              </button>
            </div>
          )}
        </div>
      </div>
      <div
        className="toolbar__utility"
        role="group"
        aria-label="Translation tools"
      >
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
          {searchEnabled && (
            <input
              className="toolbar__search"
              type="search"
              placeholder="Search strings…"
              aria-label="Search strings"
              value={search}
              onChange={(event) => onSearch(event.target.value)}
            />
          )}
        </div>
        <button
          type="button"
          onClick={onReleaseNotes}
          disabled={!releaseNotesEnabled}
          title="Generate copy-ready release text for this translation package"
        >
          Translation Notes
        </button>
        <button
          type="button"
          onClick={onOpenSettings}
          disabled={!settingsEnabled}
        >
          Settings
        </button>
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
  mods,
  search,
  statusFilter,
  onStatusFilter,
  glossary,
  onTranslate,
  onLlmBatchExport,
  onCountsChange,
  onShowReview,
  onOpenReviewQueue,
  onOpenMod,
  onClearSelection,
  onClearFilters,
  onStringSaved,
  onEditorOpen,
  bottomClearance,
  reloadToken,
  shortcuts,
}: {
  mod: ScannedMod | null;
  mods: ScannedMod[];
  search: string;
  statusFilter: StringStatus | "all";
  onStatusFilter: (value: StringStatus | "all") => void;
  glossary: GlossaryEntry[] | null;
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
  /** Open a mod selected from global string-search results. */
  onOpenMod: (uniqueId: string) => void;
  /** Drop the mod selection to return to cross-mod global search. */
  onClearSelection: () => void;
  /** Reset search + status filter (the no-results escape hatch). */
  onClearFilters?: () => void;
  onStringSaved?: (snapshot: SavedStringSnapshot) => void;
  onEditorOpen?: () => void;
  bottomClearance: number;
  reloadToken?: number;
  shortcuts: ResolvedShortcuts;
}) {
  return (
    <section className="panel panel--strings" aria-label="String table">
      <div className="panel__header">
        <span className="panel__header-title">
          Strings
          {mod && (
            <>
              {" "}
              · <StringTableHeader mod={mod} onShowReview={onShowReview} />
            </>
          )}
        </span>
        {mod && (
          <button
            type="button"
            className="panel__back"
            title="Clear the selected mod and search across all scanned mods"
            onClick={onClearSelection}
          >
            <span aria-hidden>←</span> Search all mods
          </button>
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
          onStringSaved={onStringSaved}
          onEditorOpen={onEditorOpen}
          bottomClearance={bottomClearance}
          reloadToken={reloadToken}
          shortcuts={shortcuts}
          onCountsChange={(translatedKeys, statusCounts) =>
            onCountsChange?.(mod.uniqueId, translatedKeys, statusCounts)
          }
        />
      ) : search.trim() ? (
        <GlobalStringSearch mods={mods} query={search} onOpenMod={onOpenMod} />
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
