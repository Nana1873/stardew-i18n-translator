import { useState } from "react";
import type {
  ExportResult,
  LlmExportOutcome,
  LlmImportSummary,
  ZipBuildOutcome,
} from "../tauri/commands";

export const LLM_BATCH_HANDOFF_PROMPT =
  'Follow the "instructions" in the attached batch JSON and return the completed result as a downloadable JSON file.';

export interface ResultProblem {
  id: string;
  modUniqueId: string;
  modName: string;
  relativeDir: string;
  key: string;
  reason: string;
  resolved: boolean;
}

export type ResultTrayData =
  | {
      kind: "export";
      title: string;
      collapsed: boolean;
      pending: boolean;
      error: string | null;
      result: ExportResult | null;
      modsWritten: number | null;
      problems: ResultProblem[];
      retry: { kind: "selected"; modUniqueId: string } | { kind: "all" };
    }
  | {
      kind: "import";
      title: string;
      collapsed: boolean;
      pending: boolean;
      error: string | null;
      summary: LlmImportSummary | null;
      problems: ResultProblem[];
    }
  | {
      kind: "batch-export";
      title: string;
      collapsed: boolean;
      pending: false;
      error: string | null;
      outcome: LlmExportOutcome | null;
      problems: ResultProblem[];
    }
  | {
      kind: "zip";
      title: string;
      collapsed: boolean;
      pending: false;
      error: string | null;
      outcome: ZipBuildOutcome | null;
      problems: ResultProblem[];
    };

