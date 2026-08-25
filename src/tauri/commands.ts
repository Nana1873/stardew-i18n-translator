/**
 * Typed wrappers around the Tauri backend commands (see src-tauri/src/lib.rs).
 * Keeping invoke calls in one place gives the rest of the UI a plain async API.
 */
import { invoke } from "@tauri-apps/api/core";
import type { ShortcutSettings } from "../shortcuts";

export interface DetectedInstall {
  stardewPath: string;
  modsPath: string;
  source: string;
}

export interface LlmSettings {
  /** UI preset hint: "lmstudio" | "ollama" | "custom". */
  provider: string;
  /** OpenAI-compatible base URL, e.g. http://localhost:1234/v1. */
  baseUrl: string;
  /** Selected model id. */
  model: string;
  /** Optional sampling temperature; absent = low default (0.2). */
  temperature?: number | null;
}

export interface AppSettings {
  stardewPath: string | null;
  modsPath: string | null;
  sourceLang: string;
  targetLang: string | null;
  /** Optional local-LLM connection; null until AI translation is set up. */
  llm?: LlmSettings | null;
  /** User overrides for the keyboard shortcut catalog. */
  shortcuts?: ShortcutSettings;
  /** Dashboard resume history stored in portable settings. */
  lastOpened?: Record<string, number>;
  /** Whether rotating local diagnostic logs are written. Defaults to true. */
  diagnosticLogging?: boolean;
}

export function detectStardew(): Promise<DetectedInstall | null> {
  return invoke<DetectedInstall | null>("detect_stardew");
}

export function validateStardewPath(path: string): Promise<boolean> {
  return invoke<boolean>("validate_stardew_path", { path });
}

export function defaultModsPath(stardewPath: string): Promise<string> {
  return invoke<string>("default_mods_path", { stardewPath });
}

export function pickFolder(title?: string): Promise<string | null> {
  return invoke<string | null>("pick_folder", { title });
}

export type ModStatus = "none" | "untranslated" | "translated";

export interface ScannedI18nFile {
  relativeDir: string;
  defaultPath: string;
  targetPath: string;
  targetExists: boolean;
  totalKeys: number;
  translatedKeys: number;
  /** Source keys whose saved status is an unreviewed AI suggestion. */
  reviewNeeded: number;
}

export interface ScannedMod {
  uniqueId: string;
  name: string;
  version: string;
  nexusId: number | null;
  packageId: string;
  folderPath: string;
  i18nFiles: ScannedI18nFile[];
  totalKeys: number;
  translatedKeys: number;
  /** Unreviewed AI suggestions across all i18n files (dashboard queue). */
  reviewNeeded: number;
  /** 0–1. */
  progress: number;
  status: ModStatus;
  /** Per-status string counts. Not part of the scan payload — filled
   * client-side once the mod's rows are loaded; drives the needs-review
   * header tail and the status-filter counts. */
  statusCounts?: Record<StringStatus, number>;
}

export interface ScanResult {
  mods: ScannedMod[];
  warnings: string[];
  extraKeys?: ExtraKeyDiagnostic[];
  modCount: number;
  fileCount: number;
}

export interface ExtraKeyDiagnostic {
  modName: string;
  relativeDir: string;
  targetPath: string;
  key: string;
}

export function scanMods(
  modsPath: string,
  targetLang: string,
): Promise<ScanResult> {
  return invoke<ScanResult>("scan_mods", { modsPath, targetLang });
}

/** Current status model (SPEC §9). Legacy `not-translatable` values migrate
 * away because keeping a string in English is now an explicit identical translation
 * ("Keep original"), so outdated detection covers those strings too. The
 * backend migrates legacy stored values on load. */
export type StringStatus =
  | "untranslated"
  | "translated"
  | "outdated"
  // Local-AI suggestion awaiting human review; confirmed -> translated.
  | "review-needed";

export interface StringRow {
  key: string;
  source: string;
  target: string;
  /** Whether the key exists in the target file (distinguishes "" from absent). */
  targetPresent: boolean;
  status: StringStatus;
  /** The translator explicitly accepted this exact protected-token mismatch. */
  tokenMismatchAccepted: boolean;
  /** Section this key belongs to — the nearest standalone `//` comment line
   * above it in default.json (SPEC §7); null/absent = no section. */
  section?: string | null;
}

export function loadStrings(
  modUniqueId: string,
  relativeDir: string,
  defaultPath: string,
  targetPath: string,
): Promise<StringRow[]> {
  return invoke<StringRow[]>("load_strings", {
    modUniqueId,
    relativeDir,
    defaultPath,
    targetPath,
  });
}

