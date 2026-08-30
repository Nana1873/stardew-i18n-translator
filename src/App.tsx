/**
 * Application shell.
 *
 * Dashboard plus toolbar and two-panel workspace (SPEC §7): left = mod list,
 * right = string table. The Setup Wizard opens on first launch and via
 * Settings. Scans run in the Rust backend and populate the workspace.
 */
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  type AiEngine,
  type AiRunResult,
  type AiSettings,
  type AiTranslationRequest,
  type AppSettings,
  type CodexCliStatus,
  type ExportAllResult,
  type ExportPreflightProblem,
  type GlossaryEntry,
  type LlmBatchItem,
  type LlmExportOutcome,
  type LlmImportSummary,
  type OperationHistoryEntry,
  type OperationKind,
  type ExportResult,
  type ScanResult,
  type ScanStringIdentity,
  type ScannedMod,
  type StringStatus,
  type ZipBuildOutcome,
  type ZipComponentInput,
  type ZipPreview,
  buildTranslationZip,
  cancelAiRun,
  codexCliStatus,
  exportAllMods,
  exportLlmBatch,
  exportLlmBatchToPath,
  exportMod,
  importLlmBatchPath,
  listOperationHistory,
  loadGlossary,
  loadSettings,
  logFrontendError,
  openFolder,
  pickLlmBatchDestination,
  pickLlmBatchFile,
  preflightLlmBatchPath,
  previewExport,
  pickTranslationZipDestination,
  previewTranslationZip,
  saveSettings,
  scanMods,
  translateWithCodexCli,
  translateWithLocalAi,
  undoBatchEdit,
} from "./tauri/commands";
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  CircleX,
  Download,
  FileCheck2,
  FolderUp,
  Folders,
  Info,
  LayoutDashboard,
  NotebookPen,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Settings as SettingsIcon,
  Table2,
  Upload,
  X,
} from "lucide-react";
import { TARGET_LANGUAGES } from "./languages";
import { SetupWizard } from "./setup/SetupWizard";
import { SettingsDialog } from "./settings/SettingsDialog";
import {
  Dashboard,
  type DashboardLastExport,
  type OverviewFilter,
} from "./dashboard/Dashboard";
import { ModList } from "./mods/ModList";
import { ScanDialog } from "./mods/ScanDialog";
import {
  type AiBatchFinishedResult,
  type SavedStringSnapshot,
  type StringTableColumnWidths,
  type StringTableFilter,
  type StringTableSort,
  StringTable,
} from "./strings/StringTable";
import type { LiveAiEngineOption } from "./strings/BatchTranslateDialog";
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
import { resolveShortcuts } from "./shortcuts";
import { ImportBatchDialog } from "./llm-batch/ImportBatchDialog";
import { LlmBatchExportDialog } from "./llm-batch/LlmBatchExportDialog";

function setupComplete(settings: AppSettings): boolean {
  return Boolean(
    settings.stardewPath && settings.modsPath && settings.targetLang,
  );
}

function countInProgressPackages(mods: ScannedMod[]): number {
  const totals = new Map<
    string,
    { totalKeys: number; translatedKeys: number }
  >();

  for (const mod of mods) {
    const current = totals.get(mod.packageId) ?? {
      totalKeys: 0,
      translatedKeys: 0,
    };
    current.totalKeys += mod.totalKeys;
    current.translatedKeys += mod.translatedKeys;
    totals.set(mod.packageId, current);
  }

  return Array.from(totals.values()).filter(
    ({ totalKeys, translatedKeys }) =>
      translatedKeys > 0 && translatedKeys < totalKeys,
  ).length;
}

const LEGACY_LAST_OPENED_KEY = "sit:lastOpened";

const DEFAULT_AI_SETTINGS: AiSettings = {
  defaultEngine: "local",
  codexModel: null,
  codexReasoning: "medium",
  codexQualityReview: true,
};

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function folderOf(path: string): string | null {
  const index = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  if (index < 0) return null;
  if (index === 0) return path.slice(0, 1);
  if (index === 2 && path[1] === ":") return path.slice(0, 3);
  return path.slice(0, index);
}

function completedDashboardExport(
  title: string,
  result: ExportResult,
): DashboardLastExport | null {
  if (result.blocked) return null;
  const path =
    result.files.find((file) => file.written || file.removed)?.targetPath ??
    result.files[0]?.targetPath;
  return path
    ? {
        label: `Last export · ${title} · this session`,
        path,
        folder: folderOf(path) ?? path,
      }
    : null;
}

function dashboardExportFromHistory(
  entries: OperationHistoryEntry[],
): DashboardLastExport | null {
  const entry = entries.find(
    (candidate) =>
      candidate.kind === "export" &&
      (candidate.outcome === "success" || candidate.outcome === "warning") &&
      Boolean(candidate.path),
  );
  if (!entry?.path) return null;
  const component = entry.details.find(
    (detail) => detail.label === "Component",
  )?.value;
  const label = entry.title.startsWith("All-mod")
    ? "All mods"
    : component || "Translation files";
  return {
    label: `Last export · ${label} · this session`,
    path: entry.path,
    folder: entry.fileName ? (folderOf(entry.path) ?? entry.path) : entry.path,
  };
}

function normalizedHistory(value: unknown): OperationHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is OperationHistoryEntry =>
    Boolean(
      entry &&
      typeof entry === "object" &&
      typeof (entry as OperationHistoryEntry).id === "string" &&
      typeof (entry as OperationHistoryEntry).kind === "string",
    ),
  );
}

function readLegacyLastOpened(): {
  found: boolean;
  entries: Record<string, number>;
} {
  try {
    const raw = localStorage.getItem(LEGACY_LAST_OPENED_KEY);
    if (raw === null) return { found: false, entries: {} };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { found: true, entries: {} };
    }
    const entries = Object.fromEntries(
      Object.entries(parsed).filter(
        ([id, timestamp]) =>
          id.length > 0 &&
          typeof timestamp === "number" &&
          Number.isSafeInteger(timestamp) &&
          timestamp >= 0,
      ),
    );
    return { found: true, entries };
  } catch {
    return { found: true, entries: {} };
  }
}

function clearLegacyLastOpened() {
  try {
    localStorage.removeItem(LEGACY_LAST_OPENED_KEY);
  } catch {
    // A locked-down WebView may deny legacy storage access; portable state is
    // still authoritative and remains usable.
  }
}

