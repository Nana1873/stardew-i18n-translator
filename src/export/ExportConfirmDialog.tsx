import { useRef } from "react";
import { AlertTriangle, X } from "lucide-react";
import { useDialogAccessibility } from "../dialogAccessibility";

export interface ExportBlockingProblem {
  key: string;
  reason: string;
}

interface ExportConfirmDialogProps {
  modName: string;
  /** Number of existing target files which will receive visible backups. */
  existingFiles: number;
  /** Number of target files which do not exist yet and will be created. */
  newFiles?: number;
  mods?: number | null;
  /** Current scan aggregates. Null means the UI cannot derive the value. */
  willWrite?: number | null;
  openOmitted?: number | null;
  changedIncluded?: number | null;
  reviewIncluded?: number | null;
  acceptedMismatches?: number | null;
  /** Real existing target paths from the selected scanned i18n components. */
  existingTargetPaths?: string[];
  /** Real new target paths from the selected scanned i18n components. */
  newTargetPaths?: string[];
  blockingProblem?: ExportBlockingProblem | null;
  /** True only when the caller has validated the complete selected scope. */
  blockingValidationAvailable?: boolean;
  onInspectProblem?: () => void;
  /** Current-session value only; no history is invented. */
  lastExportLabel?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ExportConfirmDialog({
  modName,
  existingFiles,
  newFiles = 0,
  mods = null,
  willWrite = null,
  openOmitted = null,
  changedIncluded = null,
  reviewIncluded = null,
  acceptedMismatches = null,
  existingTargetPaths = [],
  newTargetPaths = [],
  blockingProblem = null,
  blockingValidationAvailable = false,
  onInspectProblem,
  lastExportLabel = null,
  onConfirm,
  onCancel,
}: ExportConfirmDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const { onDialogKeyDown } = useDialogAccessibility({
    dialogRef,
    onEscape: onCancel,
  });
  const attentionKnown = changedIncluded != null && reviewIncluded != null;
  const attention = attentionKnown ? changedIncluded + reviewIncluded : null;
  const replacing = existingFiles > 0;
  const creating = newFiles > 0;
  const allMods = mods != null;

  return (
    <div className="translator-flow-overlay">
      <section
        ref={dialogRef}
        className="translator-flow-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Confirm export overwrite"
        aria-describedby={
          blockingProblem
            ? "translator-export-blocker"
            : "translator-export-summary"
        }
        onKeyDown={onDialogKeyDown}
      >
        <div className="translator-flow-head">
          <div>
            <h2 className="translator-heading">
              {allMods ? "Export all mods?" : "Export current mod?"}
            </h2>
            <div className="translator-kicker">{modName}</div>
          </div>
          <button
            className="translator-icon-button"
            type="button"
            aria-label="Cancel export"
            onClick={onCancel}
          >
            <X aria-hidden="true" />
          </button>
        </div>

        <div className="translator-flow-body">
          {!blockingProblem && (
            <>
              <p id="translator-export-summary">
                {replacing && (
                  <>
                    This export replaces <strong>{existingFiles}</strong>{" "}
                    existing{" "}
                    {existingFiles === 1
                      ? "translation file"
                      : "translation files"}
                  </>
                )}
                {replacing && creating && " and "}
                {creating && (
                  <>
                    {!replacing && "This export "}creates{" "}
                    <strong>{newFiles}</strong> new{" "}
                    {newFiles === 1 ? "translation file" : "translation files"}
                  </>
                )}
                {!replacing &&
                  !creating &&
                  "This export has no target-language translation files to write"}
                {mods != null && (replacing || creating) && (
                  <>
                    {" "}
                    across <strong>{mods}</strong> {mods === 1 ? "mod" : "mods"}
                  </>
                )}
                .
              </p>

              <div
                className="translator-preflight-metrics"
                aria-label="Export readiness"
              >
                <Metric value={willWrite} label="currently eligible" />
                <Metric value={openOmitted} label="currently open" />
                <Metric value={changedIncluded} label="currently changed" />
                <Metric value={reviewIncluded} label="currently in review" />
                <Metric
                  value={acceptedMismatches}
                  label="accepted mismatches"
                />
              </div>

              {existingTargetPaths.length > 0 && (
                <div className="translator-result-path">
                  <span>
                    {existingTargetPaths.length === 1
                      ? "Existing target"
                      : "Existing targets"}{" "}
                    · backed up as .json.bak
                  </span>
                  {existingTargetPaths.map((path) => (
                    <code key={path}>{path}</code>
                  ))}
                </div>
              )}
              {newTargetPaths.length > 0 && (
                <div className="translator-result-path">
                  <span>
                    {newTargetPaths.length === 1 ? "New target" : "New targets"}{" "}
                    · created by this export
                  </span>
                  {newTargetPaths.map((path) => (
                    <code key={path}>{path}</code>
                  ))}
                </div>
              )}
              {existingTargetPaths.length === 0 &&
                newTargetPaths.length === 0 && (
                  <div className="translator-result-path">
                    <span>Targets</span>
                    <code>Unavailable before export</code>
                  </div>
                )}

              {attention == null ? (
                <div className="translator-flow-callout">
                  Changed and review aggregates are unavailable before this
                  export. Protected-token blocker preflight is also unavailable;
                  the backend validates the complete selected scope before any
                  file is written.
                </div>
              ) : attention > 0 ? (
                <div className="translator-flow-callout is-warning">
                  <AlertTriangle aria-hidden="true" /> {attention} included{" "}
                  {attention === 1 ? "string is" : "strings are"} not Done:{" "}
                  {changedIncluded} Changed and {reviewIncluded} in Review.
                  Protected-token blocker preflight is unavailable; the backend
                  remains the final write guard.
                </div>
              ) : blockingValidationAvailable ? (
                <div className="translator-flow-callout">
                  Ready to export. No included strings are Changed or in Review.
                </div>
              ) : (
                <div className="translator-flow-callout">
                  Export readiness · Unavailable before export. Known changed
                  and review counts are clear, but protected-token blockers are
                  validated by the backend when export starts.
                </div>
              )}

              <div className="translator-kicker">
                Counts above describe the current scan. The backend revalidates
                the complete scope atomically when export starts; no file is
                changed if a blocking issue is found.
              </div>

              {acceptedMismatches != null && acceptedMismatches > 0 && (
                <div className="translator-flow-callout">
                  <strong>Accepted mismatch:</strong> {acceptedMismatches}{" "}
                  {acceptedMismatches === 1
                    ? "exact source revision may"
                    : "exact source revisions may"}{" "}
                  be exported because the translator explicitly confirmed it.
                </div>
              )}

              <details className="translator-export-details">
                <summary>Safety and previous export</summary>
                <div className="translator-export-details-body">
                  <span>
                    The complete scope is validated before writing. Existing
                    files receive visible <code>.json.bak</code> backups and a
                    failed package write is rolled back.
                  </span>
                  <span>
                    Disk-change comparison: unavailable before export; backend
                    path authorization and validation remain active.
                  </span>
                  <span>
                    {lastExportLabel ??
                      "Previous export · Unavailable in this session"}
                  </span>
                </div>
              </details>
            </>
          )}

          {blockingProblem && (
            <div
              className="translator-flow-callout is-error"
              id="translator-export-blocker"
              role="alert"
            >
              <strong>Export blocked:</strong>{" "}
              <code>{blockingProblem.key}</code> {blockingProblem.reason}. No
              files will be changed.
            </div>
          )}
        </div>

        <div className="translator-flow-foot">
          <button
            className="translator-button translator-button-quiet"
            type="button"
            onClick={onCancel}
          >
            Cancel
          </button>
          {blockingProblem && (
            <button
              className="translator-button translator-button-quiet"
              type="button"
              onClick={onInspectProblem}
              disabled={!onInspectProblem}
            >
              Open issue
            </button>
          )}
          <button
            className="translator-button translator-button-primary"
            type="button"
            onClick={onConfirm}
            disabled={blockingProblem != null}
          >
            {allMods
              ? "Export all mods"
              : replacing
                ? "Export and replace"
                : "Export"}
          </button>
        </div>
      </section>
    </div>
  );
}

function Metric({ value, label }: { value: number | null; label: string }) {
  return (
    <div className="translator-preflight-metric">
      <strong>{value == null ? "Unavailable" : value}</strong>
      <span>{label}</span>
    </div>
  );
}