export function saveString(
  modUniqueId: string,
  relativeDir: string,
  key: string,
  target: string,
  status: StringStatus,
  source: string,
  tokenMismatchAccepted = false,
): Promise<void> {
  const storedStatus =
    tokenMismatchAccepted && status === "translated"
      ? "translated-token-mismatch-accepted"
      : tokenMismatchAccepted && status === "review-needed"
        ? "review-needed-token-mismatch-accepted"
        : status;
  return invoke<void>("save_string", {
    modUniqueId,
    relativeDir,
    key,
    target,
    status: storedStatus,
    source,
  });
}

export interface SaveStringEntry {
  relativeDir: string;
  key: string;
  target: string;
  status:
    | StringStatus
    | "translated-token-mismatch-accepted"
    | "review-needed-token-mismatch-accepted";
  source: string;
}

/**
 * Save many strings of one mod in a single backend write. Bulk actions must
 * use this — N parallel saveString calls race the per-mod state file.
 */
export function saveStrings(
  modUniqueId: string,
  entries: SaveStringEntry[],
): Promise<void> {
  return invoke<void>("save_strings", { modUniqueId, entries });
}

export interface ExportFileInput {
  relativeDir: string;
  defaultPath: string;
  targetPath: string;
}

export interface SkippedKey {
  relativeDir: string;
  key: string;
  reason: string;
  /** UI-only context added after export so the summary can navigate back to
   * the affected mod. The Rust command does not need to return these fields. */
  modUniqueId?: string;
  modName?: string;
}

export interface ExportFileResult {
  relativeDir: string;
  targetPath: string;
  written: boolean;
  /** Every translation was cleared, so the stale target file was removed (after a backup). */
  removed: boolean;
  backedUp: boolean;
  writtenKeys: number;
  untranslated: number;
  outdated: number;
  reviewNeeded: number;
  /** Keys in the existing target file that default.json no longer contains —
   * dropped by the rewrite (kept in .bak), reported so nothing is pruned silently. */
  orphanKeys: string[];
}

export interface ExportResult {
  files: ExportFileResult[];
  skipped: SkippedKey[];
  filesWritten: number;
  /** Target files removed because every translation was cleared. */
  filesRemoved: number;
  totalWrittenKeys: number;
  totalUntranslated: number;
  totalOutdated: number;
  totalReviewNeeded: number;
  totalOrphanKeys: number;
  /** Token errors prevented every file in this mod from being written. */
  blocked: boolean;
}

export function exportMod(
  modUniqueId: string,
  files: ExportFileInput[],
): Promise<ExportResult> {
  return invoke<ExportResult>("export_mod", { modUniqueId, files });
}

export interface ExportModInput {
  modUniqueId: string;
  /** Display metadata only; the backend authorizes paths and state by ID. */
  modName: string;
  files: ExportFileInput[];
}

export interface ExportModResult {
  modUniqueId: string;
  modName: string;
  result: ExportResult;
}

export interface ExportAllResult {
  mods: ExportModResult[];
  modsChanged: number;
  filesWritten: number;
  filesRemoved: number;
  totalWrittenKeys: number;
  totalUntranslated: number;
  totalOutdated: number;
  totalReviewNeeded: number;
  totalOrphanKeys: number;
  /** At least one mod blocked the complete transaction before any write. */
  blocked: boolean;
}

export function exportAllMods(
  mods: ExportModInput[],
): Promise<ExportAllResult> {
  return invoke<ExportAllResult>("export_all_mods", { mods });
}

export interface ZipComponentInput {
  uniqueId: string;
  name: string;
  version: string;
  folderPath: string;
  files: ExportFileInput[];
}

export interface ZipProblem {
  modUniqueId: string;
  modName: string;
  relativeDir: string;
  key: string;
  reason: string;
}

export interface ZipEntryPreview {
  modName: string;
  modVersion: string;
  archivePath: string;
  strings: number;
  totalSourceStrings: number;
  outdated: number;
  reviewNeeded: number;
}

export interface ZipPreview {
  packageName: string;
  selectedVersion: string;
  versionSource: string;
  versionConflicts: Array<{ modName: string; version: string }>;
  defaultFileName: string;
  targetLang: string;
  targetLanguage: string;
  entries: ZipEntryPreview[];
  omittedComponents: string[];
  warnings: string[];
  problems: ZipProblem[];
  totalStrings: number;
  totalSourceStrings: number;
}

export interface ZipBuildOutcome {
  path: string;
  folder: string;
  fileName: string;
  entries: number;
  strings: number;
}

export function previewTranslationZip(
  modsPath: string,
  packageName: string,
  targetLang: string,
  targetLanguage: string,
  components: ZipComponentInput[],
): Promise<ZipPreview> {
  return invoke<ZipPreview>("preview_translation_zip", {
    modsPath,
    packageName,
    targetLang,
    targetLanguage,
    components,
  });
}

