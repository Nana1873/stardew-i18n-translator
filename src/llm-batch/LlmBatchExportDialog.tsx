import { X } from "lucide-react";
import { useRef, useState } from "react";
import { useDialogAccessibility } from "../dialogAccessibility";

interface LlmBatchExportDialogProps {
  eligibleCount: number;
  modName: string;
  suggestedFileName: string;
  /** Opens the native Save picker without writing yet. */
  onChooseDestination: () => Promise<string | null>;
  /** Returns false when the native Save dialog was cancelled. */
  onSave: (destinationPath: string | null) => Promise<boolean>;
  onClose: () => void;
}

export function LlmBatchExportDialog({
  eligibleCount,
  modName,
  suggestedFileName,
  onChooseDestination,
  onSave,
  onClose,
}: LlmBatchExportDialogProps) {
  const [pending, setPending] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [destinationPath, setDestinationPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const { onDialogKeyDown } = useDialogAccessibility({
    dialogRef,
    onEscape: onClose,
    escapeDisabled: pending || choosing,
  });

  const displayedFileName =
    destinationPath?.split(/[\\/]/).filter(Boolean).at(-1) ?? suggestedFileName;

  async function chooseDestination() {
    if (pending || choosing) return;
    setChoosing(true);
    setError(null);
    try {
      const path = await onChooseDestination();
      if (path) setDestinationPath(path);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setChoosing(false);
    }
  }

  async function save() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const saved = await onSave(destinationPath);
      if (saved) onClose();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="translator-flow-overlay">
      <section
        ref={dialogRef}
        className="translator-flow-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Save LLM batch"
        onKeyDown={onDialogKeyDown}
      >
        <div className="translator-flow-head">
          <div>
            <h2 className="translator-heading">
              Export selection as LLM batch
            </h2>
            <div className="translator-kicker">
              {eligibleCount} eligible{" "}
              {eligibleCount === 1 ? "string" : "strings"} · {modName}
            </div>
          </div>
          <button
            className="translator-icon-button"
            type="button"
            aria-label="Cancel batch export"
            onClick={onClose}
            disabled={pending || choosing}
          >
            <X aria-hidden />
          </button>
        </div>
        <div className="translator-flow-body">
          <label className="translator-flow-field">
            File name
            <input value={displayedFileName} readOnly />
          </label>
          <div className="translator-file-choice">
            <span>
              <strong>Save location</strong>
              <br />
              <code>
                {destinationPath ?? "Choose in the native Save dialog"}
              </code>
            </span>
            <button
              className="translator-button translator-button-quiet"
              type="button"
              disabled={pending || choosing}
              onClick={() => void chooseDestination()}
            >
              {choosing ? "Choosing…" : "Change …"}
            </button>
          </div>
          <div className="translator-flow-callout">
            Only selected open or changed strings are exported. Done entries and
            strings already awaiting review are excluded.
          </div>
          {error && (
            <div className="translator-flow-callout is-error" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="translator-flow-foot">
          <button
            className="translator-button translator-button-quiet"
            type="button"
            onClick={onClose}
            disabled={pending || choosing}
          >
            Cancel
          </button>
          <button
            className="translator-button translator-button-primary"
            type="button"
            onClick={() => void save()}
            disabled={pending || choosing || eligibleCount === 0}
          >
            {pending ? "Saving…" : "Save JSON batch"}
          </button>
        </div>
      </section>
    </div>
  );
}
