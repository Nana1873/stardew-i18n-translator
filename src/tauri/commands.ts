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

export function loadSettings(): Promise<AppSettings> {
  return invoke<AppSettings>("load_settings");
}

export function saveSettings(settings: AppSettings): Promise<void> {
  return invoke<void>("save_settings", { settings });
}
