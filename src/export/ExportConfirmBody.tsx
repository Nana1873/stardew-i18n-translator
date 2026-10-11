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
  omitted = [],
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
        aria-describedby="translator-export-summary"
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
          {omitted.length > 0 && (
            <div
              className="translator-flow-callout is-warning"
              aria-label="Strings left out of the export"
            >
              <p>
                <AlertTriangle aria-hidden="true" />{" "}
                <strong>
                  {omitted.length}{" "}
                  {omitted.length === 1 ? "string stays" : "strings stay"} in
                  English
                </strong>
              </p>
              <p>
                {omitted.length === 1 ? "It has" : "They have"} a token error
                that would break the game, so the export leaves{" "}
                {omitted.length === 1 ? "it" : "them"} out. Everything else is
                exported. Fix {omitted.length === 1 ? "it" : "them"} in the
                editor, or use <strong>Save anyway</strong> if the change is
                intended.
              </p>
              <ul>
                {omitted.slice(0, 3).map((problem) => (
                  <li key={`${problem.relativeDir}\0${problem.key}`}>
                    <code>{problem.key}</code> {problem.reason}
                  </li>
                ))}
                {omitted.length > 3 && <li>and {omitted.length - 3} more</li>}
              </ul>
            </div>
          )}
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
                    {willWrite === 1 ? "translation" : "translations"} included
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
                    {newFiles === 1 ? "translation file" : "translation files"}
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

          {acceptedMismatches != null && acceptedMismatches > 0 && (
            <p className="desktop-export-muted">
              {acceptedMismatches} accepted protected-token{" "}
              {acceptedMismatches === 1 ? "mismatch" : "mismatches"}.
            </p>
          )}

          <details className="desktop-export-details">
            <summary>
              Details
              {targetCount > 0 && (
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
              {
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
                      omitted.length === 0 &&
                      " Protected-token checks passed."}
                    {existingFiles > 0 &&
                      " A failed write rolls back the affected files and backups."}
                  </p>
                </>
              }
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
          {omitted.length > 0 && (
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
          >
            {existingFiles > 0 ? "Export and replace" : "Export JSON"}
          </button>
        </div>
      </section>
    </div>
  );
}
