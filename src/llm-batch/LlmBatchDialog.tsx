/**
 * External LLM batch dialogs — M4 (SPEC §11).
 *
 * Summary dialog for writing an offline translation batch. Import results use
 * the persistent workspace result tray (SPEC §7.5.1).
 */
import type { LlmExportOutcome } from "../tauri/commands";

const HANDOFF_PROMPT =
  'Follow the "instructions" in the attached batch JSON and return the completed result as a downloadable JSON file.';

export function LlmExportDialog({
  outcome,
  error,
  modName,
  onClose,
}: {
  outcome: LlmExportOutcome | null;
  error: string | null;
  modName: string;
  onClose: () => void;
}) {
  return (
    <div className="editor__backdrop" onMouseDown={onClose}>
      <div
        className="exportdlg"
        role="dialog"
        aria-label="LLM batch export"
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
              <div className="exportdlg__workflow">
                <strong>Continue in any LLM with file upload</strong>
                <ol>
                  <li>Open ChatGPT, Claude, Gemini, or another LLM.</li>
                  <li>
                    Attach the exported <code>*.llm-batch.json</code> file and
                    send this prompt:
                    <code className="exportdlg__prompt">{HANDOFF_PROMPT}</code>
                  </li>
                  <li>
                    Download the returned JSON file, then drop it onto the app
                    or click <strong>Import batch…</strong> in the toolbar.
                  </li>
                  <li>
                    Review the imported strings in the{" "}
                    <strong>Needs review</strong> queue.
                  </li>
                </ol>
              </div>
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
