/**
 * Export summary dialog — M3 (SPEC §17).
 *
 * Shown after the Export action runs. Reports what was written, what was
 * omitted (untranslated), what was exported-but-stale (outdated), and which
 * token-count errors blocked a mod before any files were written.
 */
import type { ExportResult, SkippedKey } from "../tauri/commands";

interface ExportDialogProps {
  modName: string;
  /** Set for an "export all" run: how many mods actually wrote a file. */
  modsWritten?: number | null;
  result: ExportResult | null;
  error: string | null;
  onInspectSkip?: (skip: SkippedKey) => void;
  onClose: () => void;
}

export function ExportDialog({
  modName,
  modsWritten = null,
  result,
  error,
  onInspectSkip,
  onClose,
}: ExportDialogProps) {
  return (
    <div className="editor__backdrop" onMouseDown={onClose}>
      <div
        className="exportdlg"
        role="dialog"
        aria-label="Export summary"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="exportdlg__head">
          <strong>
            <span
              className={`dlgicon ${error || result?.blocked ? "dlgicon--err" : "dlgicon--ok"}`}
              aria-hidden
            >
              {error || result?.blocked ? "✕" : "✓"}
            </span>
            {error
              ? "Export failed"
              : result?.blocked
                ? "Export blocked"
                : "Export complete"}
          </strong>
          <span className="editor__crumbs">{modName}</span>
        </div>

        {error ? (
          <p className="exportdlg__error">{error}</p>
        ) : result ? (
          <ExportSummary
            result={result}
            modsWritten={modsWritten}
            onInspectSkip={onInspectSkip}
          />
        ) : null}

        <div className="exportdlg__foot">
          <button type="button" onClick={onClose} autoFocus>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function ExportSummary({
  result,
  modsWritten,
  onInspectSkip,
}: {
  result: ExportResult;
  modsWritten: number | null;
  onInspectSkip?: (skip: SkippedKey) => void;
}) {
  const nothing =
    result.filesWritten === 0 &&
    result.filesRemoved === 0 &&
    result.skipped.length === 0;
  return (
    <div className="exportdlg__body">
      {result.blocked ? (
        <p>
          One or more mod exports were blocked. No files or backups were written
          for those mods. Fix every protected-token count mismatch below, then
          export again.
        </p>
      ) : nothing ? (
        <p className="exportdlg__muted">
          Nothing to export — no translated strings yet
          {modsWritten === null ? " for this mod" : ""}.
        </p>
      ) : (
        <p>
          {result.filesWritten > 0 && (
            <>
              Wrote <strong>{result.totalWrittenKeys}</strong>{" "}
              {result.totalWrittenKeys === 1 ? "string" : "strings"} across{" "}
              <strong>{result.filesWritten}</strong>{" "}
              {result.filesWritten === 1 ? "file" : "files"}
              {modsWritten !== null && (
                <>
                  {" "}
                  in <strong>{modsWritten}</strong>{" "}
                  {modsWritten === 1 ? "mod" : "mods"}
                </>
              )}
              .
            </>
          )}
          {result.filesRemoved > 0 && (
            <>
              {result.filesWritten > 0 ? " " : ""}
              Removed <strong>{result.filesRemoved}</strong> cleared{" "}
              {result.filesRemoved === 1 ? "file" : "files"} (backed up).
            </>
          )}
        </p>
      )}

      <ul className="exportdlg__stats">
        <li>
          <span className="exportdlg__dot exportdlg__dot--ok" /> Written:{" "}
          {result.totalWrittenKeys}
        </li>
        {result.filesRemoved > 0 && (
          <li>
            <span className="exportdlg__dot exportdlg__dot--muted" /> Removed
            (every translation cleared — backed up): {result.filesRemoved}
          </li>
        )}
        {result.totalUntranslated > 0 && (
          <li>
            <span className="exportdlg__dot exportdlg__dot--muted" />{" "}
            Untranslated (omitted, falls back to English):{" "}
            {result.totalUntranslated}
          </li>
        )}
        {result.totalOutdated > 0 && (
          <li>
            <span className="exportdlg__dot exportdlg__dot--warn" /> Outdated
            (exported — source changed, review advised): {result.totalOutdated}
          </li>
        )}
        {result.totalReviewNeeded > 0 && (
          <li>
            <span className="exportdlg__dot exportdlg__dot--warn" /> Needs
            review (exported — unreviewed AI suggestion):{" "}
            {result.totalReviewNeeded}
          </li>
        )}
        {result.skipped.length > 0 && (
          <li>
            <span className="exportdlg__dot exportdlg__dot--err" /> Blocking
            token errors:{" "}
            <button
              type="button"
              className="exportdlg__link"
              onClick={() => onInspectSkip?.(result.skipped[0])}
              disabled={!onInspectSkip}
            >
              {result.skipped.length}
            </button>
          </li>
        )}
        {result.totalOrphanKeys > 0 && (
          <li>
            <span className="exportdlg__dot exportdlg__dot--warn" /> Removed
            (key no longer in default.json; kept in the backup):{" "}
            {result.totalOrphanKeys}
          </li>
        )}
      </ul>

      {result.skipped.length > 0 && (
        <div className="exportdlg__skipped">
          <span className="exportdlg__muted">Affected strings:</span>
          <ul>
            {result.skipped.map((skip) => (
              <li key={`${skip.relativeDir}:${skip.key}`}>
                <button
                  type="button"
                  className="exportdlg__key-link"
                  onClick={() => onInspectSkip?.(skip)}
                  disabled={!onInspectSkip}
                  title="Show this string in the table"
                >
                  <code>{skip.key}</code>
                </button>{" "}
                — {skip.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {result.totalOrphanKeys > 0 && (
        <div className="exportdlg__skipped">
          <span className="exportdlg__muted">
            Removed keys (not in default.json — SMAPI ignores them; the previous
            file content is in the backup):
          </span>
          <ul>
            {result.files.flatMap((file) =>
              file.orphanKeys.map((key) => (
                <li key={`${file.relativeDir} ${key}`}>
                  <code>{key}</code>
                </li>
              )),
            )}
          </ul>
        </div>
      )}

      {result.files.some((file) => file.backedUp) && (
        <p className="exportdlg__muted exportdlg__backup">
          Existing target files were backed up to <code>.json.bak</code>.
        </p>
      )}
    </div>
  );
}
