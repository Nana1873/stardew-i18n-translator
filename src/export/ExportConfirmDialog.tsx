interface ExportConfirmDialogProps {
  modName: string;
  files: number;
  mods?: number | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ExportConfirmDialog({
  modName,
  files,
  mods = null,
  onConfirm,
  onCancel,
}: ExportConfirmDialogProps) {
  return (
    <div className="editor__backdrop" onMouseDown={onCancel}>
      <div
        className="exportdlg exportconfirm"
        role="dialog"
        aria-label="Confirm export overwrite"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="exportdlg__head">
          <strong>Replace existing translations?</strong>
          <span className="editor__crumbs">{modName}</span>
        </div>

        <div className="exportdlg__body">
          <p>
            This export will replace <strong>{files}</strong> existing{" "}
            {files === 1 ? "translation file" : "translation files"}
            {mods !== null && (
              <>
                {" "}
                across <strong>{mods}</strong> {mods === 1 ? "mod" : "mods"}
              </>
            )}
            .
          </p>
          <p className="exportdlg__muted">
            Each current file is copied to <code>.json.bak</code> before the new
            translation is written.
          </p>
        </div>

        <div className="exportdlg__foot">
          <button
            type="button"
            className="exportdlg__secondary"
            onClick={onCancel}
            autoFocus
          >
            Cancel
          </button>
          <button type="button" onClick={onConfirm}>
            Export and replace
          </button>
        </div>
      </div>
    </div>
  );
}
