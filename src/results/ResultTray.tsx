import { type RefObject, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Copy, X } from "lucide-react";
import type {
  ExportResult,
  LlmExportOutcome,
  LlmImportSummary,
  OperationHistoryEntry,
  ZipBuildOutcome,
} from "../tauri/commands";

export const LLM_BATCH_HANDOFF_PROMPT =
  'Translate only the string values inside "files" in the attached JSON. Preserve every file path, key, placeholder, token, and the complete metadata object exactly. Return the completed JSON as a downloadable file without adding or removing anything.';

export interface ResultProblem {
  id: string;
  modUniqueId: string;
  modName: string;
  relativeDir: string;
  key: string;
  reason: string;
  resolved: boolean;
}

interface ResultTrayBase {
  /** Canonical backend history identity once the operation completed. */
  operationId?: string | null;
  title: string;
  collapsed: boolean;
  pending: boolean;
  error: string | null;
  problems: ResultProblem[];
  /** Components associated with the Review result, when known. */
  reviewModUniqueIds?: string[];
}

export type ResultTrayData =
  | (ResultTrayBase & {
      kind: "export";
      result: ExportResult | null;
      modsChanged: number | null;
      failedMod?: string | null;
      remainingMods?: string[];
      retry: { kind: "selected"; modUniqueId: string } | { kind: "all" };
    })
  | (ResultTrayBase & {
      kind: "import";
      summary: LlmImportSummary | null;
      /** Real native-picker/drop path retained by the caller for result details. */
      sourcePath?: string | null;
      sourceFileName?: string | null;
      sourceFolder?: string | null;
    })
  | (ResultTrayBase & {
      kind: "batch-export";
      outcome: LlmExportOutcome | null;
    })
  | (ResultTrayBase & {
      kind: "zip";
      outcome: ZipBuildOutcome | null;
    })
  | (ResultTrayBase & {
      kind: "ai-batch";
      outcome: "complete" | "cancelled" | "error";
      done: number;
      total: number;
      engine: string;
      undoAvailable: boolean;
    })
  | (ResultTrayBase & {
      kind: "bulk";
      count: number;
      undone?: boolean;
      undoAvailable: boolean;
    })
  | (ResultTrayBase & {
      kind: "history";
      entry: OperationHistoryEntry;
    });

interface ResultNotice {
  text: string;
  tone?: "warning" | "error";
}

interface ResultPath {
  label: string;
  path: string;
}

interface ResultPresentation {
  label: string;
  kicker: string;
  copy: string;
  tone: "success" | "warning" | "error" | "pending";
  notices: ResultNotice[];
  paths: ResultPath[];
  workflow: string[];
  openFolderPath: string | null;
  canOpenReview: boolean;
}

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) || path;
}

function folderOf(path: string): string | null {
  const index = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  if (index < 0) return null;
  if (index === 0) return path.slice(0, 1);
  if (index === 2 && path[1] === ":") return path.slice(0, 3);
  return path.slice(0, index);
}

function plural(value: number, singular: string, pluralForm = singular + "s") {
  return value === 1 ? singular : pluralForm;
}

