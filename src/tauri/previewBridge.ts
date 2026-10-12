/**
 * Browser preview bridge: a fake `window.__TAURI_INTERNALS__` so the React
 * app runs in a plain browser tab (`corepack pnpm dev:preview`) on synthetic
 * fixture data. Nothing touches the file system, the network, or real mods.
 *
 * Only loaded by `main.tsx` when Vite runs in `preview` mode during
 * development; production builds never include it. Every command the UI
 * calls is answered here with the same shapes `src-tauri/src/lib.rs` returns,
 * so screens, dialogs, and result notices can be reviewed in a browser.
 * Commands that only make sense with a native backend (ChatGPT sign-in,
 * glossary builds) reject with a clear message so their error paths show up.
 */
import type {
  AiRunProgress,
  AiRunResult,
  AiTranslationRequest,
  AppSettings,
  ExportAllResult,
  ExportFileInput,
  ExportModInput,
  ExportPreflight,
  ExportResult,
  Glossary,
  GlossaryStatus,
  LlmImportPreflight,
  LlmImportSummary,
  OperationHistoryEntry,
  SaveStringGroup,
  ScanResult,
  ScannedMod,
  StringRow,
  StringStatus,
  ZipBuildOutcome,
  ZipPreview,
} from "./commands";
import { TARGET_LANGUAGES } from "../languages";
import { validate } from "../strings/validation";
import {
  FIXTURE_GLOSSARY,
  FIXTURE_MODS,
  FIXTURE_SKIPPED,
  FIXTURE_WARNINGS,
  PREVIEW_GAME_PATH,
  PREVIEW_MODS_PATH,
  type FixtureMod,
} from "./previewFixtures";

type Handler = (payload: unknown) => void;
type Args = Record<string, unknown>;

const DEFAULT_TARGET_LANG = "de";

/** The target language chosen in the preview's settings (German by default). */
function targetLang(): string {
  return settings?.targetLang ?? DEFAULT_TARGET_LANG;
}

function targetLanguage(): string {
  const label =
    TARGET_LANGUAGES.find((language) => language.code === targetLang())
      ?.label ?? targetLang();
  return label.replace(/ \([^)]*\)$/, "");
}
const DOWNLOADS = "C:\\Preview\\Downloads";

interface RowState extends StringRow {
  /** Source as it was when the translation was saved (for Changed). */
  savedSource?: string;
}

interface HistoryRecord extends OperationHistoryEntry {
  snapshot?: Map<string, RowState>;
  /** Rows right after the edit; undo refuses when any changed since. */
  after?: Map<string, RowState>;
}

const rows = new Map<string, Map<string, RowState>>();
const history: HistoryRecord[] = [];
const cancelled = new Set<string>();
let settings: AppSettings;
let scanCount = 0;
let nextCallback = 1;
const callbacks = new Map<number, Handler>();
const listeners = new Map<number, { event: string; handler: Handler }>();

function seed(): void {
  rows.clear();
  for (const mod of FIXTURE_MODS) {
    const map = new Map<string, RowState>();
    for (const s of mod.strings) {
      const target = s.target ?? "";
      const present = s.target !== undefined;
      const blank = s.source.trim() === "" && target.trim() === "";
      map.set(s.key, {
        key: s.key,
        source: s.source,
        target,
        targetPresent: present,
        status: s.status ?? (blank ? "translated" : "untranslated"),
        tokenMismatchAccepted: Boolean(s.tokenMismatchAccepted),
        section: s.section ?? null,
        savedSource: s.status === "outdated" ? `${s.source} (old)` : s.source,
      });
    }
    rows.set(mod.uniqueId, map);
  }
  const fresh = new URLSearchParams(window.location.search).has("setup");
  settings = {
    stardewPath: fresh ? null : PREVIEW_GAME_PATH,
    modsPath: fresh ? null : PREVIEW_MODS_PATH,
    sourceLang: "default",
    targetLang: fresh ? null : DEFAULT_TARGET_LANG,
    llm: fresh
      ? null
      : {
          provider: "lmstudio",
          baseUrl: "http://localhost:1234/v1",
          model: "preview-local-model",
        },
    ai: {
      defaultEngine: "local",
      cloudReasoning: "medium",
      cloudQualityReview: true,
      cloudParallelBatches: 4,
    },
    workspace: {
      modSearch: "",
      stringSearch: "",
      stringScope: "mod",
      statusFilter: "all",
      issuesOnly: false,
      columnWidths: {},
    },
    diagnosticLogging: true,
  };
}