export function App() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const settingsRef = useRef<AppSettings | null>(null);
  const workspaceHydratedRef = useRef(false);
  settingsRef.current = settings;
  const [wizardOpen, setWizardOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPage, setSettingsPage] = useState<
    "folders" | "ai" | "glossary" | "shortcuts" | "about"
  >("folders");
  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const [scan, setScan] = useState<ScanResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [lastScanAt, setLastScanAt] = useState<number | null>(null);
  const [scanDialogOpen, setScanDialogOpen] = useState(false);
  const [scanDiagnosticsFocus, setScanDiagnosticsFocus] = useState(false);
  const [scanDialogRetained, setScanDialogRetained] = useState(false);
  const [scanStringFilter, setScanStringFilter] = useState<{
    label: string;
    identities: ScanStringIdentity[];
  } | null>(null);
  const scanDismissedRef = useRef(false);
  const scanGenerationRef = useRef(0);
  const [selectedModId, setSelectedModId] = useState<string | null>(null);
  const [modQuery, setModQuery] = useState("");
  const [modsWidth, setModsWidth] = useState(340);
  const [modsCollapsed, setModsCollapsed] = useState(false);
  // Dashboard home vs. two-panel work view (SPEC §7). Overview is the app's
  // landing view; opening a mod or choosing Workspace enters the workbench.
  const [view, setView] = useState<"home" | "work">("home");
  // modId -> epoch ms of the last open. This is only resume ordering, not an
  // edit timestamp. It is persisted with portable settings.
  const [lastOpened, setLastOpened] = useState<Record<string, number>>({});

  const [exporting, setExporting] = useState(false);
  const [checkingExportReadiness, setCheckingExportReadiness] = useState(false);
  const exportPreflightRef = useRef<{
    nextRequestId: number;
    activeRequestId: number | null;
  }>({ nextRequestId: 0, activeRequestId: null });
  const [resultTray, setResultTray] = useState<ResultTrayData | null>(null);
  const latestResultRef = useRef<ResultTrayData | null>(null);
  const [operationHistory, setOperationHistory] = useState<
    OperationHistoryEntry[]
  >([]);
  const aiHistoryByRunIdRef = useRef(new Map<string, OperationHistoryEntry>());
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(
    null,
  );
  const [resultDetails, setResultDetails] = useState<
    Record<string, ResultTrayData>
  >({});
  const [lastSuccessfulExport, setLastSuccessfulExport] =
    useState<DashboardLastExport | null>(null);
  const [resultHidden, setResultHidden] = useState(false);
  const latestResultButtonRef = useRef<HTMLButtonElement>(null);
  const resultToggleButtonRef = useRef<HTMLButtonElement>(null);
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
    modUniqueId: string | null;
    title: string;
    existingFiles: number;
    newFiles: number;
    mods: number | null;
    willWrite: number | null;
    openOmitted: number | null;
    changedIncluded: number | null;
    reviewIncluded: number | null;
    acceptedMismatches: number;
    blockingProblem: ExportPreflightProblem | null;
    existingTargetPaths: string[];
    newTargetPaths: string[];
  } | null>(null);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StringTableFilter>("all");
  const [stringScope, setStringScope] = useState<"mod" | "all">("mod");
  const [issuesOnly, setIssuesOnly] = useState(false);
  const [tableSort, setTableSort] = useState<StringTableSort | null>(null);
  const [tableColumnWidths, setTableColumnWidths] = useState<
    Partial<StringTableColumnWidths>
  >({});
  const [glossary, setGlossaryTerms] = useState<GlossaryEntry[] | null>(null);
  const glossaryRequestRef = useRef<{
    generation: number;
    language: string | null;
  }>({ generation: 0, language: null });
  const [codexStatus, setCodexStatus] = useState<CodexCliStatus | null>(null);

  // External LLM batch import: persistent result tray + reload trigger.
  const [reloadToken, setReloadToken] = useState(0);
  const [dropPaths, setDropPaths] = useState<string[] | null>(null);
  const [importDialogPath, setImportDialogPath] = useState<
    string | null | undefined
  >(undefined);
  const [importDialogInitialError, setImportDialogInitialError] = useState<
    string | null
  >(null);
  const [llmExportDialog, setLlmExportDialog] = useState<{
    mod: ScannedMod;
    items: LlmBatchItem[];
  } | null>(null);
  const [toast, setToast] = useState<{
    id: number;
    message: string;
    tone: "info" | "success" | "warning" | "error";
  } | null>(null);

  function presentResult(data: ResultTrayData) {
    latestResultRef.current = data;
    setSelectedHistoryId(data.operationId ?? null);
    setResultTray(data);
    setResultHidden(false);
  }

  function historyResult(entry: OperationHistoryEntry): ResultTrayData {
    const reviewModUniqueIds =
      entry.kind === "import"
        ? [
            ...new Set(
              entry.details
                .filter((detail) => detail.label === "Component")
                .map((detail) => detail.value),
            ),
          ]
        : [];
    return {
      kind: "history",
      operationId: entry.id,
      entry,
      title: entry.title,
      collapsed: false,
      pending: false,
      error: null,
      problems: [],
      ...(reviewModUniqueIds.length > 0 ? { reviewModUniqueIds } : {}),
    };
  }

  function presentCompletedResult(
    data: ResultTrayData,
    entry: OperationHistoryEntry,
  ) {
    const attached = { ...data, operationId: entry.id } as ResultTrayData;
    latestResultRef.current = attached;
    setResultDetails((current) => ({ ...current, [entry.id]: attached }));
    setSelectedHistoryId(entry.id);
    setResultTray(attached);
    setResultHidden(false);
  }

  function rememberHiddenHistoryResult(entry: OperationHistoryEntry) {
    const data = historyResult(entry);
    latestResultRef.current = data;
    setResultDetails((current) => ({ ...current, [entry.id]: data }));
    setSelectedHistoryId(entry.id);
    setResultTray(data);
    setResultHidden(true);
  }

  async function refreshCompletedResult(
    data: ResultTrayData,
    expectedKind: OperationKind,
  ) {
    try {
      const entries = normalizedHistory(await listOperationHistory());
      setOperationHistory(entries);
      const lastExport = dashboardExportFromHistory(entries);
      if (lastExport) setLastSuccessfulExport(lastExport);
      const entry = entries.find(
        (candidate) => candidate.kind === expectedKind,
      );
      if (entry) {
        presentCompletedResult(data, entry);
        return;
      }
    } catch (error) {
      logFrontendError("listOperationHistory", String(error));
    }
    // The operation itself still succeeded even if the bounded feedback list
    // is temporarily unavailable. Keep its real command result visible.
    presentResult(data);
  }

  async function refreshOperationHistory() {
    try {
      const entries = normalizedHistory(await listOperationHistory());
      setOperationHistory(entries);
      const lastExport = dashboardExportFromHistory(entries);
      if (lastExport) setLastSuccessfulExport(lastExport);
      setResultDetails((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([id]) =>
            entries.some((entry) => entry.id === id),
          ),
        ),
      );
      return entries;
    } catch (error) {
      logFrontendError("listOperationHistory", String(error));
      return null;
    }
  }

  async function refreshAiAvailability() {
    try {
      setCodexStatus(await codexCliStatus());
    } catch (cause) {
      setCodexStatus({
        installed: false,
        authenticated: false,
        error: String(cause),
      });
    }
  }

  function selectHistoryEntry(entry: OperationHistoryEntry) {
    const detail = resultDetails[entry.id];
    setSelectedHistoryId(entry.id);
    setResultTray(
      detail ? { ...detail, collapsed: false } : historyResult(entry),
    );
    setResultHidden(false);
  }

  useEffect(() => {
    const remembered = latestResultRef.current;
    if (
      resultTray &&
      remembered &&
      selectedHistoryId === (remembered.operationId ?? null)
    ) {
      latestResultRef.current = resultTray;
    }
  }, [resultTray, selectedHistoryId]);

  function reopenLatestResult() {
    const remembered = latestResultRef.current;
    if (!remembered) return;
    const latest = { ...remembered, collapsed: false } as ResultTrayData;
    setSelectedHistoryId(latest.operationId ?? null);
    setResultTray(latest);
    setResultHidden(false);
    window.requestAnimationFrame(() => resultToggleButtonRef.current?.focus());
  }

  function notify(
    message: string,
    tone: "info" | "success" | "warning" | "error" = "info",
  ) {
    setToast({ id: Date.now(), message, tone });
  }

  useEffect(() => {
    if (!toast) return;
    if (toast.tone === "error") return;
    const timer = window.setTimeout(() => setToast(null), 2800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    void refreshOperationHistory();
    void refreshAiAvailability();
  }, []);

  function refreshGlossary(lang: string | null | undefined) {
    const language = lang ?? null;
    const generation = glossaryRequestRef.current.generation + 1;
    glossaryRequestRef.current = { generation, language };
    const isCurrentRequest = () =>
      glossaryRequestRef.current.generation === generation &&
      glossaryRequestRef.current.language === language;
    // The glossary is cached per target language; with none selected, or for a
    // game-unsupported language (no cache file), there are simply no hints.
    if (!language) {
      setGlossaryTerms(null);
      return;
    }
    loadGlossary(language)
      .then((g) => {
        if (!isCurrentRequest()) return;
        setGlossaryTerms(g && g.entries.length > 0 ? g.entries : null);
      })
      .catch((error) => {
        logFrontendError("loadGlossary", String(error));
        if (!isCurrentRequest()) return;
        setGlossaryTerms(null);
      });
  }

  function startResize(event: ReactMouseEvent) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = modsWidth;
    const onMove = (move: MouseEvent) => {
      const next = startWidth + (move.clientX - startX);
      setModsWidth(Math.min(520, Math.max(260, next)));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function resizePaneWithKeyboard(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    setModsWidth((width) =>
      Math.min(
        520,
        Math.max(260, width + (event.key === "ArrowRight" ? 16 : -16)),
      ),
    );
  }

  useEffect(() => {
    let active = true;
    loadSettings()
      .then((loadedSettings) => {
        if (!active) return;
        const portableLastOpened = loadedSettings.lastOpened ?? {};
        const legacy = readLegacyLastOpened();
        const migrateLegacy =
          Object.keys(portableLastOpened).length === 0 &&
          Object.keys(legacy.entries).length > 0;
        const effectiveSettings = migrateLegacy
          ? { ...loadedSettings, lastOpened: legacy.entries }
          : loadedSettings;

        const workspace = effectiveSettings.workspace;
        setModQuery(workspace?.modSearch ?? "");
        setSearch(workspace?.stringSearch ?? "");
        setStringScope(workspace?.stringScope ?? "mod");
        setStatusFilter(workspace?.statusFilter ?? "all");
        setIssuesOnly(workspace?.issuesOnly ?? false);
        setModsWidth(
          Math.min(520, Math.max(260, workspace?.modPaneWidth ?? 340)),
        );
        setTableSort(
          workspace?.sort
            ? {
                col: workspace.sort.column,
                dir: workspace.sort.direction,
              }
            : null,
        );
        setTableColumnWidths(workspace?.columnWidths ?? {});
        workspaceHydratedRef.current = true;

        setSettings(effectiveSettings);
        setLastOpened(effectiveSettings.lastOpened ?? {});
        if (legacy.found) {
          if (migrateLegacy) {
            saveSettings(effectiveSettings)
              .then(clearLegacyLastOpened)
              .catch((error) =>
                logFrontendError("migrateLastOpened", String(error)),
              );
          } else {
            clearLegacyLastOpened();
          }
        }

        const complete = setupComplete(effectiveSettings);
        setWizardOpen(!complete);
        refreshGlossary(effectiveSettings.targetLang);
        if (complete) void runScan(effectiveSettings, false, () => active);
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

  useEffect(() => {
    const current = settingsRef.current;
    if (
      !loaded ||
      !workspaceHydratedRef.current ||
      !current ||
      (setupComplete(current) && !scan)
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      const latest = settingsRef.current;
      if (!latest) return;
      const workspace = {
        selectedModId,
        modSearch: modQuery,
        stringSearch: search,
        stringScope,
        statusFilter,
        issuesOnly,
        sort: tableSort
          ? { column: tableSort.col, direction: tableSort.dir }
          : null,
        modPaneWidth: Math.round(modsWidth),
        columnWidths: tableColumnWidths,
      } satisfies NonNullable<AppSettings["workspace"]>;
      if (JSON.stringify(latest.workspace) === JSON.stringify(workspace)) {
        return;
      }
      const next = { ...latest, workspace };
      settingsRef.current = next;
      setSettings(next);
      void saveSettings(next).catch((error) =>
        logFrontendError("saveWorkspace", String(error)),
      );
    }, 350);
    return () => window.clearTimeout(timer);
  }, [
    loaded,
    scan,
    selectedModId,
    modQuery,
    search,
    stringScope,
    statusFilter,
    issuesOnly,
    tableSort,
    tableColumnWidths,
    modsWidth,
  ]);

  async function handleComplete(next: AppSettings) {
    // The wizard does not edit the AI connection — carry the existing one through
    // so re-running setup to change folders never wipes the local-AI config.
    const merged: AppSettings = {
      ...next,
      llm: settings?.llm ?? null,
      ai: settings?.ai ?? DEFAULT_AI_SETTINGS,
      shortcuts: settings?.shortcuts ?? {},
      lastOpened: settings?.lastOpened ?? {},
      workspace: settings?.workspace,
      diagnosticLogging: settings?.diagnosticLogging ?? true,
    };
    await persist(merged);
    setWizardOpen(false);
    // The wizard may have built a glossary, or the target language changed —
    // reload the cache for the now-active language.
    refreshGlossary(merged.targetLang);
  }

  async function handleSaveSettings(next: AppSettings) {
    const workspaceChanged =
      settings?.targetLang !== next.targetLang ||
      settings?.stardewPath !== next.stardewPath ||
      settings?.modsPath !== next.modsPath;
    await persist(next);
    void refreshAiAvailability();
    setSettingsOpen(false);
    // Settings may have built a glossary or switched language — reload per-language.
    refreshGlossary(next.targetLang);
    if (workspaceChanged && setupComplete(next)) {
      // A folder or language switch changes the scanned workspace, so refresh it
      // immediately. Keep optional extra-key cleanup quiet here: those hints are
      // useful on manual scans, but noisy during a deliberate settings change.
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
      logFrontendError("saveSettings", String(error));
      throw error;
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
      preserveSelection?: boolean;
      showDiagnostics?: boolean;
    } = {},
  ) {
    if (!scanSettings.modsPath || !scanSettings.targetLang) return;
    const generation = ++scanGenerationRef.current;
    const isCurrentRequest = () =>
      generation === scanGenerationRef.current && isActive();
    setScanning(true);
    scanDismissedRef.current = false;
    setScanDiagnosticsFocus(false);
    setScanDialogRetained(false);
    setScanStringFilter(null);
    setScanError(null);
    const selectionBeforeScan =
      options.preserveSelection === false
        ? scanSettings.workspace?.selectedModId
        : (selectedModId ?? scanSettings.workspace?.selectedModId);
    const scopeBeforeScan =
      options.preserveSelection === false
        ? (scanSettings.workspace?.stringScope ?? "mod")
        : selectedModId
          ? stringScope
          : (scanSettings.workspace?.stringScope ?? stringScope);
    if (options.clearExisting) setScan(null);
    setScanDialogOpen(showProgress);
    try {
      const result = await scanMods(
        scanSettings.modsPath,
        scanSettings.targetLang,
      );
      if (!isCurrentRequest()) return;
      setScan(result);
      const completedAt = Date.now();
      setLastScanAt(completedAt);
      setNow(completedAt);
      const requested = result.mods.find(
        (candidate) => candidate.uniqueId === selectionBeforeScan,
      );
      const preferred =
        requested ??
        [...result.mods].sort(
          (left, right) =>
            (scanSettings.lastOpened?.[right.uniqueId] ?? 0) -
            (scanSettings.lastOpened?.[left.uniqueId] ?? 0),
        )[0];
      setSelectedModId(preferred?.uniqueId ?? null);
      setStringScope(preferred ? scopeBeforeScan : "all");
      // Retain every manually requested completed scan until the user closes
      // it. Silent scans still surface real
      // diagnostics without interrupting a clean startup or language switch.
      if (
        !scanDismissedRef.current &&
        (showProgress || options.showDiagnostics !== false)
      ) {
        setScanDialogOpen(
          showProgress ||
            result.warnings.length > 0 ||
            (result.skippedComponents?.some(
              (component) => component.requiresAttention,
            ) ??
              false) ||
            (options.showExtraKeyDialog !== false &&
              (result.extraKeys?.length ?? 0) > 0),
        );
      }
    } catch (error) {
      logFrontendError("scanMods", String(error));
      if (!isCurrentRequest()) return;
      setScanError(String(error));
      if (!scanDismissedRef.current) setScanDialogOpen(true);
    } finally {
      if (isCurrentRequest()) setScanning(false);
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
  const inProgressMods = scan ? countInProgressPackages(scan.mods) : 0;
  const attentionSkippedCount = scan?.skippedComponents?.filter(
    (component) => component.requiresAttention,
  ).length;

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

  function handleDroppedBatch(paths: string[]) {
    const mod = selectedModRef.current;
    if (!mod) {
      showImportResult(
        null,
        "Select a mod before dropping an LLM batch result.",
        "LLM batch",
      );
      return;
    }
    if (paths.length !== 1) {
      setImportDialogInitialError(
        "Choose only one JSON file. Nothing was imported.",
      );
      setImportDialogPath(null);
      return;
    }
    const path = paths[0];
    if (!path.toLowerCase().endsWith(".json")) {
      setImportDialogInitialError(
        "Invalid file type. Exactly one JSON batch file is required.",
      );
      setImportDialogPath(path);
      return;
    }
    setImportDialogInitialError(null);
    setImportDialogPath(path);
  }

  /** Open a mod in the work view and remember it for the resume cards. */
  function openMod(uniqueId: string) {
    setSelectedModId(uniqueId);
    setStringScope("mod");
    setView("work");
    const nextLastOpened = { ...lastOpened, [uniqueId]: Date.now() };
    setLastOpened(nextLastOpened);
    if (settings) {
      const nextSettings = { ...settings, lastOpened: nextLastOpened };
      setSettings(nextSettings);
      void saveSettings(nextSettings).catch((error) =>
        logFrontendError("saveLastOpened", String(error)),
      );
    }
  }

  function openOverviewFilter(filter: OverviewFilter) {
    setSearch("");
    setIssuesOnly(false);
    setStatusFilter(filter);
    setStringScope("all");
    setView("work");
  }

  function openLatestScan(focusDiagnostics = false) {
    const canFocusDiagnostics = Boolean(
      focusDiagnostics && scan && !scanning && !scanError,
    );
    setScanDialogRetained(Boolean(scan && !scanning && !scanError));
    setScanDiagnosticsFocus(canFocusDiagnostics);
    setScanDialogOpen(true);
  }

  function closeScanDialog() {
    scanDismissedRef.current = true;
    setScanDiagnosticsFocus(false);
    setScanDialogRetained(false);
    setScanDialogOpen(false);
  }

  function openScanStrings(kind: "added" | "changed") {
    const deltas = scan?.sourceDeltas;
    const identities =
      kind === "added" ? deltas?.addedStrings : deltas?.changedSources;
    if (!identities?.length) return;
    setScanStringFilter({
      label:
        kind === "added"
          ? "New strings from latest scan"
          : "Changed English strings from latest scan",
      identities,
    });
    setSearch("");
    setStatusFilter("all");
    setIssuesOnly(false);
    setStringScope("all");
    setView("work");
    closeScanDialog();
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

  // Human-readable target language ("German") for live-AI prompts.
  const languageLabel =
    TARGET_LANGUAGES.find(
      (l) => l.code === settings?.targetLang,
    )?.label.replace(/ \(.*\)$/, "") ??
    settings?.targetLang ??
    "the target language";

  // Each direct live-AI backend exposes its real readiness to the workbench;
  // translation is enabled only for the selected ready engine.
  const llm = settings?.llm;
  const aiSettings = settings?.ai ?? DEFAULT_AI_SETTINGS;
  const localAiReady = Boolean(llm?.baseUrl.trim() && llm.model.trim());
  const codexAiReady = Boolean(
    codexStatus?.installed && codexStatus.authenticated,
  );
  const liveAiEngines: LiveAiEngineOption[] = [
    {
      id: "local",
      label: "Local AI",
      ready: localAiReady,
      model: llm?.model || "Model unavailable",
      reasoning: "Default",
      unavailableReason: localAiReady
        ? undefined
        : "Set a local Base URL and choose a model in Settings.",
      note: localAiReady
        ? `${llm!.baseUrl} · local service`
        : "Local endpoint unavailable",
    },
    {
      id: "codex",
      label: "Codex CLI",
      ready: codexAiReady,
      model: aiSettings.codexModel || "Codex default",
      reasoning: aiSettings.codexReasoning,
      unavailableReason: codexAiReady
        ? undefined
        : codexStatus?.installed
          ? "Codex CLI is installed, but it is not signed in."
          : codexStatus?.error || "Codex CLI is not installed or discoverable.",
      note: codexStatus?.version
        ? `Codex CLI ${codexStatus.version}`
        : "Uses the Codex CLI account on this computer",
    },
  ];

  async function runAi(
    engine: AiEngine,
    request: AiTranslationRequest,
  ): Promise<AiRunResult> {
    const previousEntries =
      request.scope === "string" ? await refreshOperationHistory() : null;
    const previousIds = new Set(
      (previousEntries ?? operationHistory).map((entry) => entry.id),
    );
    const startedAtEpochMs = Date.now();
    let result: AiRunResult | undefined;
    try {
      result =
        engine === "local"
          ? await translateWithLocalAi(request)
          : await translateWithCodexCli(request);
      return result;
    } finally {
      const entries = await refreshOperationHistory();
      const entry = entries?.find(
        (candidate) =>
          candidate.kind === "ai" &&
          (request.scope !== "string" ||
            (!previousIds.has(candidate.id) &&
              (previousEntries !== null ||
                candidate.completedAtEpochMs >= startedAtEpochMs))),
      );
      if (entry && request.scope === "string") {
        rememberHiddenHistoryResult(entry);
      } else if (entry && result) {
        aiHistoryByRunIdRef.current.set(result.runId, entry);
      }
    }
  }

  // External LLM batch export: needs a target language for the batch
  // metadata/instructions; absent → the menu item explains why it's disabled.
  const targetLang = settings?.targetLang;
  const llmBatchExport = targetLang
    ? async (
        mod: ScannedMod,
        items: LlmBatchItem[],
      ): Promise<LlmExportOutcome | null> => {
        setLlmExportDialog({ mod, items });
        return null;
      }
    : undefined;

  async function savePendingLlmBatch(
    destinationPath: string | null,
  ): Promise<boolean> {
    if (!llmExportDialog) return false;
    const { mod, items } = llmExportDialog;
    try {
      const outcome = destinationPath
        ? await exportLlmBatchToPath(mod.uniqueId, items, destinationPath)
        : await exportLlmBatch(mod.uniqueId, items);
      if (!outcome) return false;
      await refreshCompletedResult(
        {
          kind: "batch-export",
          title: mod.name,
          collapsed: false,
          pending: false,
          error: null,
          outcome,
          problems: [],
        },
        "batch-export",
      );
      return true;
    } catch (error) {
      logFrontendError(
        destinationPath ? "exportLlmBatchToPath" : "exportLlmBatch",
        String(error),
      );
      presentResult({
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

  /** Import a translated external LLM batch for the selected mod. */
  function handleImportBatch() {
    if (!selectedMod || !targetLang) return;
    setImportDialogInitialError(null);
    setImportDialogPath(null);
  }

  async function importSelectedBatch(path: string) {
    if (!selectedMod || !targetLang) return;
    try {
      const summary = await importLlmBatchPath(
        selectedMod.uniqueId,
        filesOf(selectedMod),
        path,
      );
      setImportDialogPath(undefined);
      setImportDialogInitialError(null);
      showImportResult(
        summary,
        null,
        selectedMod.name,
        path,
        selectedMod.uniqueId,
      );
      setReloadToken((token) => token + 1);
    } catch (error) {
      logFrontendError("importLlmBatchPath", String(error));
      setImportDialogPath(undefined);
      setImportDialogInitialError(null);
      showImportResult(
        null,
        String(error),
        selectedMod.name,
        path,
        selectedMod.uniqueId,
      );
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
    setZipPreview(null);
    setZipError(null);
    setZipContext(null);
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
    void refreshCompletedResult(
      {
        kind: "zip",
        title: outcome.fileName,
        collapsed: false,
        pending: false,
        error: null,
        outcome,
        problems: [],
      },
      "zip",
    );
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
    return JSON.stringify([modUniqueId, relativeDir, key]);
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

  function showImportResult(
    summary: LlmImportSummary | null,
    error: string | null,
    title: string,
    sourcePath: string | null = null,
    reviewModUniqueId?: string,
  ) {
    const data: ResultTrayData = {
      kind: "import",
      title,
      collapsed: false,
      pending: false,
      error,
      summary,
      sourcePath,
      sourceFileName: sourcePath ? fileNameOf(sourcePath) : null,
      sourceFolder: sourcePath ? folderOf(sourcePath) : null,
      problems: [],
      ...(reviewModUniqueId ? { reviewModUniqueIds: [reviewModUniqueId] } : {}),
    };
    if (summary && !error) void refreshCompletedResult(data, "import");
    else presentResult(data);
  }

  function beginExport(
    title: string,
    retry: { kind: "selected"; modUniqueId: string } | { kind: "all" },
  ) {
    setCheckingExportReadiness(false);
    setExporting(true);
    presentResult({
      kind: "export",
      title,
      collapsed: false,
      pending: true,
      error: null,
      result: null,
      modsChanged: null,
      failedMod: null,
      remainingMods: [],
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

  async function requestExport(mod = selectedMod) {
    if (!mod || exportPreflightRef.current.activeRequestId !== null) return;
    const requestId = ++exportPreflightRef.current.nextRequestId;
    exportPreflightRef.current.activeRequestId = requestId;
    const existingFiles = mod.i18nFiles.filter((file) => file.targetExists);
    const newFiles = mod.i18nFiles.filter((file) => !file.targetExists);
    setCheckingExportReadiness(true);
    setExporting(true);
    try {
      const preflight = await previewExport([
        {
          modUniqueId: mod.uniqueId,
          modName: mod.name,
          files: filesOf(mod),
        },
      ]);
      if (exportPreflightRef.current.activeRequestId !== requestId) return;
      setExportConfirm({
        kind: "selected",
        modUniqueId: mod.uniqueId,
        title: mod.name,
        existingFiles: existingFiles.length,
        newFiles: newFiles.length,
        mods: null,
        willWrite: mod.translatedKeys,
        openOmitted: Math.max(0, mod.totalKeys - mod.translatedKeys),
        changedIncluded: mod.statusCounts?.outdated ?? null,
        reviewIncluded: mod.statusCounts?.["review-needed"] ?? mod.reviewNeeded,
        acceptedMismatches: preflight.acceptedMismatches,
        blockingProblem: preflight.blockingProblem,
        existingTargetPaths: existingFiles.map((file) => file.targetPath),
        newTargetPaths: newFiles.map((file) => file.targetPath),
      });
    } catch (error) {
      if (exportPreflightRef.current.activeRequestId !== requestId) return;
      logFrontendError("previewExport", String(error));
      notify(`Could not check export readiness: ${String(error)}`, "error");
    } finally {
      if (exportPreflightRef.current.activeRequestId === requestId) {
        exportPreflightRef.current.activeRequestId = null;
        setCheckingExportReadiness(false);
        setExporting(false);
      }
    }
  }

  async function requestExportAll() {
    if (!scan || exportPreflightRef.current.activeRequestId !== null) return;
    const requestId = ++exportPreflightRef.current.nextRequestId;
    exportPreflightRef.current.activeRequestId = requestId;
    const affected = scan.mods.filter((mod) => mod.i18nFiles.length > 0);
    const targetFiles = affected.flatMap((mod) => mod.i18nFiles);
    const existingFiles = targetFiles.filter((file) => file.targetExists);
    const newFiles = targetFiles.filter((file) => !file.targetExists);
    const statusCountsKnown = affected.every((mod) => mod.statusCounts != null);
    setCheckingExportReadiness(true);
    setExporting(true);
    try {
      const preflight = await previewExport(
        affected.map((mod) => ({
          modUniqueId: mod.uniqueId,
          modName: mod.name,
          files: filesOf(mod),
        })),
      );
      if (exportPreflightRef.current.activeRequestId !== requestId) return;
      setExportConfirm({
        kind: "all",
        modUniqueId: null,
        title: "All mods",
        existingFiles: existingFiles.length,
        newFiles: newFiles.length,
        mods: affected.length,
        willWrite: affected.reduce((sum, mod) => sum + mod.translatedKeys, 0),
        openOmitted: affected.reduce(
          (sum, mod) => sum + Math.max(0, mod.totalKeys - mod.translatedKeys),
          0,
        ),
        changedIncluded: statusCountsKnown
          ? affected.reduce(
              (sum, mod) => sum + (mod.statusCounts?.outdated ?? 0),
              0,
            )
          : null,
        reviewIncluded: affected.reduce(
          (sum, mod) => sum + mod.reviewNeeded,
          0,
        ),
        acceptedMismatches: preflight.acceptedMismatches,
        blockingProblem: preflight.blockingProblem,
        existingTargetPaths: existingFiles.map((file) => file.targetPath),
        newTargetPaths: newFiles.map((file) => file.targetPath),
      });
    } catch (error) {
      if (exportPreflightRef.current.activeRequestId !== requestId) return;
      logFrontendError("previewExport", String(error));
      notify(`Could not check export readiness: ${String(error)}`, "error");
    } finally {
      if (exportPreflightRef.current.activeRequestId === requestId) {
        exportPreflightRef.current.activeRequestId = null;
        setCheckingExportReadiness(false);
        setExporting(false);
      }
    }
  }

  function markExportedTargets(modId: string, result: ExportResult) {
    const targetExistence = new Map(
      result.files
        .filter((file) => file.written || file.removed)
        .map((file) => [file.relativeDir, file.written] as const),
    );
    if (targetExistence.size === 0) return;
    setScan((current) =>
      current
        ? {
            ...current,
            mods: current.mods.map((mod) =>
              mod.uniqueId === modId
                ? {
                    ...mod,
                    i18nFiles: mod.i18nFiles.map((file) => {
                      const targetExists = targetExistence.get(
                        file.relativeDir,
                      );
                      return targetExists === undefined
                        ? file
                        : { ...file, targetExists };
                    }),
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
      const completed = completedDashboardExport(mod.name, contextual);
      if (completed) setLastSuccessfulExport(completed);
      await refreshCompletedResult(
        {
          kind: "export",
          title: mod.name,
          collapsed: false,
          pending: false,
          error: null,
          result: contextual,
          modsChanged: null,
          failedMod: null,
          remainingMods: [],
          problems: exportProblems(contextual),
          retry: { kind: "selected", modUniqueId: mod.uniqueId },
        },
        "export",
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
      const outcome: ExportAllResult = await exportAllMods(
        scan.mods
          .filter((mod) => mod.i18nFiles.length > 0)
          .map((mod) => ({
            modUniqueId: mod.uniqueId,
            modName: mod.name,
            files: filesOf(mod),
          })),
      );
      const merged: ExportResult = {
        files: [],
        skipped: [],
        filesWritten: outcome.filesWritten,
        filesRemoved: outcome.filesRemoved,
        totalWrittenKeys: outcome.totalWrittenKeys,
        totalUntranslated: outcome.totalUntranslated,
        totalOutdated: outcome.totalOutdated,
        totalReviewNeeded: outcome.totalReviewNeeded,
        totalOrphanKeys: outcome.totalOrphanKeys,
        blocked: outcome.blocked,
      };
      for (const exported of outcome.mods) {
        const mod = scan.mods.find(
          (candidate) => candidate.uniqueId === exported.modUniqueId,
        );
        if (!mod) continue;
        const contextual = withExportContext(exported.result, mod);
        merged.files.push(...contextual.files);
        merged.skipped.push(...contextual.skipped);
        markExportedTargets(mod.uniqueId, contextual);
      }
      const completed = completedDashboardExport("All mods", merged);
      if (completed) setLastSuccessfulExport(completed);
      await refreshCompletedResult(
        {
          kind: "export",
          title: "All mods",
          collapsed: false,
          pending: false,
          error: null,
          result: merged,
          modsChanged: outcome.modsChanged,
          failedMod: null,
          remainingMods: [],
          problems: exportProblems(merged),
          retry: { kind: "all" },
        },
        "export",
      );
    } catch (error) {
      logFrontendError("exportAll", String(error));
      setResultTray((current) =>
        current?.kind === "export"
          ? {
              ...current,
              pending: false,
              error: String(error),
              result: null,
              modsChanged: 0,
              failedMod: null,
              remainingMods: [],
              problems: [],
            }
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
    setResultHidden(true);

    let attempts = 0;
    const openMatchingRow = () => {
      const row = Array.from(
        document.querySelectorAll<HTMLElement>("[data-string-row]"),
      ).find((candidate) => candidate.dataset.rowId === problem.id);
      if (row) {
        row.dispatchEvent(
          new MouseEvent("dblclick", { bubbles: true, cancelable: true }),
        );
        return;
      }
      attempts += 1;
      if (attempts < 180) window.requestAnimationFrame(openMatchingRow);
    };
    window.requestAnimationFrame(openMatchingRow);
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
      ).filter(
        (issue) =>
          issue.severity === "error" &&
          !(
            snapshot.tokenMismatchAccepted &&
            (issue.ruleId === "token-missing" || issue.ruleId === "token-added")
          ),
      );
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

  function handleBulkApplied(entry: OperationHistoryEntry) {
    if (!entry?.id) {
      notify(
        "The batch edit was saved, but operation history is unavailable.",
        "info",
      );
      return;
    }
    setOperationHistory((current) =>
      [
        entry,
        ...current
          .filter((candidate) => candidate.id !== entry.id)
          .map((candidate) =>
            candidate.canUndo ? { ...candidate, canUndo: false } : candidate,
          ),
      ].slice(0, 5),
    );
    presentCompletedResult(
      {
        kind: "bulk",
        title: entry.title,
        collapsed: false,
        pending: false,
        error: null,
        problems: [],
        count: entry.itemCount,
        undoAvailable: entry.canUndo,
      },
      entry,
    );
  }

  function handleAiBatchFinished(result: AiBatchFinishedResult) {
    const completedWithIssues = Boolean(
      result.error && result.done > 0 && result.outcome !== "cancelled",
    );
    const data: ResultTrayData = {
      kind: "ai-batch",
      title: result.modName || selectedMod?.name || "Selected strings",
      collapsed: false,
      pending: false,
      error: result.error ?? null,
      problems: [],
      outcome: result.outcome,
      done: result.done,
      total: result.total,
      engine: result.engine,
      undoAvailable: false,
      reviewModUniqueIds: result.modUniqueIds,
    };
    const historyEntry = result.runId
      ? aiHistoryByRunIdRef.current.get(result.runId)
      : undefined;
    if (historyEntry) {
      presentCompletedResult(data, historyEntry);
      aiHistoryByRunIdRef.current.delete(result.runId!);
    } else {
      // Provider setup/launch failures can happen before Rust records a
      // completed run. Show that real transient error without attaching an
      // older AI history entry.
      presentResult(data);
    }
    if (result.done > 0) {
      setReloadToken((token) => token + 1);
      if (settings) {
        void runScan(settings, false, () => true, {
          preserveSelection: true,
          showExtraKeyDialog: false,
          showDiagnostics: false,
        });
      }
    }
    if (completedWithIssues) {
      notify(
        `AI translation completed with issues: ${result.done} of ${result.total} saved in Review.`,
        "warning",
      );
    } else if (result.outcome !== "complete") {
      notify(
        `AI translation ${result.outcome === "cancelled" ? "cancelled" : "failed"} after ${result.done} of ${result.total}. Finished suggestions are in Review.`,
        result.outcome === "error" ? "error" : "info",
      );
    }
  }

  function openResultReviewQueue() {
    const knownModIds = new Set(scan?.mods.map((mod) => mod.uniqueId) ?? []);
    const reviewModIds = [
      ...new Set(
        (resultTray?.reviewModUniqueIds ?? []).filter((id) =>
          knownModIds.has(id),
        ),
      ),
    ];
    setSearch("");
    setStatusFilter("review-needed");
    setIssuesOnly(false);
    if (reviewModIds.length === 1) {
      openMod(reviewModIds[0]);
    } else {
      // Multiple or older history entries have no single safe component.
      // All mods guarantees the requested Review results are not hidden.
      setStringScope("all");
    }
    setView("work");
    setResultHidden(true);
    window.requestAnimationFrame(() => {
      const review = Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          '.translator-filter[aria-pressed="true"]',
        ),
      ).find((button) => button.textContent?.includes("Review"));
      review?.focus();
    });
  }

  async function undoLatestBulk() {
    const operation = operationHistory.find(
      (entry) => entry.id === selectedHistoryId && entry.canUndo,
    );
    if (!operation) return;

    try {
      const undone = await undoBatchEdit(operation.id);
      setReloadToken((token) => token + 1);
      const entries = await refreshOperationHistory();
      if (!entries?.some((entry) => entry.id === undone.id)) {
        setOperationHistory((current) => [undone, ...current].slice(0, 5));
      }
      presentCompletedResult(
        {
          kind: "bulk",
          title: undone.title,
          collapsed: false,
          pending: false,
          error: null,
          problems: [],
          count: undone.itemCount,
          undone: true,
          undoAvailable: false,
        },
        undone,
      );
      notify(
        `${undone.itemCount} ${undone.itemCount === 1 ? "string" : "strings"} restored.`,
        "success",
      );
    } catch (error) {
      logFrontendError("undoBulk", String(error));
      setResultTray((current) =>
        current?.kind === "bulk" || current?.kind === "history"
          ? { ...current, pending: false, error: String(error) }
          : current,
      );
      throw error;
    }
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
    if (mod) requestExport(mod);
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
    zipOverwrite ||
    importDialogPath !== undefined ||
    llmExportDialog,
  );
  useEffect(() => {
    if (!focusedDialogOpen || !resultTray || resultTray.collapsed) return;
    setResultTray({ ...resultTray, collapsed: true });
  }, [focusedDialogOpen, resultTray]);

  const trayCollapsed = Boolean(resultTray?.collapsed);
  const trayScrollClearance =
    resultTray && !resultHidden ? (trayCollapsed ? 58 : 260) : 0;
  const selectedHistoryEntry = operationHistory.find(
    (entry) => entry?.id === selectedHistoryId,
  );

  return (
    <div id="stardew-i18n-translator" className="app">
      <div className="translator-window">
        <AppToolbar
          activeView={view === "work" ? "workspace" : "overview"}
          onWorkspace={() => {
            setView("work");
          }}
          onOverview={() => {
            setView("home");
          }}
          onScan={handleScan}
          scanEnabled={configured && !scanning && !exporting}
          scanning={scanning}
          onExport={requestExport}
          exportEnabled={Boolean(selectedMod) && !exporting}
          onExportAll={requestExportAll}
          exportAllEnabled={Boolean(scan?.mods.length) && !exporting}
          exporting={exporting}
          checkingExportReadiness={checkingExportReadiness}
          onBuildZip={() => void requestTranslationZip()}
          buildZipEnabled={Boolean(selectedMod) && !zipBuilding && !exporting}
          onReleaseNotes={() => void requestReleaseNotes()}
          releaseNotesEnabled={Boolean(selectedMod) && !exporting}
          onImportBatch={() => void handleImportBatch()}
          importBatchEnabled={Boolean(selectedMod) && !exporting}
          onOpenSettings={() => {
            setSettingsPage("folders");
            if (settings) setSettingsOpen(true);
            else setWizardOpen(true);
          }}
          settingsEnabled={loaded && !exporting}
          latestResultAvailable={Boolean(resultTray && resultHidden)}
          latestResultButtonRef={latestResultButtonRef}
          onReopenResult={reopenLatestResult}
        />
        {view === "home" ? (
          <section
            className="translator-view-panel is-active"
            aria-label="Translation overview"
          >
            <Dashboard
              scan={scan}
              scanning={scanning}
              lastScanAt={lastScanAt}
              now={now}
              languageLine={languageLine}
              onScan={handleScan}
              scanEnabled={configured && !scanning && !exporting}
              onOpenMod={openMod}
              onBrowse={() => {
                setView("work");
              }}
              lastOpened={lastOpened}
              onShowScanDetails={scan ? () => openLatestScan(false) : undefined}
              onOpenOverviewFilter={openOverviewFilter}
              lastExport={lastSuccessfulExport}
              onShowLastExport={
                lastSuccessfulExport
                  ? () => {
                      void openFolder(lastSuccessfulExport.folder);
                    }
                  : undefined
              }
            />
          </section>
        ) : (
          <section
            className="translator-view-panel is-active"
            aria-label="Translation workspace"
          >
            <div
              className="workspace translator-workbench"
              style={
                {
                  "--translator-mod-pane-width": `${modsWidth}px`,
                } as CSSProperties
              }
            >
              <section
                className={`panel panel--mods translator-mod-pane${modsCollapsed ? " is-collapsed" : ""}`}
                aria-label="Mod list"
              >
                <div className="panel__header translator-pane-title">
                  <div>
                    <span className="translator-pane-heading">
                      Mods
                      {scan && (
                        <>
                          {" · "}
                          <span className="translator-pane-count">
                            {scan.modCount}
                          </span>
                        </>
                      )}
                    </span>
                    {configured && (
                      <span className="panel__header-meta">
                        {scan && inProgressMods > 0 && (
                          <>
                            <span className="panel__header-tail">
                              <span className="translator-pane-count">
                                {inProgressMods}
                              </span>{" "}
                              in progress
                            </span>
                            <span
                              className="panel__header-tail"
                              aria-hidden="true"
                            >
                              ·
                            </span>
                          </>
                        )}
                        <button
                          className="panel__header-tail translator-kicker-action"
                          type="button"
                          aria-label={
                            attentionSkippedCount == null
                              ? "Skipped components unavailable; open scan diagnostics"
                              : `${attentionSkippedCount} skipped ${attentionSkippedCount === 1 ? "component" : "components"}; open scan diagnostics`
                          }
                          title="Open structured scan diagnostics"
                          onClick={() => openLatestScan(true)}
                        >
                          Skipped ·{" "}
                          {attentionSkippedCount == null ? (
                            "Unavailable"
                          ) : (
                            <span className="translator-pane-count">
                              {attentionSkippedCount}
                            </span>
                          )}
                        </button>
                        {scan && scan.warnings.length > 0 && (
                          <>
                            <span
                              className="panel__header-tail"
                              aria-hidden="true"
                            >
                              ·
                            </span>
                            <button
                              className="panel__warn translator-kicker-action"
                              type="button"
                              onClick={() => openLatestScan(true)}
                            >
                              {scan.warnings.length}{" "}
                              {scan.warnings.length === 1
                                ? "warning"
                                : "warnings"}
                            </button>
                          </>
                        )}
                      </span>
                    )}
                  </div>
                  <div className="translator-pane-title-actions">
                    <button
                      className="translator-icon-button translator-mod-pane-toggle"
                      type="button"
                      aria-label={
                        modsCollapsed ? "Expand mod list" : "Collapse mod list"
                      }
                      aria-expanded={!modsCollapsed}
                      title="Collapse or expand mod list"
                      onClick={() =>
                        setModsCollapsed((collapsed) => !collapsed)
                      }
                    >
                      {modsCollapsed ? (
                        <PanelLeftOpen aria-hidden />
                      ) : (
                        <PanelLeftClose aria-hidden />
                      )}
                    </button>
                  </div>
                </div>
                {scan && (
                  <input
                    className="modlist__search translator-search"
                    type="search"
                    placeholder="Filter mods …"
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
                    onClearQuery={() => setModQuery("")}
                  />
                ) : (
                  <div className="panel__empty">
                    {scanError ??
                      (scanning ? "Scanning…" : "No mods scanned yet.")}
                  </div>
                )}
              </section>
              <div
                className="splitter translator-pane-splitter"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize mod list"
                aria-valuemin={260}
                aria-valuemax={520}
                aria-valuenow={modsWidth}
                tabIndex={0}
                onMouseDown={startResize}
                onKeyDown={resizePaneWithKeyboard}
              />
              <main
                className="panel panel--strings translator-string-pane"
                aria-label="String table"
              >
                <StringTable
                  mod={selectedMod}
                  mods={scan?.mods ?? []}
                  scope={stringScope}
                  onScopeChange={setStringScope}
                  identityFilter={scanStringFilter?.identities}
                  identityFilterLabel={scanStringFilter?.label}
                  search={search}
                  onSearchChange={setSearch}
                  statusFilter={statusFilter}
                  onStatusFilterChange={setStatusFilter}
                  issuesOnly={issuesOnly}
                  onIssuesOnlyChange={setIssuesOnly}
                  initialSort={tableSort}
                  onSortChange={setTableSort}
                  initialColumnWidths={tableColumnWidths}
                  onColumnWidthsChange={setTableColumnWidths}
                  targetLanguageLabel={languageLine}
                  targetLanguageCode={targetLang ?? undefined}
                  localAiModel={localAiReady ? llm!.model : undefined}
                  liveAiEngines={liveAiEngines}
                  defaultAiEngine={aiSettings.defaultEngine}
                  onRunAi={runAi}
                  onCancelAi={cancelAiRun}
                  headerMeta={
                    lastScanAt
                      ? `scanned ${Math.max(0, Math.round((now - lastScanAt) / 60_000))} min ago`
                      : "scan time unavailable"
                  }
                  glossary={glossary}
                  onLlmBatchExportForMod={llmBatchExport}
                  onModCountsChange={handleCountsChange}
                  onOpenMod={openMod}
                  onClearFilters={() => {
                    setSearch("");
                    setStatusFilter("all");
                    setIssuesOnly(false);
                    setScanStringFilter(null);
                  }}
                  onBulkApplied={handleBulkApplied}
                  onAiBatchFinished={handleAiBatchFinished}
                  onNotify={notify}
                  onOpenEngineSettings={() => {
                    setSettingsPage("ai");
                    if (settings) setSettingsOpen(true);
                    else setWizardOpen(true);
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
            </div>
          </section>
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
            initialPage={settingsPage}
            onSave={handleSaveSettings}
            onClose={() => {
              setSettingsOpen(false);
              void refreshAiAvailability();
            }}
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
            focusDiagnostics={scanDiagnosticsFocus}
            retainedResult={scanDialogRetained}
            onOpenAddedStrings={() => openScanStrings("added")}
            onReviewChangedSources={() => openScanStrings("changed")}
            onClose={closeScanDialog}
          />
        )}
        {resultTray && !resultHidden && (
          <ResultTray
            data={resultTray}
            history={operationHistory}
            selectedHistoryId={selectedHistoryId}
            onSelectHistory={selectHistoryEntry}
            onToggle={() =>
              setResultTray((current) =>
                current
                  ? { ...current, collapsed: !current.collapsed }
                  : current,
              )
            }
            toggleButtonRef={resultToggleButtonRef}
            onClose={() => {
              setResultHidden(true);
              window.requestAnimationFrame(() =>
                latestResultButtonRef.current?.focus(),
              );
            }}
            onInspect={inspectResultProblem}
            onRetry={
              resultTray.kind === "export"
                ? retryResultExport
                : resultTray.kind === "import"
                  ? () => {
                      setImportDialogInitialError(null);
                      setImportDialogPath(null);
                    }
                  : undefined
            }
            onOpenFolder={(path) => void openFolder(path)}
            onOpenReview={
              (resultTray.kind === "import" && resultTray.summary?.imported) ||
              resultTray.kind === "ai-batch" ||
              (resultTray.kind === "history" &&
                (resultTray.entry.kind === "import" ||
                  resultTray.entry.kind === "ai") &&
                resultTray.entry.itemCount > 0)
                ? openResultReviewQueue
                : undefined
            }
            onUndoBulk={
              selectedHistoryEntry?.canUndo ? undoLatestBulk : undefined
            }
            onNotify={(message) => notify(message, "success")}
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
            existingFiles={exportConfirm.existingFiles}
            newFiles={exportConfirm.newFiles}
            mods={exportConfirm.mods}
            willWrite={exportConfirm.willWrite}
            openOmitted={exportConfirm.openOmitted}
            changedIncluded={exportConfirm.changedIncluded}
            reviewIncluded={exportConfirm.reviewIncluded}
            acceptedMismatches={exportConfirm.acceptedMismatches}
            blockingValidationAvailable
            blockingProblem={exportConfirm.blockingProblem}
            onInspectProblem={
              exportConfirm.blockingProblem
                ? () => {
                    const problem = exportConfirm.blockingProblem;
                    if (!problem) return;
                    setExportConfirm(null);
                    inspectResultProblem({
                      id: problemId(
                        problem.modUniqueId,
                        problem.relativeDir,
                        problem.key,
                      ),
                      modUniqueId: problem.modUniqueId,
                      modName: problem.modName,
                      relativeDir: problem.relativeDir,
                      key: problem.key,
                      reason: problem.reason,
                      resolved: false,
                    });
                  }
                : undefined
            }
            existingTargetPaths={exportConfirm.existingTargetPaths}
            newTargetPaths={exportConfirm.newTargetPaths}
            lastExportLabel={
              lastSuccessfulExport
                ? lastSuccessfulExport.label.replace(
                    /^Last export/,
                    "Previous export",
                  )
                : null
            }
            onCancel={() => setExportConfirm(null)}
            onConfirm={() => {
              const kind = exportConfirm.kind;
              const modUniqueId = exportConfirm.modUniqueId;
              setExportConfirm(null);
              if (kind === "selected") {
                const mod = scan?.mods.find(
                  (candidate) => candidate.uniqueId === modUniqueId,
                );
                if (mod) void handleExport(mod);
              } else void handleExportAll();
            }}
          />
        )}
        {(zipPreview || zipError || zipContext) && !releaseNotes && (
          <TranslationZipDialog
            key={zipPreview?.defaultFileName ?? "loading"}
            preview={zipPreview}
            componentCount={zipContext?.components.length ?? null}
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
        {importDialogPath !== undefined && selectedMod && targetLang && (
          <ImportBatchDialog
            key={`${selectedMod.uniqueId}:${importDialogPath ?? "picker"}`}
            targetName={selectedMod.name}
            targetLanguage={languageLine}
            initialPath={importDialogPath}
            initialError={importDialogInitialError}
            onChooseFile={pickLlmBatchFile}
            onPreflight={(path) =>
              preflightLlmBatchPath(
                selectedMod.uniqueId,
                filesOf(selectedMod),
                path,
              )
            }
            onImport={importSelectedBatch}
            canSwitchToMatchingMod={(modUniqueId) =>
              Boolean(
                scan?.mods.some(
                  (candidate) => candidate.uniqueId === modUniqueId,
                ),
              )
            }
            onSwitchToMatchingMod={
              scan?.mods.some(
                (candidate) => candidate.uniqueId !== selectedMod.uniqueId,
              )
                ? (modUniqueId) => {
                    if (
                      !scan?.mods.some(
                        (candidate) => candidate.uniqueId === modUniqueId,
                      )
                    )
                      return;
                    openMod(modUniqueId);
                  }
                : undefined
            }
            onClose={() => {
              setImportDialogPath(undefined);
              setImportDialogInitialError(null);
            }}
          />
        )}
        {llmExportDialog && (
          <LlmBatchExportDialog
            eligibleCount={llmExportDialog.items.length}
            modName={llmExportDialog.mod.name}
            suggestedFileName={`${llmExportDialog.mod.uniqueId.replace(/[<>:"/\\|?*]+/g, ".")}.llm-batch.json`}
            onChooseDestination={() =>
              pickLlmBatchDestination(
                `${llmExportDialog.mod.uniqueId.replace(/[<>:"/\\|?*]+/g, ".")}.llm-batch.json`,
              )
            }
            onSave={savePendingLlmBatch}
            onClose={() => setLlmExportDialog(null)}
          />
        )}
        {toast && (
          <div
            className={`translator-toast is-${toast.tone}`}
            role={toast.tone === "error" ? "alert" : "status"}
            aria-live={toast.tone === "error" ? "assertive" : "polite"}
            data-visible="true"
            key={toast.id}
          >
            {toast.tone === "success" ? (
              <CheckCircle2 aria-hidden />
            ) : toast.tone === "warning" ? (
              <AlertTriangle aria-hidden />
            ) : toast.tone === "error" ? (
              <CircleX aria-hidden />
            ) : (
              <Info aria-hidden />
            )}
            <span>{toast.message}</span>
            {toast.tone === "error" && (
              <button
                className="translator-toast-dismiss"
                type="button"
                aria-label="Dismiss notification"
                onClick={() => setToast(null)}
              >
                <X aria-hidden />
              </button>
            )}
          </div>
        )}
      </div>
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
      className="translator-native-drop-state translator-file-choice translator-drop-zone is-dragging"
      role="status"
      aria-live="polite"
      data-drop-valid={valid ? "true" : "false"}
    >
      <span>
        <strong>{title}</strong>
        <br />
        <code>{paths.length === 1 ? paths[0] : detail}</code>
      </span>
      <span className="translator-kicker">
        {paths.length === 1 ? detail : `${paths.length} files selected`}
      </span>
    </div>
  );
}

function AppToolbar({
  activeView,
  onWorkspace,
  onOverview,
  onScan,
  scanEnabled,
  scanning,
  onExport,
  exportEnabled,
  onExportAll,
  exportAllEnabled,
  exporting,
  checkingExportReadiness,
  onBuildZip,
  buildZipEnabled,
  onReleaseNotes,
  releaseNotesEnabled,
  onImportBatch,
  importBatchEnabled,
  onOpenSettings,
  settingsEnabled,
  latestResultAvailable,
  latestResultButtonRef,
  onReopenResult,
}: {
  activeView: "workspace" | "overview";
  onWorkspace: () => void;
  onOverview: () => void;
  onScan: () => void;
  scanEnabled: boolean;
  scanning: boolean;
  onExport: () => void;
  exportEnabled: boolean;
  onExportAll: () => void;
  exportAllEnabled: boolean;
  exporting: boolean;
  checkingExportReadiness: boolean;
  onBuildZip: () => void;
  buildZipEnabled: boolean;
  onReleaseNotes: () => void;
  releaseNotesEnabled: boolean;
  onImportBatch: () => void;
  importBatchEnabled: boolean;
  onOpenSettings: () => void;
  settingsEnabled: boolean;
  latestResultAvailable: boolean;
  latestResultButtonRef: React.RefObject<HTMLButtonElement | null>;
  onReopenResult: () => void;
}) {
  const [exportOpen, setExportOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const exportTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!exportOpen) return;
    const close = (event: PointerEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (
        event instanceof PointerEvent &&
        event.target instanceof Node &&
        menuRef.current?.contains(event.target)
      ) {
        return;
      }
      setExportOpen(false);
      if (event instanceof KeyboardEvent) exportTriggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [exportOpen]);

  function run(action: () => void) {
    setExportOpen(false);
    action();
  }

  function focusFirstMenuItem() {
    window.requestAnimationFrame(() => {
      const items = Array.from(
        menuRef.current?.querySelectorAll<HTMLButtonElement>(
          '[role="menuitem"]:not(:disabled)',
        ) ?? [],
      );
      items.forEach((item, index) => {
        item.tabIndex = index === 0 ? 0 : -1;
      });
      items[0]?.focus();
    });
  }

  function handleExportMenuKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      ),
    );
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = current;
    if (event.key === "ArrowDown") next = (current + 1) % items.length;
    else if (event.key === "ArrowUp")
      next = (current - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else return;
    event.preventDefault();
    items.forEach((item, index) => {
      item.tabIndex = index === next ? 0 : -1;
    });
    items[next].focus();
  }

  return (
    <div className="translator-commandbar">
      <nav className="translator-command-nav" aria-label="Main views">
        <button
          className="translator-nav-button"
          type="button"
          aria-pressed={activeView === "overview"}
          onClick={onOverview}
        >
          <LayoutDashboard aria-hidden /> Overview
        </button>
        <button
          className="translator-nav-button"
          type="button"
          aria-pressed={activeView === "workspace"}
          onClick={onWorkspace}
        >
          <Table2 aria-hidden /> Workspace
        </button>
      </nav>
      <div className="translator-command-actions">
        <button
          className="translator-button translator-button-quiet"
          type="button"
          aria-label="Scan mods"
          title="Scan mods"
          onClick={onScan}
          disabled={!scanEnabled}
        >
          <RefreshCw aria-hidden className={scanning ? "is-spinning" : ""} />
          <span className="translator-action-label-compact">
            {scanning ? "Scanning…" : "Scan"}
          </span>
        </button>
        <button
          className="translator-button translator-button-quiet"
          type="button"
          aria-label="Import LLM batch"
          title="Import LLM batch"
          onClick={onImportBatch}
          disabled={!importBatchEnabled}
        >
          <Download aria-hidden />
          <span className="translator-action-label-compact">Import …</span>
        </button>
        <div className="translator-menu" ref={menuRef}>
          <button
            ref={exportTriggerRef}
            className="translator-button translator-button-quiet"
            type="button"
            aria-label="Export actions"
            title="Export actions"
            aria-haspopup="menu"
            aria-expanded={exportOpen}
            onClick={() => {
              setExportOpen((open) => {
                if (!open) focusFirstMenuItem();
                return !open;
              });
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setExportOpen(true);
                focusFirstMenuItem();
              }
            }}
            disabled={
              !(exportEnabled || exportAllEnabled || buildZipEnabled) ||
              exporting
            }
          >
            <Upload aria-hidden />
            <span className="translator-action-label-compact">
              {checkingExportReadiness
                ? "Checking…"
                : exporting
                  ? "Exporting…"
                  : "Export …"}
            </span>
          </button>
          {exportOpen && (
            <div
              className="translator-popover"
              role="menu"
              aria-label="Export"
              onKeyDown={handleExportMenuKey}
              onBlur={(event) => {
                const next = event.relatedTarget;
                if (
                  !(next instanceof Node) ||
                  !event.currentTarget.contains(next)
                ) {
                  setExportOpen(false);
                }
              }}
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => run(onExport)}
                disabled={!exportEnabled}
              >
                <FolderUp aria-hidden /> Export current mod
              </button>
              <div className="translator-popover-divider" role="separator" />
              <button
                type="button"
                role="menuitem"
                onClick={() => run(onBuildZip)}
                disabled={!buildZipEnabled}
              >
                <Archive aria-hidden /> Build translation ZIP
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => run(onReleaseNotes)}
                disabled={!releaseNotesEnabled}
              >
                <NotebookPen aria-hidden /> Translation notes
              </button>
              <div className="translator-popover-divider" role="separator" />
              <span className="translator-popover-note" role="presentation">
                Advanced
              </span>
              <button
                type="button"
                role="menuitem"
                onClick={() => run(onExportAll)}
                disabled={!exportAllEnabled}
              >
                <Folders aria-hidden /> Export all mods …
              </button>
            </div>
          )}
        </div>
        <button
          ref={latestResultButtonRef}
          className="translator-button translator-button-quiet"
          type="button"
          title="Reopen the latest operation result"
          data-action="reopen-result"
          hidden={!latestResultAvailable}
          onClick={onReopenResult}
        >
          <FileCheck2 aria-hidden /> Latest result
        </button>
        <button
          className="translator-button translator-button-quiet"
          type="button"
          aria-label="Settings"
          title="Settings"
          onClick={onOpenSettings}
          disabled={!settingsEnabled}
        >
          <SettingsIcon aria-hidden />
          <span className="translator-action-label-compact">Settings</span>
        </button>
      </div>
    </div>
  );
}
