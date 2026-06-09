/**
 * Typed wrappers around the Tauri backend commands (see src-tauri/src/lib.rs).
 * Keeping invoke calls in one place gives the rest of the UI a plain async API.
 */
import { invoke } from "@tauri-apps/api/core";

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
}

export interface AppSettings {
  stardewPath: string | null;
  modsPath: string | null;
  sourceLang: string;
  targetLang: string | null;
  /** Optional local-LLM connection (M6); null until AI translation is set up. */
  llm?: LlmSettings | null;
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
  /** 0–1. */
  progress: number;
  status: ModStatus;
}

export interface ScanResult {
  mods: ScannedMod[];
  warnings: string[];
  modCount: number;
  fileCount: number;
}

export function scanMods(modsPath: string, targetLang: string): Promise<ScanResult> {
  return invoke<ScanResult>("scan_mods", { modsPath, targetLang });
}

export type StringStatus =
  | "untranslated"
  | "translated"
  | "outdated"
  | "not-translatable"
  // AI suggestion (M6 local LLM) awaiting human review; confirmed → translated.
  | "review-needed";

export interface StringRow {
  key: string;
  source: string;
  target: string;
  /** Whether the key exists in the target file (distinguishes "" from absent). */
  targetPresent: boolean;
  status: StringStatus;
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

export interface ExportFileInput {
  relativeDir: string;
  defaultPath: string;
  targetPath: string;
}

export interface SkippedKey {
  relativeDir: string;
  key: string;
  reason: string;
}

export interface ExportFileResult {
  relativeDir: string;
  targetPath: string;
  written: boolean;
  backedUp: boolean;
  writtenKeys: number;
  untranslated: number;
  notTranslatable: number;
  outdated: number;
  reviewNeeded: number;
}

export interface ExportResult {
  files: ExportFileResult[];
  skipped: SkippedKey[];
  filesWritten: number;
  totalWrittenKeys: number;
  totalUntranslated: number;
  totalNotTranslatable: number;
  totalOutdated: number;
  totalReviewNeeded: number;
}

export function exportMod(
  modUniqueId: string,
  files: ExportFileInput[],
): Promise<ExportResult> {
  return invoke<ExportResult>("export_mod", { modUniqueId, files });
}

export interface GlossaryInfo {
  targetLang: string;
  termCount: number;
}

export interface GlossaryStatus {
  unpackedPresent: boolean;
  cached: GlossaryInfo | null;
}

export function buildGlossary(stardewPath: string, targetLang: string): Promise<GlossaryInfo> {
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
): Promise<TranslationResult> {
  return invoke<TranslationResult>("translate_string", {
    baseUrl,
    model,
    source,
    targetLanguage,
  });
}

export function openUrl(url: string): Promise<void> {
  return invoke<void>("open_url", { url });
}

export function loadSettings(): Promise<AppSettings> {
  return invoke<AppSettings>("load_settings");
}

export function saveSettings(settings: AppSettings): Promise<void> {
  return invoke<void>("save_settings", { settings });
}