function modOf(uniqueId: string): FixtureMod {
  const mod = FIXTURE_MODS.find((m) => m.uniqueId === uniqueId);
  if (!mod) throw new Error(`Unknown mod ${uniqueId} in the browser preview.`);
  return mod;
}

function paths(mod: FixtureMod) {
  const dir = `${PREVIEW_MODS_PATH}\\${mod.folder}\\i18n`;
  return {
    folderPath: `${PREVIEW_MODS_PATH}\\${mod.folder}`,
    defaultPath: `${dir}\\default.json`,
    targetPath: `${dir}\\${targetLang()}.json`,
  };
}

function hasText(row: RowState): boolean {
  if (row.source.trim() === "" && row.target.trim() === "") return true;
  return row.target !== "" && row.status !== "untranslated";
}

function blockingIssues(row: RowState): string[] {
  if (row.target === "" || row.tokenMismatchAccepted) return [];
  return validate(row.source, row.target, row.targetPresent)
    .filter(
      (issue) =>
        issue.severity === "error" &&
        (issue.ruleId === "token-missing" || issue.ruleId === "token-added"),
    )
    .map((issue) => issue.message);
}

function scannedMod(mod: FixtureMod): ScannedMod {
  const map = rows.get(mod.uniqueId) ?? new Map<string, RowState>();
  const all = [...map.values()];
  const counts: Record<StringStatus, number> = {
    untranslated: 0,
    translated: 0,
    outdated: 0,
    "review-needed": 0,
  };
  let blank = 0;
  for (const row of all) {
    counts[row.status] += 1;
    if (row.source.trim() === "" && row.target.trim() === "") blank += 1;
  }
  const translated = all.filter(hasText).length;
  const review = counts["review-needed"];
  const { folderPath, defaultPath, targetPath } = paths(mod);
  return {
    uniqueId: mod.uniqueId,
    name: mod.name,
    version: mod.version,
    nexusId: mod.nexusId,
    packageId: mod.folder.split("\\")[0],
    folderPath,
    i18nFiles: [
      {
        relativeDir: "i18n",
        defaultPath,
        targetPath,
        targetExists: all.some((row) => row.targetPresent),
        totalKeys: all.length,
        translatedKeys: translated,
        noTranslationNeededKeys: blank,
        reviewNeeded: review,
      },
    ],
    totalKeys: all.length,
    translatedKeys: translated,
    noTranslationNeededKeys: blank,
    reviewNeeded: review,
    progress: all.length ? translated / all.length : 0,
    status:
      all.length === 0
        ? "none"
        : translated === all.length
          ? "translated"
          : "untranslated",
    statusCounts: counts,
  };
}

function scan(): ScanResult {
  scanCount += 1;
  return {
    mods: FIXTURE_MODS.map(scannedMod),
    warnings: FIXTURE_WARNINGS,
    skippedComponents: FIXTURE_SKIPPED,
    extraKeys: [],
    modCount: FIXTURE_MODS.length,
    fileCount: FIXTURE_MODS.length,
    // Like the backend: skips with a known component no longer block the
    // comparison, and the first scan starts at zero changes.
    sourceDeltas: {
      sourcesChanged: 0,
      stringsAdded: 0,
      stringsRemoved: 0,
      addedStrings: [],
      changedSources: [],
    },
  };
}