export function ResultTray({
  data,
  onToggle,
  onClose,
  onInspect,
  onRetry,
  onOpenFolder,
  onReleaseNotes,
}: {
  data: ResultTrayData;
  onToggle: () => void;
  onClose: () => void;
  onInspect: (problem: ResultProblem) => void;
  onRetry: () => void;
  onOpenFolder?: (path: string) => void;
  onReleaseNotes?: () => void;
}) {
  const unresolved = data.problems.filter((problem) => !problem.resolved);
  const failed = Boolean(data.error);
  const blocked = data.kind === "export" && unresolved.length > 0;
  const readyToRetry =
    data.kind === "export" &&
    Boolean(data.result?.blocked) &&
    data.problems.length > 0 &&
    unresolved.length === 0;
  const label = data.pending
    ? data.kind === "export"
      ? "Exporting"
      : "Importing"
    : failed
      ? data.kind === "export"
        ? "Export failed"
        : data.kind === "import"
          ? "Import failed"
          : data.kind === "batch-export"
            ? "Batch export failed"
            : "ZIP build failed"
      : blocked
        ? "Export blocked"
        : readyToRetry
          ? "Ready to export again"
          : data.kind === "export"
            ? "Export complete"
            : data.kind === "import"
              ? "Batch imported"
              : data.kind === "batch-export"
                ? "Batch exported"
                : "Translation ZIP created";

  return (
    <aside
      className={`resulttray${data.collapsed ? " resulttray--collapsed" : ""}`}
      aria-label="Operation result"
      aria-live="polite"
    >
      <div className="resulttray__head">
        <button
          type="button"
          className="resulttray__toggle"
          onClick={onToggle}
          aria-expanded={!data.collapsed}
        >
          <span
            className={`resulttray__status${failed || blocked ? " resulttray__status--error" : ""}`}
            aria-hidden
          />
          <strong>{label}</strong>
          <span className="resulttray__title">{data.title}</span>
          {unresolved.length > 0 && (
            <span className="resulttray__count">{unresolved.length} open</span>
          )}
        </button>
        <button
          type="button"
          className="resulttray__icon"
          onClick={onToggle}
          aria-label={data.collapsed ? "Expand result" : "Collapse result"}
        >
          {data.collapsed ? "+" : "-"}
        </button>
        <button
          type="button"
          className="resulttray__icon"
          onClick={onClose}
          aria-label="Dismiss result"
        >
          x
        </button>
      </div>

      {!data.collapsed && (
        <div className="resulttray__body">
          {data.error ? (
            <p className="resulttray__error">{data.error}</p>
          ) : data.kind === "export" && data.result ? (
            <ExportSnapshot
              result={data.result}
              modsWritten={data.modsWritten}
            />
          ) : data.kind === "import" && data.summary ? (
            <ImportSnapshot summary={data.summary} />
          ) : data.kind === "batch-export" && data.outcome ? (
            <BatchExportSnapshot outcome={data.outcome} />
          ) : data.kind === "zip" && data.outcome ? (
            <div className="resulttray__snapshot">
              <span className="resulttray__eyebrow">Release archive</span>
              <p>
                Wrote <strong>{data.outcome.strings}</strong> strings in{" "}
                <strong>{data.outcome.entries}</strong> files.
              </p>
              <code>{data.outcome.path}</code>
              {onOpenFolder && (
                <div className="resulttray__actions">
                  <button
                    type="button"
                    className="resulttray__action"
                    onClick={() => onOpenFolder(data.outcome!.folder)}
                  >
                    Open folder
                  </button>
                  {onReleaseNotes && (
                    <button
                      type="button"
                      className="resulttray__action"
                      onClick={onReleaseNotes}
                    >
                      Translation Notes
                    </button>
                  )}
                </div>
              )}
            </div>
          ) : (
            <p className="resulttray__muted">Working...</p>
          )}

          {data.problems.length > 0 && (
            <section className="resulttray__problems">
              <div className="resulttray__section-title">
                <strong>Current validation</strong>
                <span>
                  {unresolved.length} open,{" "}
                  {data.problems.length - unresolved.length} resolved
                </span>
              </div>
              <ul>
                {data.problems.map((problem) => (
                  <li
                    key={problem.id}
                    className={
                      problem.resolved ? "resulttray__problem--resolved" : ""
                    }
                  >
                    <button type="button" onClick={() => onInspect(problem)}>
                      <span>
                        <strong>{problem.modName}</strong>
                        <code>
                          {problem.relativeDir} / {problem.key}
                        </code>
                      </span>
                      <small>
                        {problem.resolved ? "Resolved" : problem.reason}
                      </small>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {data.kind === "export" &&
            data.problems.length > 0 &&
            unresolved.length === 0 &&
            !data.pending && (
              <button
                type="button"
                className="resulttray__retry"
                onClick={onRetry}
              >
                Export again
              </button>
            )}
        </div>
      )}
    </aside>
  );
}

function BatchExportSnapshot({ outcome }: { outcome: LlmExportOutcome }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle",
  );

  async function copyPrompt() {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard access is unavailable.");
      }
      await navigator.clipboard.writeText(LLM_BATCH_HANDOFF_PROMPT);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  }

  return (
    <div className="resulttray__snapshot">
      <span className="resulttray__eyebrow">External LLM batch</span>
      <p>
        Wrote <strong>{outcome.stringCount}</strong>{" "}
        {outcome.stringCount === 1 ? "string" : "strings"}
        {outcome.glossaryTerms > 0
          ? ` with ${outcome.glossaryTerms} glossary terms`
          : ""}
        .
      </p>
      <code>{outcome.path}</code>
      <div className="resulttray__prompt">
        <code>{LLM_BATCH_HANDOFF_PROMPT}</code>
        <button
          type="button"
          className="resulttray__action"
          onClick={() => void copyPrompt()}
        >
          {copyState === "copied" ? "Copied" : "Copy prompt"}
        </button>
      </div>
      {copyState === "error" && (
        <p className="resulttray__error" role="alert">
          Could not access the clipboard.
        </p>
      )}
      <p className="resulttray__muted">
        Attach the batch JSON, send the prompt, then drop the returned JSON here
        or choose Import...
      </p>
    </div>
  );
}

function ExportSnapshot({
  result,
  modsWritten,
}: {
  result: ExportResult;
  modsWritten: number | null;
}) {
  return (
    <div className="resulttray__snapshot">
      <span className="resulttray__eyebrow">Operation summary</span>
      <p>
        Wrote <strong>{result.totalWrittenKeys}</strong> strings across{" "}
        <strong>{result.filesWritten}</strong> files
        {modsWritten !== null ? ` in ${modsWritten} mods` : ""}.
      </p>
      <ul>
        <li>{result.totalUntranslated} untranslated omitted</li>
        <li>{result.totalOutdated} outdated exported</li>
        <li>{result.totalReviewNeeded} review-needed exported</li>
        <li>{result.skipped.length} blocking errors reported</li>
      </ul>
    </div>
  );
}

function ImportSnapshot({ summary }: { summary: LlmImportSummary }) {
  return (
    <div className="resulttray__snapshot">
      <span className="resulttray__eyebrow">Operation summary</span>
      <p>
        Imported <strong>{summary.imported}</strong> of{" "}
        <strong>{summary.totalInFile}</strong> strings as Needs review.
      </p>
      <ul>
        <li>{summary.skippedTranslated} translated strings left untouched</li>
        <li>{summary.unmatched} unmatched or empty values</li>
        <li>{summary.tokenIssues} protected-token problems reported</li>
        <li>{summary.identicalToSource} identical to source</li>
      </ul>
    </div>
  );
}
