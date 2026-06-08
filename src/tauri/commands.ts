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

export interface AppSettings {
  stardewPath: string | null;
  modsPath: string | null;
  sourceLang: string;
  targetLang: string | null;
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

export type ModStatus = "none" | "untranslated" | "imported";

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

export function openUrl(url: string): Promise<void> {
  return invoke<void>("open_url", { url });
}

export function loadSettings(): Promise<AppSettings> {
  return invoke<AppSettings>("load_settings");
}

export function saveSettings(settings: AppSettings): Promise<void> {
  return invoke<void>("save_settings", { settings });
}