function normalizeStatus(raw: string): {
  status: StringStatus;
  accepted: boolean;
} {
  if (raw === "translated-token-mismatch-accepted")
    return { status: "translated", accepted: true };
  if (raw === "review-needed-token-mismatch-accepted")
    return { status: "review-needed", accepted: true };
  if (
    raw === "untranslated" ||
    raw === "translated" ||
    raw === "outdated" ||
    raw === "review-needed"
  )
    return { status: raw, accepted: false };
  return { status: "translated", accepted: false };
}

function saveRow(
  modUniqueId: string,
  key: string,
  target: string,
  rawStatus: string,
  source: string,
): void {
  const map = rows.get(modUniqueId);
  const row = map?.get(key);
  if (!map || !row) throw new Error(`Unknown string ${key} in ${modUniqueId}.`);
  const { status, accepted } = normalizeStatus(rawStatus);
  map.set(key, {
    ...row,
    target,
    targetPresent: target !== "" || row.targetPresent,
    status: target === "" && row.source.trim() !== "" ? "untranslated" : status,
    tokenMismatchAccepted: accepted,
    savedSource: source,
  });
}

function pushHistory(entry: HistoryRecord): OperationHistoryEntry {
  for (const old of history) old.canUndo = false;
  history.unshift(entry);
  while (history.length > 5) history.pop();
  const { snapshot: _snapshot, ...visible } = entry;
  return visible;
}

function visibleHistory(): OperationHistoryEntry[] {
  return history.map(({ snapshot: _snapshot, ...visible }) => visible);
}

function exportMod(
  modUniqueId: string,
  files: ExportFileInput[],
): ExportResult {
  const map = rows.get(modUniqueId) ?? new Map<string, RowState>();
  const result: ExportResult = {
    files: [],
    skipped: [],
    filesWritten: 0,
    filesRemoved: 0,
    totalWrittenKeys: 0,
    totalUntranslated: 0,
    totalOutdated: 0,
    totalReviewNeeded: 0,
    totalOrphanKeys: 0,
  };
  for (const file of files) {
    let written = 0;
    let untranslated = 0;
    let outdated = 0;
    let review = 0;
    for (const row of map.values()) {
      if (row.target === "") {
        if (row.source.trim() !== "") untranslated += 1;
        continue;
      }
      const problems = blockingIssues(row);
      if (problems.length) {
        result.skipped.push({
          relativeDir: file.relativeDir,
          key: row.key,
          reason: problems.join(" "),
        });
        continue;
      }
      written += 1;
      if (row.status === "outdated") outdated += 1;
      if (row.status === "review-needed") review += 1;
    }
    result.files.push({
      relativeDir: file.relativeDir,
      targetPath: file.targetPath,
      written: written > 0,
      removed: false,
      backedUp: map.size > 0 && [...map.values()].some((r) => r.targetPresent),
      writtenKeys: written,
      untranslated,
      outdated,
      reviewNeeded: review,
      orphanKeys: [],
    });
    if (written > 0) result.filesWritten += 1;
    result.totalWrittenKeys += written;
    result.totalUntranslated += untranslated;
    result.totalOutdated += outdated;
    result.totalReviewNeeded += review;
  }
  return result;
}