export function pickTranslationZipDestination(
  defaultFileName: string,
): Promise<string | null> {
  return invoke<string | null>("pick_translation_zip_destination", {
    defaultFileName,
  });
}

export function buildTranslationZip(
  modsPath: string,
  packageName: string,
  targetLang: string,
  targetLanguage: string,
  components: ZipComponentInput[],
  destination: string,
  overwrite: boolean,
): Promise<ZipBuildOutcome> {
  return invoke<ZipBuildOutcome>("build_translation_zip", {
    request: {
      modsPath,
      packageName,
      targetLang,
      targetLanguage,
      components,
      destination,
      overwrite,
    },
  });
}

/** One string of an external LLM batch export. */
export interface LlmBatchItem {
  relativeDir: string;
  key: string;
  source: string;
}

export interface LlmExportOutcome {
  path: string;
  stringCount: number;
}

/**
 * Write the selected strings as an external LLM translation batch
 * (SPEC §11). The backend opens a save dialog; resolves null on cancel.
 */
export function exportLlmBatch(
  modUniqueId: string,
  items: LlmBatchItem[],
): Promise<LlmExportOutcome | null> {
  return invoke<LlmExportOutcome | null>("export_llm_batch", {
    modUniqueId,
    items,
  });
}

/** Choose an LLM batch destination without writing the batch yet. */
export function pickLlmBatchDestination(
  suggestedFileName: string,
): Promise<string | null> {
  return invoke<string | null>("pick_llm_batch_destination", {
    suggestedFileName,
  });
}

/** Write an LLM batch to a destination chosen by the user beforehand. */
export function exportLlmBatchToPath(
  modUniqueId: string,
  items: LlmBatchItem[],
  path: string,
): Promise<LlmExportOutcome> {
  return invoke<LlmExportOutcome>("export_llm_batch_to_path", {
    modUniqueId,
    items,
    path,
  });
}

export interface LlmImportSummary {
  /** Staged as review-needed. */
  imported: number;
  /** Untouched — already translated locally. */
  skippedTranslated: number;
  /** Empty translation values intentionally skipped. */
  unmatched: number;
  /** Imported, but identical to the English source. */
  identicalToSource: number;
  totalInFile: number;
}

export interface LlmImportTokenDifference {
  token: string;
  sourceCount: number;
  targetCount: number;
}

export interface LlmImportTokenIssue {
  relativeDir: string;
  key: string;
  differences: LlmImportTokenDifference[];
}

export interface LlmImportPreflight {
  batchModUniqueId: string;
  batchTargetLang: string;
  selectedModUniqueId: string;
  selectedTargetLang: string;
  modMatches: boolean;
  languageMatches: boolean;
  snapshotResult: "matched" | "mismatch" | "notChecked";
  suppliedStrings: number;
  matchedStrings: number;
  preservedLocal: number;
  skippedEmpty: number;
  identicalToSource: number;
  importable: number;
  protectedTokenIssues: LlmImportTokenIssue[];
  ready: boolean;
  blockingReason: string | null;
}

/**
 * Import a translated LLM batch/result file for one mod. The
 * backend opens a file picker; resolves null on cancel.
 */
export function importLlmBatch(
  modUniqueId: string,
  files: ExportFileInput[],
): Promise<LlmImportSummary | null> {
  return invoke<LlmImportSummary | null>("import_llm_batch", {
    modUniqueId,
    files,
  });
}

/** Pick a JSON result without importing it yet. Resolves null on cancel. */
export function pickLlmBatchFile(): Promise<string | null> {
  return invoke<string | null>("pick_llm_batch_file");
}

/** Analyze a selected batch against the current mod without writing state. */
export function preflightLlmBatchPath(
  modUniqueId: string,
  files: ExportFileInput[],
  path: string,
): Promise<LlmImportPreflight> {
  return invoke<LlmImportPreflight>("preflight_llm_batch_path", {
    modUniqueId,
    files,
    path,
  });
}

/** Import a drag-and-dropped LLM batch/result file for one selected mod. */
export function importLlmBatchPath(
  modUniqueId: string,
  files: ExportFileInput[],
  path: string,
): Promise<LlmImportSummary> {
  return invoke<LlmImportSummary>("import_llm_batch_path", {
    modUniqueId,
    files,
    path,
  });
}

/** Where a glossary's terms came from (mirrors Rust `GlossarySource`). */
export type GlossarySource = "official" | "communityPack";