function presentationFor(
  data: ResultTrayData,
  unresolved: ResultProblem[],
): ResultPresentation {
  if (data.pending) {
    return {
      label: data.kind === "import" ? "Importing" : "Exporting",
      kicker: "Operation in progress",
      copy:
        data.kind === "import"
          ? "The selected JSON file is being validated and imported."
          : "Translation files are being prepared and written safely.",
      tone: "pending",
      notices: [],
      paths: [],
      workflow: [],
      openFolderPath: null,
      canOpenReview: false,
    };
  }

  let result: ResultPresentation;

  if (data.kind === "history") {
    const entry = data.entry;
    const label =
      entry.outcome === "success"
        ? entry.title
        : entry.outcome === "warning"
          ? `${entry.title} · warnings`
          : entry.outcome === "cancelled"
            ? `${entry.title} · cancelled`
            : entry.outcome === "blocked"
              ? `${entry.title} · blocked`
              : `${entry.title} · failed`;
    const pathDetails: ResultPath[] = [
      ...(entry.fileName ? [{ label: "File name", path: entry.fileName }] : []),
      ...(entry.path ? [{ label: "Path", path: entry.path }] : []),
      ...entry.details.map((detail) => ({
        label: detail.label,
        path: detail.value,
      })),
    ];
    result = {
      label,
      kicker: "Backend operation history",
      copy: entry.summary,
      tone:
        entry.outcome === "success"
          ? "success"
          : entry.outcome === "warning" || entry.outcome === "cancelled"
            ? "warning"
            : "error",
      notices: entry.warnings.map((warning) => ({
        text: warning,
        tone: entry.outcome === "failed" ? "error" : "warning",
      })),
      paths: pathDetails,
      workflow: [],
      openFolderPath: entry.path
        ? entry.fileName
          ? folderOf(entry.path)
          : entry.path
        : null,
      canOpenReview:
        (entry.kind === "import" || entry.kind === "ai") && entry.itemCount > 0,
    };
  } else if (data.kind === "export") {
    const exportResult = data.result;
    const changedFiles = exportResult
      ? exportResult.filesWritten + exportResult.filesRemoved
      : 0;
    const blocked = Boolean(exportResult?.blocked || unresolved.length > 0);
    const ready =
      Boolean(exportResult?.blocked) &&
      data.problems.length > 0 &&
      unresolved.length === 0;
    const notices: ResultNotice[] = [];
    if (exportResult) {
      if (exportResult.totalUntranslated > 0)
        notices.push({
          text:
            exportResult.totalUntranslated +
            " untranslated " +
            plural(exportResult.totalUntranslated, "value") +
            " omitted; SMAPI will use default.json.",
        });
      if (exportResult.totalOutdated > 0 || exportResult.totalReviewNeeded > 0)
        notices.push({
          text:
            exportResult.totalOutdated +
            " changed and " +
            exportResult.totalReviewNeeded +
            " review-needed " +
            plural(
              exportResult.totalOutdated + exportResult.totalReviewNeeded,
              "value",
            ) +
            " included.",
          tone: "warning",
        });
      if (exportResult.totalOrphanKeys > 0)
        notices.push({
          text:
            exportResult.totalOrphanKeys +
            " orphan " +
            plural(exportResult.totalOrphanKeys, "key") +
            " removed from output and retained in backups.",
          tone: "warning",
        });
      for (const skipped of exportResult.skipped)
        notices.push({
          text:
            skipped.relativeDir + " / " + skipped.key + ": " + skipped.reason,
          tone: "error",
        });
    }
    const paths =
      exportResult?.files
        .filter((file) => file.written || file.removed)
        .map((file) => ({
          label:
            fileNameOf(file.targetPath) +
            (file.removed
              ? file.backedUp
                ? " · Removed · backup created"
                : " · Removed"
              : file.backedUp
                ? " · Written · backup created"
                : " · Written"),
          path: file.targetPath,
        })) ?? [];
    const copy = exportResult
      ? blocked && changedFiles === 0
        ? "No translation file was changed."
        : changedFiles +
          " target " +
          plural(changedFiles, "file") +
          " written or removed. " +
          exportResult.totalWrittenKeys +
          " " +
          plural(exportResult.totalWrittenKeys, "string") +
          " written."
      : "Result data is unavailable.";
    result = {
      label: ready
        ? "Ready to export again"
        : blocked
          ? "Export blocked"
          : data.modsChanged !== null
            ? "All mods exported"
            : "Export completed",
      kicker: "Operation result",
      copy,
      tone: blocked
        ? "error"
        : notices.some((item) => item.tone === "warning")
          ? "warning"
          : "success",
      notices,
      paths,
      workflow: [],
      openFolderPath: paths[0] ? folderOf(paths[0].path) : null,
      canOpenReview: false,
    };
    if (data.failedMod) {
      result.notices.push({
        text:
          "Failed at " +
          data.failedMod +
          ". Not started: " +
          ((data.remainingMods?.length ?? 0) > 0
            ? data.remainingMods?.join(", ")
            : "none") +
          ".",
        tone: "error",
      });
    }
  } else if (data.kind === "import") {
    const summary = data.summary;
    const sourceName =
      data.sourceFileName ||
      (data.sourcePath ? fileNameOf(data.sourcePath) : null);
    const paths: ResultPath[] = [];
    if (sourceName) paths.push({ label: "Source file", path: sourceName });
    if (data.sourcePath)
      paths.push({ label: "Imported from", path: data.sourcePath });
    const notices: ResultNotice[] = [];
    if (summary?.skippedTranslated)
      notices.push({
        text:
          summary.skippedTranslated +
          " existing local " +
          plural(summary.skippedTranslated, "translation") +
          " preserved.",
      });
    if (summary?.unmatched)
      notices.push({
        text:
          summary.unmatched +
          " unmatched, empty, or non-string " +
          plural(summary.unmatched, "value") +
          " skipped.",
        tone: "warning",
      });
    if (summary?.identicalToSource)
      notices.push({
        text:
          summary.identicalToSource +
          " imported " +
          plural(summary.identicalToSource, "value") +
          " identical to the English source.",
        tone: "warning",
      });
    if (!data.sourcePath)
      notices.push({
        text: "The imported source path and file name are unavailable.",
        tone: "warning",
      });
    result = {
      label: "LLM batch imported",
      kicker: "Operation result",
      copy: summary
        ? summary.imported +
          " of " +
          summary.totalInFile +
          " " +
          plural(summary.totalInFile, "value") +
          " saved to the review queue."
        : "Import result data is unavailable.",
      tone: notices.some((item) => item.tone === "warning")
        ? "warning"
        : "success",
      notices,
      paths,
      workflow: [],
      openFolderPath:
        data.sourceFolder ||
        (data.sourcePath ? folderOf(data.sourcePath) : null),
      canOpenReview: Boolean(summary && summary.imported > 0),
    };
  } else if (data.kind === "batch-export") {
    const outcome = data.outcome;
    const paths: ResultPath[] = outcome
      ? [
          { label: "File name", path: fileNameOf(outcome.path) },
          { label: "Saved to", path: outcome.path },
        ]
      : [];
    result = {
      label: "LLM batch exported",
      kicker: "Operation result",
      copy: outcome
        ? outcome.stringCount +
          " selected open or changed " +
          plural(outcome.stringCount, "string") +
          " written."
        : "Batch export result data is unavailable.",
      tone: "success",
      notices: [],
      paths,
      workflow: [
        "Upload the JSON file to an LLM that supports file uploads.",
        "Send the handoff prompt and download the returned JSON file.",
        "Import it through Import … or drag and drop.",
        "Review the results in the review queue.",
      ],
      openFolderPath: outcome ? folderOf(outcome.path) : null,
      canOpenReview: false,
    };
  } else if (data.kind === "zip") {
    const outcome = data.outcome;
    result = {
      label: "ZIP created",
      kicker: "Operation result",
      copy: outcome
        ? outcome.strings +
          " " +
          plural(outcome.strings, "string") +
          " packaged into " +
          outcome.entries +
          " translation " +
          plural(outcome.entries, "file") +
          "."
        : "ZIP result data is unavailable.",
      tone: "success",
      notices: outcome
        ? [
            {
              text:
                outcome.entries +
                " translation " +
                plural(outcome.entries, "file") +
                " · " +
                outcome.strings +
                " " +
                plural(outcome.strings, "string"),
            },
          ]
        : [],
      paths: outcome
        ? [
            { label: "Archive name", path: outcome.fileName },
            { label: "Saved to", path: outcome.path },
          ]
        : [],
      workflow: [],
      openFolderPath: outcome?.folder ?? null,
      canOpenReview: false,
    };
  } else if (data.kind === "ai-batch") {
    const notStarted = Math.max(0, data.total - data.done);
    result = {
      label:
        data.outcome === "complete"
          ? "AI translation complete"
          : data.outcome === "cancelled"
            ? "AI translation cancelled"
            : "AI translation failed",
      kicker: "Operation result",
      copy:
        data.done +
        " " +
        data.engine +
        " " +
        plural(data.done, "suggestion") +
        " completed and saved in Review.",
      tone:
        data.outcome === "complete"
          ? "success"
          : data.outcome === "cancelled"
            ? "warning"
            : "error",
      notices: [
        {
          text: data.done + " saved · " + notStarted + " remaining.",
          ...(data.outcome === "complete"
            ? {}
            : {
                tone:
                  data.outcome === "cancelled"
                    ? ("warning" as const)
                    : ("error" as const),
              }),
        },
      ],
      paths: [],
      workflow: [],
      openFolderPath: null,
      canOpenReview: data.done > 0,
    };
  } else {
    result = {
      label: data.undone ? "Batch edit undone" : "Batch edit saved",
      kicker: "Operation result",
      copy: data.undone
        ? data.count +
          " " +
          plural(data.count, "string") +
          " restored to the previous values."
        : data.count +
          " selected " +
          plural(data.count, "string") +
          " saved. Undo remains available until another result replaces this one.",
      tone: "success",
      notices: [],
      paths: [],
      workflow: [],
      openFolderPath: null,
      canOpenReview: false,
    };
  }

  if (data.error) {
    result.label =
      data.kind === "import"
        ? "LLM import rejected"
        : data.kind === "batch-export"
          ? "Batch export failed"
          : data.kind === "zip"
            ? "ZIP build failed"
            : data.kind === "ai-batch"
              ? data.outcome === "cancelled"
                ? "AI translation cancelled"
                : "AI translation failed"
              : data.kind === "history"
                ? "Operation failed"
                : data.kind === "bulk"
                  ? "Batch edit failed"
                  : "Export failed";
    result.tone = "error";
    result.notices.unshift({ text: data.error, tone: "error" });
    if (data.kind === "import") result.copy = "No changes were made.";
  }

  return result;
}