function zipPreview(packageName: string, ids: string[]): ZipPreview {
  const mods = FIXTURE_MODS.filter((m) => ids.includes(m.uniqueId));
  const entries = [];
  const problems = [];
  let total = 0;
  let totalSource = 0;
  for (const mod of mods) {
    const map = rows.get(mod.uniqueId) ?? new Map<string, RowState>();
    const all = [...map.values()];
    let strings = 0;
    let outdated = 0;
    let review = 0;
    for (const row of all) {
      if (row.target === "") continue;
      const bad = blockingIssues(row);
      if (bad.length) {
        problems.push({
          modUniqueId: mod.uniqueId,
          modName: mod.name,
          relativeDir: "i18n",
          key: row.key,
          reason: bad.join(" "),
        });
        continue;
      }
      strings += 1;
      if (row.status === "outdated") outdated += 1;
      if (row.status === "review-needed") review += 1;
    }
    if (strings === 0) continue;
    const installFolder = mod.folder.split("\\").pop() ?? mod.folder;
    entries.push({
      modUniqueId: mod.uniqueId,
      modName: mod.name,
      modVersion: mod.version,
      installFolder,
      archivePath: `${installFolder}/i18n/${targetLang()}.json`,
      strings,
      totalSourceStrings: all.length,
      outdated,
      reviewNeeded: review,
    });
    total += strings;
    totalSource += all.length;
  }
  const version = mods.length === 1 ? mods[0].version : "";
  return {
    packageName,
    selectedVersion: version,
    // Like the backend, name the component whose manifest gave the version.
    versionSource: mods.length === 1 ? mods[0].name : "",
    versionConflicts: [],
    defaultFileName: `${packageName}${version ? ` - ${version}` : ""} - ${targetLanguage()} (${targetLang()}).zip`,
    targetLang: targetLang(),
    targetLanguage: targetLanguage(),
    entries,
    omittedComponents: [],
    warnings: [],
    problems,
    totalStrings: total,
    totalSourceStrings: totalSource,
  };
}

function zipOutcome(destination: string, entries: number, strings: number) {
  const fileName = destination.split(/[\\/]/).pop() ?? destination;
  const folder = destination.slice(0, destination.length - fileName.length - 1);
  pushHistory({
    id: `op-${Date.now()}`,
    kind: "zip",
    outcome: "success",
    title: "ZIP created",
    summary: `${strings} strings packaged into ${entries} translation files (preview, nothing written).`,
    itemCount: strings,
    path: destination,
    fileName,
    warnings: [],
    details: [
      {
        label: "Preview",
        value: "No archive was written in the browser preview.",
      },
    ],
    canUndo: false,
    completedAtEpochMs: Date.now(),
  });
  const outcome: ZipBuildOutcome = {
    path: destination,
    folder,
    fileName,
    entries,
    strings,
  };
  return outcome;
}

