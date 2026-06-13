/**
 * Scan dialog — M1 (SPEC §7.2).
 *
 * Shown while a scan runs and afterwards when there is something to review.
 * During the scan it shows a spinner; on completion it summarizes the result
 * (mods / files found) and lists any skipped/malformed mods (warnings) — which
 * the main window otherwise only shows as a count. A clean scan auto-closes.
 */
import type { ScanResult } from "../tauri/commands";

interface ScanDialogProps {
  scanning: boolean;
  result: ScanResult | null;
  error: string | null;
  onClose: () => void;
}

export function ScanDialog({
  scanning,
  result,
  error,
  onClose,
}: ScanDialogProps) {
  return (
    <div
      className="editor__backdrop"
      onMouseDown={scanning ? undefined : onClose}
    >
      <div
        className="scandlg"
        role="dialog"
        aria-label="Scan"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="scandlg__head">
          <strong>
            <span
              className={`dlgicon ${
                scanning
                  ? "dlgicon--gold"
                  : error
                    ? "dlgicon--err"
                    : "dlgicon--ok"
              }`}
              aria-hidden
            >
              {scanning ? "⟳" : error ? "✕" : "✓"}
            </span>
            {scanning
              ? "Scanning mods…"
              : error
                ? "Scan failed"
                : "Scan complete"}
          </strong>
        </div>

        <div className="scandlg__body">
          {scanning ? (
            <div className="scandlg__busy">
              <span className="scandlg__spinner" aria-hidden />
              <span>Reading your Mods folder…</span>
            </div>
          ) : error ? (
            <p className="scandlg__error">{error}</p>
          ) : result ? (
            <>
              <p>
                Found <strong>{result.modCount}</strong>{" "}
                {result.modCount === 1 ? "mod" : "mods"} ·{" "}
                <strong>{result.fileCount}</strong>{" "}
                {result.fileCount === 1 ? "file" : "files"}.
              </p>
              {result.warnings.length > 0 ? (
                <div className="scandlg__warnings">
                  <span className="scandlg__muted">
                    {result.warnings.length} skipped:
                  </span>
                  <ul>
                    {result.warnings.map((warning, i) => (
                      <li key={i}>{warning}</li>
                    ))}
                  </ul>
                </div>
              ) : (result.extraKeys?.length ?? 0) === 0 ? (
                <p className="scandlg__muted">
                  No problems — every mod parsed cleanly.
                </p>
              ) : null}
              {(result.extraKeys?.length ?? 0) > 0 && (
                <div className="scandlg__warnings">
                  <span className="scandlg__muted">
                    {result.extraKeys!.length} extra{" "}
                    {result.extraKeys!.length === 1 ? "key" : "keys"} in
                    existing translation files:
                  </span>
                  <ul>
                    {result.extraKeys!.map((diagnostic, i) => (
                      <li
                        key={`${diagnostic.targetPath}:${diagnostic.key}:${i}`}
                      >
                        <strong>{diagnostic.modName}</strong> ·{" "}
                        <code>{diagnostic.targetPath}</code> ·{" "}
                        <code>{diagnostic.key}</code>
                      </li>
                    ))}
                  </ul>
                  <p className="scandlg__muted">
                    These stale keys are ignored and do not block export.
                  </p>
                </div>
              )}
            </>
          ) : null}
        </div>

        {!scanning && (
          <div className="scandlg__foot">
            <button type="button" onClick={onClose} autoFocus>
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
