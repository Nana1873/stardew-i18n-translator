import { FileSearch, X } from "lucide-react";
import { useRef, useState } from "react";
import { useDialogAccessibility } from "../dialogAccessibility";

interface ImportBatchDialogProps {
  targetName: string;
  targetLanguage: string;
  initialPath?: string | null;
  initialError?: string | null;
  onChooseFile: () => Promise<string | null>;
  onImport: (path: string) => Promise<void>;
  onClose: () => void;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).at(-1) || path;
}

export function ImportBatchDialog({
  targetName,
  targetLanguage,
  initialPath = null,
  initialError = null,
  onChooseFile,
  onImport,
  onClose,
}: ImportBatchDialogProps) {
  const [path, setPath] = useState(initialPath);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [invalidSelection, setInvalidSelection] = useState(
    Boolean(initialError),
  );
  const dialogRef = useRef<HTMLElement>(null);
  const { onDialogKeyDown } = useDialogAccessibility({
    dialogRef,
    onEscape: onClose,
    escapeDisabled: pending,
  });

  async function choose() {
    setError(null);
    try {
      const chosen = await onChooseFile();
      if (chosen) {
        setPath(chosen);
        if (!chosen.toLocaleLowerCase("en").endsWith(".json")) {
          setInvalidSelection(true);
          setError(
            "Invalid file type. Exactly one JSON batch file is required.",
          );
        } else {
          setInvalidSelection(false);
        }
      }
    } catch (cause) {
      setError(String(cause));
    }
  }

  async function confirm() {
    if (!path || pending) return;
    setPending(true);
    setError(null);
    try {
      await onImport(path);
      onClose();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="stv3-flow-overlay">
      <section
        ref={dialogRef}
        className="stv3-flow-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="stv3-import-title"
        aria-describedby="stv3-import-description"
        onKeyDown={onDialogKeyDown}
      >
        <div className="stv3-flow-head">
          <div>
            <h2 className="stv3-heading" id="stv3-import-title">
              Import LLM batch
            </h2>
            <div className="stv3-kicker">
              Target: {targetName} · {targetLanguage}
            </div>
          </div>
          <button
            className="stv3-icon-button"
            type="button"
            aria-label="Cancel import"
            onClick={onClose}
            disabled={pending}
          >
            <X aria-hidden />
          </button>
        </div>
        <div className="stv3-flow-body">
          <p id="stv3-import-description">
            Choose the translated JSON returned by your LLM. It must match this
            mod, {targetLanguage}, and the current English source.
          </p>
          <div
            className="stv3-file-choice stv3-drop-zone"
            data-import-valid={
              invalidSelection ? "false" : path ? "true" : undefined
            }
          >
            <span>
              <strong>{path ? fileName(path) : "No file selected"}</strong>
              <br />
              <code>
                {path ?? "*.llm-result.json or translated *.llm-batch.json"}
              </code>
            </span>
            <button
              className="stv3-button stv3-button-quiet"
              type="button"
              onClick={() => void choose()}
              disabled={pending}
            >
              <FileSearch aria-hidden /> Choose file …
            </button>
          </div>
          <div className="stv3-flow-callout">
            Existing translations stay unchanged. Valid imported values go to
            Review.
          </div>
          <div className="stv3-flow-callout is-warning">
            Detailed import preflight is unavailable in this phase. The backend
            still validates the complete file before the first write.
          </div>
          {error && (
            <div className="stv3-flow-callout is-error" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="stv3-flow-foot">
          <button
            className="stv3-button stv3-button-quiet"
            type="button"
            onClick={onClose}
            disabled={pending}
          >
            Cancel
          </button>
          <button
            className="stv3-button stv3-button-primary"
            type="button"
            disabled={!path || invalidSelection || pending}
            onClick={() => void confirm()}
          >
            {pending ? "Importing…" : "Import file"}
          </button>
        </div>
      </section>
    </div>
  );
}