export interface GlossaryInfo {
  targetLang: string;
  termCount: number;
  /** Provenance of the glossary; absent on older caches. */
  source?: GlossarySource;
  /** The community pack's display name, when `source` is `communityPack`. */
  packName?: string;
}

export interface GlossaryStatus {
  /** Direct game Content/Strings/*.xnb assets are available. */
  gameXnbPresent: boolean;
  /** StardewXnbHack-compatible Content (unpacked)/Strings JSON is available. */
  unpackedPresent: boolean;
  /** Any local game string source is available for glossary extraction. */
  sourceAvailable: boolean;
  cached: GlossaryInfo | null;
  /** A glossary.json exists but is old/invalid (untyped) — rebuild recommended. */
  outdatedCache: boolean;
  /**
   * For a game-unsupported language, whether an installed community language pack
   * was detected that can supply a glossary. Always false for supported
   * languages (they build from official content).
   */
  packAvailable: boolean;
  /** The detected community pack supplies direct Strings/*_<lang>.xnb assets. */
  packXnbAvailable: boolean;
  /** The detected community pack's display name, when `packAvailable`. */
  packName?: string;
}

export function buildGlossary(
  stardewPath: string,
  targetLang: string,
): Promise<GlossaryInfo> {
  return invoke<GlossaryInfo>("build_glossary", { stardewPath, targetLang });
}

export function glossaryStatus(
  stardewPath: string,
  targetLang: string,
): Promise<GlossaryStatus> {
  return invoke<GlossaryStatus>("glossary_status", { stardewPath, targetLang });
}

/** Category of an official glossary term (mirrors Rust `TermKind`). */
export type TermKind =
  | "item"
  | "bigCraftable"
  | "weapon"
  | "tool"
  | "clothing"
  | "npc"
  | "location"
  | "season";

/** One typed official term (mirrors Rust `GlossaryEntry`). */
export interface GlossaryEntry {
  source: string;
  target: string;
  kind: TermKind;
  /** Source `Strings/*` asset (provenance). */
  asset: string;
  /** Source key within the asset (provenance). */
  key: string;
}

export interface Glossary {
  /** Cache schema version (2 = typed entries). */
  format: number;
  sourceLang: string;
  targetLang: string;
  termCount: number;
  /** Typed official terms. */
  entries: GlossaryEntry[];
}

export function loadGlossary(targetLang: string): Promise<Glossary | null> {
  return invoke<Glossary | null>("load_glossary", { targetLang });
}

/**
 * List models from an OpenAI-compatible local server. Doubles as the
 * "Test connection" probe — resolving means the server is reachable.
 */
export function llmModels(baseUrl: string): Promise<string[]> {
  return invoke<string[]>("llm_models", { baseUrl });
}

export interface TranslationResult {
  text: string;
  /** Protected tokens the model still dropped after one retry (UI flags these). */
  missingTokens: string[];
  /** Injected glossary terms the result appears not to use ("En -> Target"). Soft hint. */
  glossaryMisses: string[];
}

/**
 * Translate one source string via the configured local LLM. Injects
 * matching glossary terms and validates protected tokens with one retry.
 */
export function translateString(
  baseUrl: string,
  model: string,
  source: string,
  targetLang: string,
  targetLanguage: string,
  section?: string | null,
  temperature?: number | null,
): Promise<TranslationResult> {
  return invoke<TranslationResult>("translate_string", {
    baseUrl,
    model,
    source,
    targetLang,
    targetLanguage,
    section: section ?? null,
    temperature: temperature ?? null,
  });
}

export function openUrl(url: string): Promise<void> {
  return invoke<void>("open_url", { url });
}

/**
 * Forward a caught frontend error into the backend diagnostic log file
 * (`data/logs`). Fire-and-forget: it never throws, so logging can't
 * mask the original error or break in a browser preview / test where the Tauri
 * bridge is absent.
 */
export function logFrontendError(context: string, message: string): void {
  void invoke("log_frontend_error", { context, message }).catch(() => {
    /* no Tauri bridge (browser preview / tests) — nothing to log to */
  });
}

/**
 * Open the portable `data/logs/` folder in the OS file manager so the
 * user can attach the current log file to a GitHub bug report.
 */
export function openLogsDir(): Promise<void> {
  return invoke<void>("open_logs_dir");
}

/** Open a mod's folder in the OS file manager. */
export function openModFolder(path: string): Promise<void> {
  return invoke<void>("open_mod_folder", { path });
}

export function openFolder(path: string): Promise<void> {
  return invoke<void>("open_folder", { path });
}

export function loadSettings(): Promise<AppSettings> {
  return invoke<AppSettings>("load_settings");
}

export function saveSettings(settings: AppSettings): Promise<void> {
  return invoke<void>("save_settings", { settings });
}
