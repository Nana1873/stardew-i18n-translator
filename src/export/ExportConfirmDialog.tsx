import { useRef } from "react";
import { AlertTriangle, X } from "lucide-react";
import { useDialogAccessibility } from "../dialogAccessibility";

export interface ExportBlockingProblem {
  key: string;
  reason: string;
}

interface ExportConfirmDialogProps {
  modName: string;
  modsRoot?: string;
  targetLanguage?: string;
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
  modsRoot,
  targetLanguage,
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
  const root = modsRoot?.replace(/\\/g, "/").replace(/\/+$/, "");
  const displayPath = (path: string) => {
    const normalized = path.replace(/\\/g, "/");
    return root && normalized.toLowerCase().startsWith(root.toLowerCase() + "/")
      ? normalized.slice(root.length + 1)
      : path;
  };

  return (
    <div className="translator-flow-overlay">
      <section
        ref={dialogRef}
        className="translator-flow-dialog translator-export-dialog"
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
            <div className="translator-kicker">
              {modName}
              {targetLanguage ? ` · ${targetLanguage}` : ""}
            </div>
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

              <p>
                This writes into the installed mods. To manage translations as a
                separate mod, use a translation ZIP instead.
              </p>

              <div
                className="translator-preflight-metrics"
                aria-label="Export readiness"
              >
                <Metric value={willWrite} label="texts with a value" />
                {(openOmitted == null || openOmitted > 0) && (
                  <Metric value={openOmitted} label="open strings omitted" />
                )}
              </div>

              {modsRoot && (
                <div className="translator-result-path">
                  <span>Mods folder</span>
                  <code>{modsRoot}</code>
                </div>
              )}

              {existingTargetPaths.length > 0 && (
                <div className="translator-result-path">
                  <span>
                    {existingTargetPaths.length === 1
                      ? "Existing target"
                      : "Existing targets"}{" "}
                    · backed up as .json.bak
                  </span>
                  {existingTargetPaths.map((path) => (
                    <code key={path} title={path}>
                      {displayPath(path)}
                    </code>
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
                    <code key={path} title={path}>
                      {displayPath(path)}
                    </code>
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
                  Review and Changed counts are unavailable.{" "}
                  {blockingValidationAvailable
                    ? "Protected-token checks passed."
                    : "All selected files will be checked before writing."}
                </div>
              ) : attention > 0 ? (
                <div className="translator-flow-callout is-warning">
                  <AlertTriangle aria-hidden="true" /> {attention} included{" "}
                  {attention === 1 ? "string is" : "strings are"} not Done:{" "}
                  {changedIncluded} Changed and {reviewIncluded} in Review.{" "}
                  Check these strings before sharing the translation.
                </div>
              ) : blockingValidationAvailable ? (
                <div className="translator-flow-callout is-success">
                  Ready to export. No included strings are Changed or in Review.
                </div>
              ) : (
                <div className="translator-flow-callout">
                  No included strings are Changed or in Review. Protected tokens
                  will be checked before writing.
                </div>
              )}

              {acceptedMismatches != null && acceptedMismatches > 0 && (
                <div className="translator-flow-callout">
                  <strong>Accepted mismatch:</strong> {acceptedMismatches}{" "}
                  {acceptedMismatches === 1 ? "string has" : "strings have"} an
                  explicitly accepted protected-token difference.
                </div>
              )}

              <details className="translator-export-details">
                <summary>Details</summary>
                <div className="translator-export-details-body">
                  <span>
                    Counts reflect the current scan. All selected files are
                    checked again before writing. Existing files receive visible{" "}
                    <code>.json.bak</code> backups and a failed package write is
                    rolled back.
                  </span>
                  <span>
                    No files are changed if a blocking issue is found.
                  </span>
                  {lastExportLabel && <span>{lastExportLabel}</span>}
                </div>
              </details>
            </>
          )}

          {blockingProblem && (
            <>
              <div
                className="translator-flow-callout is-error"
                id="translator-export-blocker"
                role="alert"
              >
                <strong>Export blocked:</strong>{" "}
                <code>{blockingProblem.key}</code> {blockingProblem.reason}. No
                files will be changed.
              </div>
              {acceptedMismatches != null && (
                <div
                  className="translator-preflight-metrics"
                  aria-label="Export readiness"
                >
                  <Metric
                    value={acceptedMismatches}
                    label="accepted mismatches"
                  />
                </div>
              )}
            </>
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