function resultKey(data: ResultTrayData): string {
  if (data.operationId) return `${data.kind}|${data.operationId}`;
  if (data.kind === "history") return `${data.kind}|${data.entry.id}`;
  if (data.kind === "batch-export")
    return data.kind + "|" + (data.outcome?.path ?? data.title);
  if (data.kind === "zip")
    return data.kind + "|" + (data.outcome?.path ?? data.title);
  if (data.kind === "bulk")
    return (
      data.kind +
      "|" +
      data.title +
      "|" +
      data.count +
      "|" +
      Boolean(data.undone)
    );
  if (data.kind === "ai-batch")
    return data.kind + "|" + data.outcome + "|" + data.done + "|" + data.total;
  if (data.kind === "import")
    return (
      data.kind +
      "|" +
      data.title +
      "|" +
      (data.sourcePath ?? "") +
      "|" +
      (data.summary?.imported ?? "")
    );
  return (
    data.kind +
    "|" +
    data.title +
    "|" +
    (data.result?.totalWrittenKeys ?? "") +
    "|" +
    Boolean(data.result?.blocked)
  );
}

function copyTextFor(
  data: ResultTrayData,
  presentation: ResultPresentation,
): string {
  const lines = [
    presentation.label,
    data.title,
    presentation.copy,
    ...presentation.notices.map((notice) => notice.text),
    ...presentation.paths.flatMap((item) => [item.label, item.path]),
    ...presentation.workflow,
    ...(data.kind === "batch-export" && data.outcome
      ? [LLM_BATCH_HANDOFF_PROMPT]
      : []),
    ...data.problems.map(
      (problem) =>
        problem.modName +
        " · " +
        problem.relativeDir +
        " / " +
        problem.key +
        " · " +
        (problem.resolved ? "Resolved" : problem.reason),
    ),
  ];
  return lines.filter((line) => line.trim().length > 0).join("\n");
}

