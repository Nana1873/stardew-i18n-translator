import { type RefObject } from "react";
import { AlertTriangle, CheckCircle2, CircleX, Loader2, X } from "lucide-react";
import type { ResultProblem, ResultTrayData } from "../results/ResultTray";

export function ResultNotice({
  data,
  presentation,
  issue,
  onInspect,
  onOpenFolder,
  onOpenReview,
  onRetry,
  retryLabel,
  onUndo,
  undoRunning,
  onDetails,
  onClose,
  toggleButtonRef,
}: {
  data: ResultTrayData;
  presentation: {
    label: string;
    copy: string;
    tone: "success" | "warning" | "error" | "pending";
    notices: { text: string; tone?: "warning" | "error" }[];
    paths: { label: string; path: string }[];
    workflow: string[];
    openFolderPath: string | null;
    canOpenReview: boolean;
  };
  issue?: ResultProblem;
  onInspect: (problem: ResultProblem) => void;
  onOpenFolder?: (path: string) => void;
  onOpenReview?: () => void;
  onRetry?: () => void;
  retryLabel: string;
  onUndo?: () => void;
  undoRunning: boolean;
  onDetails: () => void;
  onClose: () => void;
  toggleButtonRef?: RefObject<HTMLButtonElement | null>;
}) {
  const { tone } = presentation;
  const unresolved = data.problems.filter((problem) => !problem.resolved);
  const warnings = presentation.notices.filter((notice) => notice.tone);
  const exportResult = data.kind === "export" ? data.result : null;
  let copy = presentation.copy;
  if (data.kind === "ai-batch") {
    copy = `${data.done} of ${data.total} saved to Review${data.targetLanguage ? ` · ${data.targetLanguage}` : "."}`;
  }
  let cause = warnings[0]?.text ?? "";
  if (exportResult) {
    const files = exportResult.filesWritten + exportResult.filesRemoved;
    copy =
      files === 0
        ? "No translation files changed."
        : [
            exportResult.filesWritten > 0
              ? `${exportResult.totalWrittenKeys} ${exportResult.totalWrittenKeys === 1 ? "string" : "strings"} written to ${exportResult.filesWritten} ${exportResult.filesWritten === 1 ? "file" : "files"}.`
              : "",
            exportResult.filesRemoved > 0
              ? `${exportResult.filesRemoved} ${exportResult.filesRemoved === 1 ? "file" : "files"} removed.`
              : "",
          ]
            .filter(Boolean)
            .join(" ");
    const needsReview =
      exportResult.totalReviewNeeded + exportResult.totalOutdated;
    cause =
      needsReview > 0
        ? `${needsReview} ${needsReview === 1 ? "translation was" : "translations were"} included that still ${needsReview === 1 ? "needs" : "need"} review.`
        : exportResult.totalOrphanKeys > 0
          ? `${exportResult.totalOrphanKeys} ${exportResult.totalOrphanKeys === 1 ? "translation entry without a matching source was" : "translation entries without a matching source were"} removed from output.`
          : "";
  }
  if (data.error) {
    cause = data.error;
    if (
      !(
        exportResult &&
        exportResult.filesWritten + exportResult.filesRemoved > 0
      ) &&
      data.kind !== "ai-batch"
    )
      copy = "";
  } else if (issue && !issue.resolved) {
    const mismatch =
      /^Token count mismatch for (.+) \(expected (\d+), found (\d+)\)$/.exec(
        issue.reason,
      );
    cause =
      mismatch && Number(mismatch[3]) < Number(mismatch[2])
        ? `Missing placeholder ${mismatch[1]} in ${issue.key}.`
        : `${issue.key}: ${issue.reason}`;
    if (unresolved.length > 1)
      cause += ` ${unresolved.length - 1} more ${unresolved.length === 2 ? "issue" : "issues"}.`;
  }
  const complex =
    !data.pending &&
    (unresolved.length > 1 ||
      warnings.length > 1 ||
      (data.kind === "export"
        ? (exportResult?.files.length ?? 0) > 1 || Boolean(data.failedMod)
        : false) ||
      presentation.workflow.length > 0 ||
      data.kind === "history" ||
      cause.length > 280);
  const canReview =
    onOpenReview &&
    (presentation.canOpenReview ||
      Boolean(
        exportResult &&
        exportResult.totalReviewNeeded + exportResult.totalOutdated > 0,
      ));
  const primary = data.pending
    ? null
    : issue && !issue.resolved
      ? {
          label: "Open string",
          run: () => onInspect(issue),
        }
      : canReview
        ? {
            label:
              data.kind === "export" ? "Check translations" : "Open Review",
            run: onOpenReview,
          }
        : onRetry
          ? {
              label:
                retryLabel === "Export again" ? "Retry export" : retryLabel,
              run: onRetry,
            }
          : presentation.openFolderPath && onOpenFolder
            ? {
                label: "Open folder",
                run: () => onOpenFolder(presentation.openFolderPath!),
              }
            : null;
  if (data.pending) {
    copy = "";
    cause = "";
  }
  const Icon =
    tone === "pending"
      ? Loader2
      : tone === "warning"
        ? AlertTriangle
        : tone === "error"
          ? CircleX
          : CheckCircle2;
  return (
    <aside
      className={`translator-toast desktop-result-notice is-${tone}`}
      data-visible="true"
      data-operation-tone={tone}
      aria-label="Operation result"
      role={tone === "error" ? "alert" : "status"}
    >
      <Icon aria-hidden />
      <div className="desktop-result-copy">
        <div>
          <strong>
            {tone === "warning" && data.kind === "export"
              ? "Export completed with warnings"
              : presentation.label}
            {data.pending ? "…" : ""}
          </strong>{" "}
          <span>{data.title}</span>
        </div>
        {copy && <p>{copy}</p>}
        {cause && <p className="desktop-result-cause">{cause}</p>}
        {(primary || complex || onUndo) && (
          <div className="desktop-result-notice-actions">
            {complex && (
              <button
                ref={primary ? undefined : toggleButtonRef}
                className="translator-button translator-button-quiet"
                type="button"
                onClick={onDetails}
              >
                Details…
              </button>
            )}
            {onUndo && (
              <button
                className="translator-button translator-button-quiet"
                type="button"
                onClick={onUndo}
                disabled={undoRunning}
              >
                {undoRunning ? "Undoing…" : "Undo"}
              </button>
            )}
            {primary && (
              <button
                ref={toggleButtonRef}
                className="translator-button translator-button-quiet"
                type="button"
                onClick={primary.run}
              >
                {primary.label}
              </button>
            )}
          </div>
        )}
      </div>
      <button
        ref={!primary && !complex ? toggleButtonRef : undefined}
        className="translator-toast-dismiss"
        type="button"
        aria-label="Hide result"
        onClick={onClose}
      >
        <X aria-hidden />
      </button>
    </aside>
  );
}
