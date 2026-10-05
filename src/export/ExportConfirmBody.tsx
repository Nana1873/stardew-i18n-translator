import { AlertTriangle, X } from "lucide-react";
import type { ComponentProps, KeyboardEventHandler, RefObject } from "react";
import type { ExportConfirmDialog } from "../export/ExportConfirmDialog";

type ExportProps = ComponentProps<typeof ExportConfirmDialog> & {
  dialogRef: RefObject<HTMLElement | null>;
  onDialogKeyDown: KeyboardEventHandler<HTMLElement>;
};

export function ExportConfirmBody({
  modName,
  modsRoot,
  targetLanguage,
  existingFiles,
  mods,
  newFiles = 0,
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
  lastExportLabel,
  onConfirm,
  onCancel,
  dialogRef,
  onDialogKeyDown,
}: ExportProps) {
  const attention =
    changedIncluded != null && reviewIncluded != null
      ? changedIncluded + reviewIncluded
      : null;
  const root = modsRoot?.replace(/\\/g, "/").replace(/\/+$/, "");
  const displayPath = (path: string) => {
    const normalized = path.replace(/\\/g, "/");
    return root && normalized.toLowerCase().startsWith(root.toLowerCase() + "/")
      ? normalized.slice(root.length + 1)
      : path;
  };
  const targetCount = existingFiles + newFiles;

  return (
    <div className="translator-flow-overlay">
      <section
        ref={dialogRef}
        className="translator-flow-dialog translator-export-dialog desktop-export-dialog"
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
            <h2 className="translator-heading">Export translation JSON</h2>
            <div className="translator-kicker">
              <span>{modName}</span>
              {targetLanguage && (
                <span className="desktop-export-language">
                  {targetLanguage}
                </span>
              )}
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
          {blockingProblem ? (
            <div
              className="desktop-export-blocker"
              id="translator-export-blocker"
              role="alert"
            >
              <p>
                <AlertTriangle aria-hidden="true" />
                <strong>Export blocked</strong>
              </p>
              <code>{blockingProblem.key}</code>
              <p>{blockingProblem.reason}</p>
              <p className="desktop-export-muted">No files will be changed.</p>
            </div>
          ) : (
            <>
              <div
                className="desktop-export-summary"
                aria-label="Export contents"
              >
                <p>
                  {willWrite == null ? (
                    "Translation count unavailable"
                  ) : (
                    <>
                      <strong>{willWrite}</strong>{" "}
                      {willWrite === 1 ? "translation" : "translations"}{" "}
                      included
                    </>
                  )}
                  {openOmitted != null && openOmitted > 0 && (
                    <span>{openOmitted} untranslated omitted</span>
                  )}
                </p>
                {attention != null && attention > 0 && (
                  <p className="desktop-export-review">
                    <AlertTriangle aria-hidden="true" />
                    Includes {attention}{" "}
                    {attention === 1
                      ? "translation that still needs"
                      : "translations that still need"}{" "}
                    review.
                  </p>
                )}
                {attention == null && (
                  <p className="desktop-export-muted">
                    Review and Changed counts unavailable.
                  </p>
                )}
              </div>

              <div className="desktop-export-write">
                <p id="translator-export-summary">
                  {existingFiles > 0 && (
                    <>
                      Replaces <strong>{existingFiles}</strong> existing{" "}
                      {existingFiles === 1
                        ? "translation file"
                        : "translation files"}
                    </>
                  )}
                  {existingFiles > 0 && newFiles > 0 && " and creates "}
                  {existingFiles === 0 && newFiles > 0 && "Creates "}
                  {newFiles > 0 && (
                    <>
                      <strong>{newFiles}</strong> new{" "}
                      {newFiles === 1
                        ? "translation file"
                        : "translation files"}
                    </>
                  )}
                  {targetCount === 0 && "No translation files to write"}.
                </p>
                <p className="desktop-export-muted">
                  Writes directly to the installed Mods folders.
                  {existingFiles > 0 &&
                    " Existing files are backed up as .json.bak."}
                </p>
              </div>

              {modsRoot && (
                <div className="desktop-export-location">
                  <span>Mods folder</span>
                  <code>{modsRoot}</code>
                </div>
              )}
            </>
          )}

          {acceptedMismatches != null && acceptedMismatches > 0 && (
            <p className="desktop-export-muted">
              {acceptedMismatches} accepted protected-token{" "}
              {acceptedMismatches === 1 ? "mismatch" : "mismatches"}.
            </p>
          )}

          <details className="desktop-export-details">
            <summary>
              Details
              {!blockingProblem && targetCount > 0 && (
                <span>
                  {targetCount} {targetCount === 1 ? "file" : "files"}
                </span>
              )}
            </summary>
            <div className="desktop-export-details-body">
              {mods != null && (
                <p>
                  {mods} {mods === 1 ? "mod" : "mods"} included.
                </p>
              )}
              {existingTargetPaths.length > 0 && (
                <div>
                  <strong>Files to replace</strong>
                  <ul>
                    {existingTargetPaths.map((path) => (
                      <li key={path}>
                        <code title={path}>{displayPath(path)}</code>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {newTargetPaths.length > 0 && (
                <div>
                  <strong>New files</strong>
                  <ul>
                    {newTargetPaths.map((path) => (
                      <li key={path}>
                        <code title={path}>{displayPath(path)}</code>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {existingTargetPaths.length === 0 &&
                newTargetPaths.length === 0 && (
                  <p>Target paths unavailable before export.</p>
                )}
              {!blockingProblem && (
                <>
                  {attention != null && attention > 0 && (
                    <p>
                      {reviewIncluded} in Review, {changedIncluded} Changed.
                      Export keeps their status.
                    </p>
                  )}
                  {openOmitted != null && openOmitted > 0 && (
                    <p>
                      Untranslated strings are omitted so the game can use the
                      English source.
                    </p>
                  )}
                  <p>
                    Counts reflect the current scan. Files are checked again
                    before writing.
                    {blockingValidationAvailable &&
                      " Protected-token checks passed."}
                    {existingFiles > 0 &&
                      " A failed write rolls back the affected files and backups."}
                  </p>
                </>
              )}
              {lastExportLabel && <p>{lastExportLabel}</p>}
            </div>
          </details>
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
              Open string
            </button>
          )}
          <button
            className="translator-button translator-button-primary"
            type="button"
            onClick={onConfirm}
            disabled={blockingProblem != null}
          >
            {existingFiles > 0 && !blockingProblem
              ? "Export and replace"
              : "Export JSON"}
          </button>
        </div>
      </section>
    </div>
  );
}
