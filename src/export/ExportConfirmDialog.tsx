import { ExportConfirmBody } from "./ExportConfirmBody";
import { useRef } from "react";
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
      blockingProblem={blockingProblem}
      blockingValidationAvailable={blockingValidationAvailable}
      onInspectProblem={onInspectProblem}
      lastExportLabel={lastExportLabel}
      onConfirm={onConfirm}
      onCancel={onCancel}
      dialogRef={dialogRef}
      onDialogKeyDown={onDialogKeyDown}
    />
  );
}
