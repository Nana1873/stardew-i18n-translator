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
  /** Optional local-LLM connection (M6); null until AI translation is set up. */
  llm?: LlmSettings | null;
  /** User overrides for the v1.1 keyboard shortcut catalog. */
  shortcuts?: ShortcutSettings;
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

/** v1.5 status model (SPEC §9): 4 statuses. `not-translatable` was removed —
 * keeping a string in English is now an explicit identical translation
 * ("Keep original"), so outdated detection covers those strings too. The
 * backend migrates legacy stored values on load. */
export type StringStatus =
  | "untranslated"
  | "translated"
  | "outdated"
  // AI suggestion (M6 local LLM) awaiting human review; confirmed → translated.
  | "review-needed";

export interface StringRow {
  key: string;
  source: string;
  target: string;
  /** Whether the key exists in the target file (distinguishes "" from absent). */
  targetPresent: boolean;
  status: StringStatus;
  /** Section this key belongs to — the nearest standalone `//` comment line
   * above it in default.json (SPEC §7.4); null/absent = no section. */
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
): Promise<void> {
  return invoke<void>("save_string", {
    modUniqueId,
    relativeDir,
    key,
    target,
    status,
    source,
  });
}

export interface SaveStringEntry {
  relativeDir: string;
  key: string;
  target: string;
  status: StringStatus;
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

/** One string of an external LLM batch export (M4). */
export interface LlmBatchItem {
  relativeDir: string;
  key: string;
  source: string;
  /** Nearest standalone `//` heading in default.json, used as AI context. */
  section?: string | null;
}

export interface LlmExportOutcome {
  path: string;
  stringCount: number;
  glossaryTerms: number;
}

/**
 * Write the selected strings as an external LLM translation batch
 * (M4, SPEC §11). The backend opens a save dialog; resolves null on cancel.
 */
export function exportLlmBatch(
  modUniqueId: string,
  modName: string,
  targetLang: string,
  targetLanguage: string,
  items: LlmBatchItem[],
): Promise<LlmExportOutcome | null> {
  return invoke<LlmExportOutcome | null>("export_llm_batch", {
    modUniqueId,
    modName,
    targetLang,
    targetLanguage,
    items,
  });
}

export interface LlmImportSummary {
  /** Staged as review-needed. */
  imported: number;
  /** Untouched — already translated locally. */
  skippedTranslated: number;
  /** Unknown key/directory, non-string or empty value. */
  unmatched: number;
  /** Imported, but missing a protected token (validation flags them). */
  tokenIssues: number;
  /** The keys behind tokenIssues — searchable in the table. */
  tokenIssueKeys: string[];
  /** Imported, but identical to the English source. */
  identicalToSource: number;
  totalInFile: number;
}

/**
 * Import a translated LLM batch/result file for one mod (M4). The
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

export interface GlossaryInfo {
  targetLang: string;
  termCount: number;
}

export interface GlossaryStatus {
  unpackedPresent: boolean;
  cached: GlossaryInfo | null;
}

export function buildGlossary(
  stardewPath: string,
  targetLang: string,
): Promise<GlossaryInfo> {
  return invoke<GlossaryInfo>("build_glossary", { stardewPath, targetLang });
}

export function glossaryStatus(stardewPath: string): Promise<GlossaryStatus> {
  return invoke<GlossaryStatus>("glossary_status", { stardewPath });
}

export interface Glossary {
  sourceLang: string;
  targetLang: string;
  termCount: number;
  /** english term -> target term. */
  terms: Record<string, string>;
}

export function loadGlossary(): Promise<Glossary | null> {
  return invoke<Glossary | null>("load_glossary");
}

/**
 * List models from an OpenAI-compatible local server (M6). Doubles as the
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
 * Translate one source string via the configured local LLM (M6). Injects
 * matching glossary terms and validates protected tokens with one retry.
 */
export function translateString(
  baseUrl: string,
  model: string,
  source: string,
  targetLanguage: string,
  section?: string | null,
  temperature?: number | null,
): Promise<TranslationResult> {
  return invoke<TranslationResult>("translate_string", {
    baseUrl,
    model,
    source,
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
 * (`Data/logs`, v1.1.1). Fire-and-forget: it never throws, so logging can't
 * mask the original error or break in a browser preview / test where the Tauri
 * bridge is absent.
 */
export function logFrontendError(context: string, message: string): void {
  void invoke("log_frontend_error", { context, message }).catch(() => {
    /* no Tauri bridge (browser preview / tests) — nothing to log to */
  });
}

/**
 * Open the portable `Data/logs/` folder in the OS file manager (v1.1.1) so the
 * user can attach the current log file to a GitHub bug report.
 */
export function openLogsDir(): Promise<void> {
  return invoke<void>("open_logs_dir");
}

export function loadSettings(): Promise<AppSettings> {
  return invoke<AppSettings>("load_settings");
}

export function saveSettings(settings: AppSettings): Promise<void> {
  return invoke<void>("save_settings", { settings });
}
