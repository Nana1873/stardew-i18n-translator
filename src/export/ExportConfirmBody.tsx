import {
  ExportCounts,
  ExportDialogHead,
  ExportSection,
  LeftOutStrings,
} from "./ExportOverview";
import { FolderInput } from "lucide-react";
import { useState } from "react";
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
  chooser,
  switching = false,
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
  const targetPaths = [...existingTargetPaths, ...newTargetPaths];
  const [showAllPaths, setShowAllPaths] = useState(false);
  const modCount = mods ?? 1;
  const baseName = (path: string) =>
    path.replace(/\\/g, "/").split("/").pop() ?? path;

  const writeSentence = (
    <>
      {existingFiles > 0 && (
        <>
          Replaces {existingFiles} existing{" "}
          {existingFiles === 1 ? "translation file" : "translation files"}
        </>
      )}
      {existingFiles > 0 && newFiles > 0 && " and creates "}
      {existingFiles === 0 && newFiles > 0 && "Creates "}
      {newFiles > 0 && (
        <>
          {newFiles} new{" "}
          {newFiles === 1 ? "translation file" : "translation files"}
        </>
      )}
      {targetCount === 0 && "No translation files to write"}.
    </>
  );

  return (
    <div className="translator-flow-overlay">
      <section
        ref={dialogRef}
        className="translator-flow-dialog desktop-xd"
        role="dialog"
        aria-modal="true"
        aria-labelledby="translator-export-title"
        aria-describedby="translator-export-summary"
        tabIndex={-1}
        onKeyDown={onDialogKeyDown}
      >
        <ExportDialogHead
          titleId="translator-export-title"
          subject={
            mods != null ? `${mods} ${mods === 1 ? "mod" : "mods"}` : modName
          }
          language={targetLanguage}
          closeLabel="Cancel export"
          onClose={onCancel}
        />
        {chooser}

        <div className="desktop-xd-dest">
          <FolderInput aria-hidden="true" />
          <div>
            <p className="desktop-xd-dest-title">
              Writes directly into your Mods folder
              {modCount > 1 && <span> · into {modCount} mod folders</span>}
            </p>
            {targetPaths.length > 0 ? (
              <ul className="desktop-xd-dest-paths" title={modsRoot}>
                {(showAllPaths ? targetPaths : targetPaths.slice(0, 1)).map(
                  (path) => (
                    <li key={path}>
                      <code>Mods/{displayPath(path)}</code>
                    </li>
                  ),
                )}
                {targetPaths.length > 1 && (
                  <li>
                    <button
                      className="desktop-xd-link desktop-xd-dest-more"
                      type="button"
                      aria-expanded={showAllPaths}
                      onClick={() => setShowAllPaths((value) => !value)}
                    >
                      {showAllPaths
                        ? "Show fewer"
                        : `+${targetPaths.length - 1} more`}
                    </button>
                  </li>
                )}
              </ul>
            ) : (
              <p className="desktop-xd-dest-note">
                No translation files to write.
              </p>
            )}
            <p className="desktop-xd-dest-note">
              {targetCount > 1
                ? "The game uses them on the next start."
                : "The game uses it on the next start."}
              {existingFiles === 1 &&
                ` The existing ${baseName(existingTargetPaths[0] ?? "") || "file"} is backed up first (.json.bak).`}
              {existingFiles > 1 &&
                ` ${existingFiles} existing files are backed up first (.json.bak).`}
            </p>
          </div>
        </div>

        <div className="desktop-xd-body" aria-busy={switching || undefined}>
          <ExportCounts
            label="Export contents"
            included={willWrite}
            untranslated={openOmitted}
            leftOut={omitted.length}
            needsReview={attention}
            keptOnPurpose={acceptedMismatches}
          />

          <LeftOutStrings
            problems={omitted}
            target="export"
            showModNames={(mods ?? 1) > 1}
            onInspect={onInspectProblem}
            disabled={switching}
          />

          <div className="desktop-xd-sections">
            <ExportSection
              title="Details"
              summary={writeSentence}
              summaryId="translator-export-summary"
            >
              <div className="desktop-xd-details">
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
                    <p>The file list appears after export.</p>
                  )}
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
                    " Tokens checked."}
                  {existingFiles > 0 &&
                    " A failed write rolls back the affected files and backups."}
                </p>
                {lastExportLabel && <p>{lastExportLabel}</p>}
              </div>
            </ExportSection>
          </div>
        </div>

        <div className="desktop-xd-foot">
          <button
            className="translator-button translator-button-quiet"
            type="button"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className="translator-button translator-button-primary"
            type="button"
            onClick={onConfirm}
            disabled={switching}
          >
            {switching
              ? "Checking…"
              : existingFiles > 0
                ? "Replace in Mods folder"
                : "Export to Mods folder"}
          </button>
        </div>
      </section>
    </div>
  );
}
