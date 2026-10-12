import { ExportConfirmBody } from "./ExportConfirmBody";
import { useRef, type ReactNode } from "react";
import { useDialogAccessibility } from "../dialogAccessibility";
import { EXPORT_CHOOSER_FOCUS, useStickyExportHeight } from "./ExportChooser";

import type { LeftOutString } from "./ExportOverview";

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
  /** Strings left out of the export; the game shows their English source. */
  omitted?: LeftOutString[];
  /** True only when the caller has validated the complete selected scope. */
  blockingValidationAvailable?: boolean;
  /** Opens one omitted string in the editor. */
  onInspectProblem?: (problem: LeftOutString) => void;
  /** Current-session value only; no history is invented. */
  lastExportLabel?: string | null;
  /** The Export… choice shown above the preview. */
  chooser?: ReactNode;
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
  omitted = [],
  blockingValidationAvailable = false,
  onInspectProblem,
  lastExportLabel = null,
  chooser,
  onConfirm,
  onCancel,
}: ExportConfirmDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  useStickyExportHeight(dialogRef, Boolean(chooser));
  const { onDialogKeyDown } = useDialogAccessibility({
    dialogRef,
    onEscape: onCancel,
    initialFocusSelector: chooser ? EXPORT_CHOOSER_FOCUS : undefined,
  });
  return (
    <ExportConfirmBody
      modName={modName}
      modsRoot={modsRoot}
      targetLanguage={targetLanguage}
      existingFiles={existingFiles}
      newFiles={newFiles}
      mods={mods}
      willWrite={willWrite}
      openOmitted={openOmitted}
      changedIncluded={changedIncluded}
      reviewIncluded={reviewIncluded}
      acceptedMismatches={acceptedMismatches}
      existingTargetPaths={existingTargetPaths}
      newTargetPaths={newTargetPaths}
      omitted={omitted}
      blockingValidationAvailable={blockingValidationAvailable}
      onInspectProblem={onInspectProblem}
      lastExportLabel={lastExportLabel}
      chooser={chooser}
      onConfirm={onConfirm}
      onCancel={onCancel}
      dialogRef={dialogRef}
      onDialogKeyDown={onDialogKeyDown}
    />
  );
}