export function ResultTray({
  data,
  onToggle,
  onClose,
  onInspect,
  onRetry,
  onOpenFolder,
  onOpenReview,
  onReleaseNotes,
  onUndoBulk,
  onNotify,
  toggleButtonRef,
  history = [],
  selectedHistoryId = null,
  onSelectHistory,
}: {
  data: ResultTrayData;
  onToggle: () => void;
  onClose: () => void;
  onInspect: (problem: ResultProblem) => void;
  onRetry?: () => void;
  onOpenFolder?: (path: string) => void;
  onOpenReview?: () => void;
  onReleaseNotes?: () => void;
  onUndoBulk?: () => Promise<void> | void;
  onNotify?: (message: string) => void;
  /** Lets the shell restore focus after Latest result is reopened. */
  toggleButtonRef?: RefObject<HTMLButtonElement | null>;
  /** Canonical, newest-first backend operation history (bounded to five). */
  history?: OperationHistoryEntry[];
  selectedHistoryId?: string | null;
  onSelectHistory?: (entry: OperationHistoryEntry) => void;
}) {
  const unresolved = data.problems.filter((problem) => !problem.resolved);
  const presentation = useMemo(
    () => presentationFor(data, unresolved),
    [data, unresolved],
  );
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle",
  );
  const [promptCopyState, setPromptCopyState] = useState<
    "idle" | "copied" | "error"
  >("idle");
  const [undoUsed, setUndoUsed] = useState(false);
  const [undoRunning, setUndoRunning] = useState(false);
  const key = resultKey(data);

  useEffect(() => {
    setCopyState("idle");
    setPromptCopyState("idle");
    setUndoUsed(false);
    setUndoRunning(false);
  }, [key]);

  async function copyDetails() {
    try {
      if (!navigator.clipboard?.writeText)
        throw new Error("Clipboard access is unavailable.");
      await navigator.clipboard.writeText(copyTextFor(data, presentation));
      setCopyState("copied");
      onNotify?.("Result details copied.");
    } catch {
      setCopyState("error");
    }
  }

  async function copyHandoffPrompt() {
    try {
      if (!navigator.clipboard?.writeText)
        throw new Error("Clipboard access is unavailable.");
      await navigator.clipboard.writeText(LLM_BATCH_HANDOFF_PROMPT);
      setPromptCopyState("copied");
      onNotify?.("Handoff prompt copied.");
    } catch {
      setPromptCopyState("error");
      setCopyState("error");
    }
  }

  async function undoBulk() {
    if (!onUndoBulk || undoUsed || undoRunning) return;
    setUndoRunning(true);
    try {
      await onUndoBulk();
      setUndoUsed(true);
    } catch {
      setUndoUsed(false);
    } finally {
      setUndoRunning(false);
    }
  }

  const showRetry = Boolean(
    onRetry &&
    !data.pending &&
    (data.error || (data.kind === "export" && data.result?.blocked)),
  );
  const retryLabel =
    data.kind === "import" && data.error
      ? "Choose another file"
      : "Export again";
  const issue = unresolved[0] ?? data.problems[0];
  const showUndo = Boolean(
    (data.kind === "bulk" || data.kind === "ai-batch"
      ? data.undoAvailable && !(data.kind === "bulk" && data.undone)
      : data.kind === "history"
        ? data.entry.canUndo
        : false) &&
    !undoUsed &&
    onUndoBulk,
  );

  return (
    <aside
      className="stv3-result"
      aria-live="polite"
      aria-label="Latest operation result"
    >
      <div className="stv3-result-head">
        <span
          className={
            "stv3-result-status" +
            (presentation.tone === "pending"
              ? " is-pending"
              : presentation.tone === "warning"
                ? " is-warning"
                : presentation.tone === "error"
                  ? " is-error"
                  : "")
          }
          aria-hidden="true"
        />
        <div className="stv3-result-title">
          <strong>{presentation.label}</strong>
          <span>{data.title}</span>
        </div>
        <button
          ref={toggleButtonRef}
          className="stv3-icon-button"
          type="button"
          aria-label={data.collapsed ? "Expand result" : "Collapse result"}
          aria-expanded={!data.collapsed}
          onClick={onToggle}
        >
          {data.collapsed ? (
            <ChevronUp aria-hidden="true" />
          ) : (
            <ChevronDown aria-hidden="true" />
          )}
        </button>
        <button
          className="stv3-icon-button"
          type="button"
          aria-label="Hide result"
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </button>
      </div>

      {!data.collapsed && (
        <div className="stv3-result-body">
          <div className="stv3-kicker">{presentation.kicker}</div>
          {history.length > 0 && onSelectHistory && (
            <label className="stv3-result-history">
              <span>Result</span>
              <select
                className="stv3-select"
                aria-label="Recent operation results"
                value={
                  selectedHistoryId &&
                  history.some((entry) => entry.id === selectedHistoryId)
                    ? selectedHistoryId
                    : ""
                }
                onChange={(event) => {
                  const entry = history.find(
                    (candidate) => candidate.id === event.currentTarget.value,
                  );
                  if (entry) onSelectHistory(entry);
                }}
              >
                {!history.some((entry) => entry.id === selectedHistoryId) && (
                  <option value="" disabled>
                    Current result
                  </option>
                )}
                {history.map((entry, index) => (
                  <option key={entry.id} value={entry.id}>
                    {index === 0 ? "Latest" : entry.kind} · {entry.title} ·{" "}
                    {new Date(entry.completedAtEpochMs).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="stv3-result-copy">{presentation.copy}</p>

          {(presentation.notices.length > 0 || copyState === "error") && (
            <div className="stv3-result-notices">
              {presentation.notices.map((notice, index) => (
                <div
                  className={
                    "stv3-result-notice" +
                    (notice.tone ? " is-" + notice.tone : "")
                  }
                  key={notice.text + index}
                >
                  {notice.text}
                </div>
              ))}
              {copyState === "error" && (
                <div className="stv3-result-notice is-error" role="alert">
                  Could not access the clipboard.
                </div>
              )}
            </div>
          )}

          {(presentation.paths.length > 0 || data.problems.length > 0) && (
            <div className="stv3-result-details">
              {presentation.paths.map((item, index) => (
                <div className="stv3-result-path" key={item.label + index}>
                  <span>{item.label}</span>
                  <code>{item.path}</code>
                </div>
              ))}
              {data.problems.map((problem) => (
                <button
                  className="stv3-result-path"
                  type="button"
                  key={problem.id}
                  aria-label={
                    problem.modName +
                    " · " +
                    problem.relativeDir +
                    " / " +
                    problem.key +
                    ": " +
                    (problem.resolved ? "Resolved" : problem.reason)
                  }
                  onClick={() => onInspect(problem)}
                >
                  <span>
                    {problem.modName} · {problem.relativeDir}
                  </span>
                  <code>
                    {problem.key} ·{" "}
                    {problem.resolved ? "Resolved" : problem.reason}
                  </code>
                </button>
              ))}
            </div>
          )}

          {data.kind === "batch-export" && data.outcome && (
            <div className="stv3-result-prompt">
              <span>Handoff prompt</span>
              <code>{LLM_BATCH_HANDOFF_PROMPT}</code>
              <button
                className="stv3-button stv3-button-quiet"
                type="button"
                onClick={() => void copyHandoffPrompt()}
              >
                {promptCopyState === "copied" ? "Copied" : "Copy prompt"}
              </button>
              {promptCopyState === "copied" && (
                <span className="stv3-sr-only" role="status">
                  Handoff prompt copied.
                </span>
              )}
            </div>
          )}

          {presentation.workflow.length > 0 && (
            <details className="stv3-result-help">
              <summary>Show workflow</summary>
              <ol className="stv3-result-workflow">
                {presentation.workflow.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </details>
          )}

          <div className="stv3-result-actions">
            <button
              className="stv3-button stv3-button-quiet"
              type="button"
              onClick={() => void copyDetails()}
            >
              <Copy aria-hidden="true" />{" "}
              {copyState === "copied" ? "Copied" : "Copy details"}
            </button>
            {showUndo && (
              <button
                className="stv3-button stv3-button-quiet"
                type="button"
                aria-label="Undo the latest batch edit"
                onClick={() => void undoBulk()}
                disabled={undoRunning}
              >
                {undoRunning ? "Undoing…" : "Undo batch edit"}
              </button>
            )}
            {presentation.openFolderPath && onOpenFolder && (
              <button
                className="stv3-button stv3-button-quiet"
                type="button"
                onClick={() => onOpenFolder(presentation.openFolderPath!)}
              >
                {data.kind === "batch-export"
                  ? "Show file"
                  : data.kind === "import"
                    ? "Show source file"
                    : data.kind === "history" && data.entry.fileName
                      ? "Show file"
                      : "Show in folder"}
              </button>
            )}
            {presentation.canOpenReview && onOpenReview && (
              <button
                className="stv3-button stv3-button-quiet"
                type="button"
                onClick={onOpenReview}
              >
                Open review queue
              </button>
            )}
            {issue && (
              <button
                className="stv3-button stv3-button-quiet"
                type="button"
                onClick={() => onInspect(issue)}
              >
                {unresolved.length === 1 ? "Open issue" : "Open issues"}
              </button>
            )}
            {data.kind === "zip" && data.outcome && onReleaseNotes && (
              <button
                className="stv3-button stv3-button-quiet"
                type="button"
                onClick={onReleaseNotes}
              >
                Translation notes
              </button>
            )}
            {showRetry && (
              <button
                className="stv3-button stv3-button-primary"
                type="button"
                onClick={onRetry}
              >
                {retryLabel}
              </button>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