function emit(event: string, payload: unknown): void {
  for (const [id, listener] of listeners) {
    // Same envelope the native bridge delivers to `listen()` handlers.
    if (listener.event === event) listener.handler({ event, id, payload });
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function localAiRun(request: AiTranslationRequest): Promise<AiRunResult> {
  const identities = request.identities.filter((identity) => {
    const row = rows.get(identity.modUniqueId)?.get(identity.key);
    if (!row) return false;
    return (
      (request.includeOpen && row.status === "untranslated") ||
      (request.includeChanged && row.status === "outdated")
    );
  });
  const total = identities.length;
  const suggestions: AiRunResult["suggestions"] = [];
  const progress = (phase: AiRunProgress["phase"], completed: number) =>
    emit("ai-run-progress", {
      runId: request.runId,
      phase,
      completed,
      total,
      retries: 0,
      splits: 0,
      providerStage: phase === "translating" ? "working" : "completed",
    } satisfies AiRunProgress);
  progress("preparing", 0);
  await wait(400);
  for (const [index, identity] of identities.entries()) {
    if (cancelled.has(request.runId)) break;
    progress("translating", index);
    await wait(350);
    const row = rows.get(identity.modUniqueId)?.get(identity.key);
    if (!row) continue;
    const text = `[Preview AI] ${row.source}`;
    saveRow(
      identity.modUniqueId,
      identity.key,
      text,
      "review-needed",
      row.source,
    );
    suggestions.push({
      identity,
      text,
      status: "review-needed",
      tokenDifferences: [],
      glossaryMisses: [],
    });
    progress("saving", index + 1);
  }
  const wasCancelled = cancelled.delete(request.runId);
  pushHistory({
    id: `op-${Date.now()}`,
    kind: "ai",
    outcome: wasCancelled ? "cancelled" : "success",
    title: "Local AI translation run",
    summary: `${suggestions.length} of ${total} suggestions saved in Review (preview, no model involved).`,
    itemCount: suggestions.length,
    warnings: [],
    details: [
      { label: "Engine", value: "Local AI (browser preview)" },
      { label: "Model", value: "preview-local-model" },
    ],
    canUndo: false,
    completedAtEpochMs: Date.now(),
  });
  return {
    runId: request.runId,
    engine: "local",
    model: "preview-local-model",
    reasoning: "none",
    scope: request.scope,
    requested: total,
    completed: suggestions.length,
    outcome: wasCancelled ? "cancelled" : "complete",
    suggestions,
  };
}

function reject(message: string): Promise<never> {
  return Promise.reject(message);
}

async function handle(cmd: string, args: Args): Promise<unknown> {
  switch (cmd) {
    case "plugin:event|listen": {
      const id = nextCallback++;
      const handlerId = Number(args.handler);
      const handler = callbacks.get(handlerId);
      if (handler) listeners.set(id, { event: String(args.event), handler });
      return id;
    }
    case "plugin:event|unlisten":
      listeners.delete(Number(args.eventId));
      return null;
    case "detect_stardew":
      return {
        stardewPath: PREVIEW_GAME_PATH,
        modsPath: PREVIEW_MODS_PATH,
        source: "browser preview fixtures",
      };
    case "validate_stardew_path":
      return true;
    case "default_mods_path":
      return `${String(args.stardewPath)}\\Mods`;
    case "pick_folder":
      return /mod/i.test(String(args.title ?? ""))
        ? PREVIEW_MODS_PATH
        : PREVIEW_GAME_PATH;
    case "load_settings":
      return settings;
    case "save_settings":
      settings = args.settings as AppSettings;
      return null;
    case "scan_mods":
      await wait(300);
      return scan();
    case "load_strings": {
      const map = rows.get(String(args.modUniqueId));
      if (!map)
        return reject(
          `Unknown mod ${String(args.modUniqueId)} in the browser preview.`,
        );
      return [...map.values()].map(({ savedSource: _s, ...row }) => row);
    }
    case "save_string":
      saveRow(
        String(args.modUniqueId),
        String(args.key),
        String(args.target),
        String(args.status),
        String(args.source),
      );
      return null;
    case "save_string_groups_with_undo": {
      const groups = args.groups as SaveStringGroup[];
      const snapshot = new Map<string, RowState>();
      let count = 0;
      for (const group of groups) {
        for (const entry of group.entries) {
          const row = rows.get(group.modUniqueId)?.get(entry.key);
          if (row)
            snapshot.set(`${group.modUniqueId}\u0000${entry.key}`, { ...row });
          saveRow(
            group.modUniqueId,
            entry.key,
            entry.target,
            entry.status,
            entry.source,
          );
          count += 1;
        }
      }
      return pushHistory({
        id: `op-${Date.now()}`,
        kind: "batch-edit",
        outcome: "success",
        title: String(args.title),
        summary: `${count} strings updated.`,
        itemCount: count,
        warnings: [],
        details: [],
        canUndo: true,
        completedAtEpochMs: Date.now(),
        snapshot,
        after: new Map(
          [...snapshot.keys()].map((compound) => {
            const [modId, key] = compound.split("\u0000");
            return [compound, { ...rows.get(modId)!.get(key)! }];
          }),
        ),
      });
    }
    case "list_operation_history":
      return visibleHistory();
    case "undo_batch_edit": {
      const entry = history.find((h) => h.id === args.operationId);
      if (!entry?.canUndo || !entry.snapshot)
        return reject("This batch edit can no longer be undone.");
      // Like the backend, never overwrite a string edited after this batch.
      for (const [compound, saved] of entry.after ?? []) {
        const [modId, key] = compound.split("\u0000");
        const current = rows.get(modId)?.get(key);
        if (
          current?.target !== saved.target ||
          current?.status !== saved.status
        )
          return reject(
            "This batch edit was not undone because one of its strings changed afterwards.",
          );
      }
      for (const [compound, row] of entry.snapshot) {
        const [modId, key] = compound.split("\u0000");
        rows.get(modId)?.set(key, row);
      }
      entry.canUndo = false;
      return pushHistory({
        id: `op-${Date.now()}`,
        kind: "batch-undo",
        outcome: "success",
        title: `Undo: ${entry.title}`,
        summary: `${entry.snapshot.size} strings restored.`,
        itemCount: entry.snapshot.size,
        warnings: [],
        details: [],
        canUndo: false,
        completedAtEpochMs: Date.now(),
      });
    }
    case "preview_export": {
      const mods = args.mods as ExportModInput[];
      const preflight: ExportPreflight = { acceptedMismatches: 0, omitted: [] };
      for (const mod of mods) {
        const map = rows.get(mod.modUniqueId) ?? new Map<string, RowState>();
        for (const row of map.values()) {
          if (row.tokenMismatchAccepted && row.target !== "")
            preflight.acceptedMismatches += 1;
          const bad = blockingIssues(row);
          if (bad.length)
            preflight.omitted.push({
              modUniqueId: mod.modUniqueId,
              modName: mod.modName,
              relativeDir: "i18n",
              key: row.key,
              reason: bad.join(" "),
            });
        }
      }
      return preflight;
    }
    case "export_mod": {
      const result = exportMod(
        String(args.modUniqueId),
        args.files as ExportFileInput[],
      );
      pushHistory({
        id: `op-${Date.now()}`,
        kind: "export",
        outcome: result.skipped.length ? "warning" : "success",
        title: "Export completed",
        summary: `${result.totalWrittenKeys} strings written to ${result.filesWritten} file (preview, nothing written).`,
        itemCount: result.totalWrittenKeys,
        path: paths(modOf(String(args.modUniqueId))).folderPath,
        warnings: result.skipped.map((s) => `${s.key}: ${s.reason}`),
        details: [],
        canUndo: false,
        completedAtEpochMs: Date.now(),
      });
      return result;
    }
    case "export_all_mods": {
      const mods = args.mods as ExportModInput[];
      const all: ExportAllResult = {
        mods: [],
        modsChanged: 0,
        filesWritten: 0,
        filesRemoved: 0,
        totalWrittenKeys: 0,
        totalUntranslated: 0,
        totalOutdated: 0,
        totalReviewNeeded: 0,
        totalOrphanKeys: 0,
      };
      for (const mod of mods) {
        const result = exportMod(mod.modUniqueId, mod.files);
        all.mods.push({
          modUniqueId: mod.modUniqueId,
          modName: mod.modName,
          result,
        });
        if (result.filesWritten) all.modsChanged += 1;
        all.filesWritten += result.filesWritten;
        all.totalWrittenKeys += result.totalWrittenKeys;
        all.totalUntranslated += result.totalUntranslated;
        all.totalOutdated += result.totalOutdated;
        all.totalReviewNeeded += result.totalReviewNeeded;
      }
      pushHistory({
        id: `op-${Date.now()}`,
        kind: "export",
        outcome: "success",
        title: "Export completed",
        summary: `${all.totalWrittenKeys} strings written to ${all.filesWritten} files (preview, nothing written).`,
        itemCount: all.totalWrittenKeys,
        path: PREVIEW_MODS_PATH,
        warnings: [],
        details: [],
        canUndo: false,
        completedAtEpochMs: Date.now(),
      });
      return all;
    }
    case "preview_translation_zip": {
      const components = args.components as Array<{ uniqueId: string }>;
      return zipPreview(
        String(args.packageName),
        components.map((c) => c.uniqueId),
      );
    }
    case "pick_translation_zip_destination":
      return `${DOWNLOADS}\\${String(args.defaultFileName)}`;
    case "build_translation_zip": {
      const request = args.request as {
        packageName: string;
        components: Array<{ uniqueId: string }>;
        destination: string;
      };
      const preview = zipPreview(
        request.packageName,
        request.components.map((c) => c.uniqueId),
      );
      return zipOutcome(
        request.destination,
        preview.entries.length,
        preview.totalStrings,
      );
    }
    case "preview_stardew_translator_output":
      return zipPreview(
        "Stardew Translator Output",
        FIXTURE_MODS.map((m) => m.uniqueId),
      );
    case "build_stardew_translator_output": {
      const preview = zipPreview(
        "Stardew Translator Output",
        FIXTURE_MODS.map((m) => m.uniqueId),
      );
      return zipOutcome(
        String(args.destination),
        preview.entries.length,
        preview.totalStrings,
      );
    }
    case "export_llm_batch":
    case "export_llm_batch_to_path": {
      const items = args.items as unknown[];
      const path =
        typeof args.path === "string"
          ? args.path
          : `${DOWNLOADS}\\${String(args.modUniqueId)}.llm-batch.json`;
      pushHistory({
        id: `op-${Date.now()}`,
        kind: "batch-export",
        outcome: "success",
        title: "LLM batch exported",
        summary: `${items.length} strings exported (preview, nothing written).`,
        itemCount: items.length,
        path,
        fileName: path.split("\\").pop(),
        warnings: [],
        details: [],
        canUndo: false,
        completedAtEpochMs: Date.now(),
      });
      return { path, stringCount: items.length };
    }
    case "pick_llm_batch_destination":
      return `${DOWNLOADS}\\${String(args.suggestedFileName)}`;
    case "pick_llm_batch_file":
      return `${DOWNLOADS}\\Preview.EdgeCases.llm-result.json`;
    case "preflight_llm_batch_path": {
      const modId = String(args.modUniqueId);
      const map = rows.get(modId) ?? new Map<string, RowState>();
      const open = [...map.values()].filter(
        (r) => r.status === "untranslated" && r.source.trim() !== "",
      );
      const preflight: LlmImportPreflight = {
        batchModUniqueId: "Preview.EdgeCases",
        batchTargetLang: targetLang(),
        selectedModUniqueId: modId,
        selectedTargetLang: targetLang(),
        modMatches: modId === "Preview.EdgeCases",
        languageMatches: true,
        snapshotResult:
          modId === "Preview.EdgeCases" ? "matched" : "notChecked",
        suppliedStrings: open.length + 2,
        matchedStrings: open.length,
        preservedLocal: 2,
        skippedEmpty: 0,
        identicalToSource: 0,
        importable: open.length,
        protectedTokenIssues: open.length
          ? [
              {
                relativeDir: "i18n",
                key: open[0].key,
                importedText: `[LLM] ${open[0].source} {{Extra}}`,
                differences: [
                  {
                    token: "{{Extra}}",
                    sourceCount: 0,
                    targetCount: 1,
                    severity: "error",
                  },
                ],
              },
            ]
          : [],
        ready: modId === "Preview.EdgeCases" && open.length > 0,
        blockingReason:
          modId === "Preview.EdgeCases"
            ? open.length
              ? null
              : "This batch contains no strings that are still open."
            : "This batch belongs to Preview Edge Cases, not to the selected mod.",
      };
      return preflight;
    }
    case "import_llm_batch_path": {
      const modId = String(args.modUniqueId);
      const map = rows.get(modId) ?? new Map<string, RowState>();
      let imported = 0;
      for (const row of map.values()) {
        if (row.status !== "untranslated" || row.source.trim() === "") continue;
        const text =
          imported === 0
            ? `[LLM] ${row.source} {{Extra}}`
            : `[LLM] ${row.source}`;
        saveRow(modId, row.key, text, "review-needed", row.source);
        imported += 1;
      }
      const summary: LlmImportSummary = {
        imported,
        skippedTranslated: 2,
        unmatched: 0,
        identicalToSource: 0,
        importedWithTokenErrors: imported ? 1 : 0,
        totalInFile: imported + 2,
      };
      pushHistory({
        id: `op-${Date.now()}`,
        kind: "import",
        outcome: "success",
        title: "LLM batch imported",
        summary: `${imported} of ${summary.totalInFile} texts added to Review.`,
        itemCount: imported,
        path: `${DOWNLOADS}\\Preview.EdgeCases.llm-result.json`,
        fileName: "Preview.EdgeCases.llm-result.json",
        warnings: [],
        details: [],
        canUndo: false,
        completedAtEpochMs: Date.now(),
      });
      return summary;
    }
    case "glossary_status": {
      const status: GlossaryStatus = {
        gameXnbPresent: false,
        unpackedPresent: false,
        sourceAvailable: false,
        cached: {
          targetLang: targetLang(),
          termCount: FIXTURE_GLOSSARY.length,
          source: "official",
        },
        outdatedCache: false,
        packAvailable: false,
        packXnbAvailable: false,
      };
      return status;
    }
    case "load_glossary": {
      const glossary: Glossary = {
        format: 2,
        sourceLang: "default",
        targetLang: targetLang(),
        termCount: FIXTURE_GLOSSARY.length,
        entries: FIXTURE_GLOSSARY,
      };
      return glossary;
    }
    case "build_glossary":
      return reject(
        "The glossary cannot be built in the browser preview; it needs the game files.",
      );
    case "llm_models":
      await wait(200);
      return ["preview-local-model", "preview-second-model"];
    case "translate_with_local_ai":
      return localAiRun(args.request as AiTranslationRequest);
    case "cancel_ai_run":
      cancelled.add(String(args.runId));
      return true;
    case "cloud_ai_status":
      return { authenticated: false };
    case "cloud_ai_models":
      return [];
    case "chatgpt_sign_in":
    case "chatgpt_sign_out":
    case "translate_with_cloud_ai":
      return reject("ChatGPT is not available in the browser preview.");
    case "open_url":
      window.open(String(args.url), "_blank", "noopener");
      return null;
    case "open_logs_dir":
    case "open_mod_folder":
    case "open_folder":
      console.info(`[preview] would open ${String(args.path ?? "data/logs")}`);
      return null;
    case "log_frontend_error":
      console.warn(
        `[preview] ${String(args.context)}: ${String(args.message)}`,
      );
      return null;
    default:
      return reject(
        `The command "${cmd}" is not available in the browser preview.`,
      );
  }
}

export function installPreviewBridge(): void {
  seed();
  const internals = {
    invoke: (cmd: string, args?: Args) => handle(cmd, args ?? {}),
    transformCallback: (callback: Handler, _once?: boolean) => {
      const id = nextCallback++;
      callbacks.set(id, callback);
      return id;
    },
    unregisterCallback: (id: number) => {
      callbacks.delete(id);
    },
    convertFileSrc: (path: string) => path,
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main" },
    },
  };
  const eventInternals = {
    unregisterListener: (_event: string, eventId: number) => {
      listeners.delete(eventId);
    },
  };
  Object.assign(window, {
    __TAURI_INTERNALS__: internals,
    __TAURI_EVENT_PLUGIN_INTERNALS__: eventInternals,
  });
  document.title = `${document.title} (browser preview)`;
  console.info(
    "[preview] Stardew i18n Translator runs on synthetic fixtures. Add ?setup to the URL to start with the setup wizard.",
  );
}
