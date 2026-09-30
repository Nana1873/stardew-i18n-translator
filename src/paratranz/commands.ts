import { invoke } from "@tauri-apps/api/core";
import type { LlmImportPreflight, LlmImportSummary } from "../tauri/commands";

export interface ParaTranzFile {
  id: number;
  name: string;
}
export interface ParaTranzConnection {
  project: {
    id: number;
    name: string;
    source: string;
    dest: string;
    privacy: number;
  };
  files: ParaTranzFile[];
}
export interface ParaTranzBinding {
  relativeDir: string;
  fileId: number | null;
}
export interface ParaTranzPreview {
  previewId: number;
  preflight: LlmImportPreflight;
}

export const paraTranzConnect = (projectId: number, token: string) =>
  invoke<ParaTranzConnection>("paratranz_connect", { projectId, token });
export const paraTranzDisconnect = () => invoke<void>("paratranz_disconnect");
export const paraTranzConnection = () =>
  invoke<ParaTranzConnection | null>("paratranz_connection");
export const paraTranzPreview = (
  modUniqueId: string,
  bindings: ParaTranzBinding[],
) => invoke<ParaTranzPreview>("paratranz_preview", { modUniqueId, bindings });
export const paraTranzImport = (previewId: number) =>
  invoke<LlmImportSummary>("paratranz_import", { previewId });
export const paraTranzUpload = (
  modUniqueId: string,
  bindings: ParaTranzBinding[],
) => invoke<ParaTranzFile[]>("paratranz_upload", { modUniqueId, bindings });
