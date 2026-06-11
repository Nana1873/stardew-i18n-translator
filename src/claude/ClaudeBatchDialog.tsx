/**
 * Claude-Code batch dialogs — M4 (SPEC §11).
 *
 * Two small summary dialogs around the offline translation workflow: one
 * confirms what the batch export wrote (and what to do with the file), one
 * reports what an import staged. All imported values land as `review-needed`
 * — machine output always needs a human pass.
 */
import type {
  ClaudeExportOutcome,
  ClaudeImportSummary,
} from "../tauri/commands";

export function ClaudeExportDialog({
  outcome,
  error,
  modName,
  onClose,
}: {
  outcome: ClaudeExportOutcome | null;
  error: string | null;
  modName: string;
  onClose: () => void;
}) {
  return (
    <div className="editor__backdrop" onMouseDown={onClose}>
      <div
        className="exportdlg"
        role="dialog"
        aria-label="Claude batch export"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="exportdlg__head">
          <strong>
            <span
              className={`dlgicon ${error ? "dlgicon--err" : "dlgicon--gold"}`}
              aria-hidden
            >
              {error ? "✕" : "↑"}
            </span>
            {error ? "Batch export failed" : "Batch exported"}
          </strong>
          <span className="editor__crumbs">{modName}</span>
        </div>
        <div className="exportdlg__body">
          {error ? (
            <p className="exportdlg__error">{error}</p>
          ) : outcome ? (
            <>
              <p>
                Wrote <strong>{outcome.stringCount}</strong>{" "}
                {outcome.stringCount === 1 ? "string" : "strings"}
                {outcome.glossaryTerms > 0 && (
                  <> and {outcome.glossaryTerms} glossary terms</>
                )}{" "}
                to:
              </p>
              <p>
                <code>{outcome.path}</code>
              </p>
              <p className="exportdlg__muted">
                Open the file with Claude Code (or any LLM) — it contains the
                translation instructions. When the translated file is ready,
                bring it back via <strong>Import batch…</strong> in the toolbar.
                Imported strings arrive as “Needs review”.
              </p>
            </>
          ) : null}
        </div>
        <div className="exportdlg__foot">
          <button type="button" onClick={onClose} autoFocus>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

export function ClaudeImportDialog({
  summary,
  modName,
  error,
  onClose,
}: {
  summary: ClaudeImportSummary | null;
  modName: string;
  error: string | null;
  onClose: () => void;
}) {
  return (
    <div className="editor__backdrop" onMouseDown={onClose}>
      <div
        className="exportdlg"
        role="dialog"
        aria-label="Claude batch import"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="exportdlg__head">
          <strong>
            <span
              className={`dlgicon ${error ? "dlgicon--err" : "dlgicon--gold"}`}
              aria-hidden
            >
              {error ? "✕" : "↓"}
            </span>
            {error ? "Batch import failed" : "Batch imported"}
          </strong>
          <span className="editor__crumbs">{modName}</span>
        </div>
        <div className="exportdlg__body">
          {error ? (
            <p className="exportdlg__error">{error}</p>
          ) : summary ? (
            <>
              <p>
                Imported <strong>{summary.imported}</strong> of{" "}
                {summary.totalInFile}{" "}
                {summary.totalInFile === 1 ? "string" : "strings"} as “Needs
                review” — confirm each one with an explicit Save in the editor.
              </p>
              <ul className="exportdlg__stats">
                {summary.skippedTranslated > 0 && (
                  <li>
                    <span className="exportdlg__dot exportdlg__dot--muted" />{" "}
                    Skipped (already translated locally — never overwritten):{" "}
                    {summary.skippedTranslated}
                  </li>
                )}
                {summary.unmatched > 0 && (
                  <li>
                    <span className="exportdlg__dot exportdlg__dot--muted" />{" "}
                    Unmatched (unknown key or empty value): {summary.unmatched}
                  </li>
                )}
                {summary.tokenIssues > 0 && (
                  <li>
                    <span className="exportdlg__dot exportdlg__dot--err" />{" "}
                    Missing protected tokens (imported — fix before export):{" "}
                    {summary.tokenIssues}
                  </li>
                )}
                {summary.identicalToSource > 0 && (
                  <li>
                    <span className="exportdlg__dot exportdlg__dot--warn" />{" "}
                    Identical to the English source (possibly untranslated):{" "}
                    {summary.identicalToSource}
                  </li>
                )}
              </ul>
              {summary.tokenIssueKeys.length > 0 && (
                <div className="exportdlg__skipped">
                  <span className="exportdlg__muted">
                    Keys with missing tokens (paste one into the search box to
                    jump to it; export skips these until fixed):
                  </span>
                  <ul>
                    {summary.tokenIssueKeys.map((key) => (
                      <li key={key}>
                        <code>{key}</code>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          ) : null}
        </div>
        <div className="exportdlg__foot">
          <button type="button" onClick={onClose} autoFocus>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
