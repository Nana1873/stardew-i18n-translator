import { useMemo, useRef, useState } from "react";
import { Copy, CopyCheck, X } from "lucide-react";
import { useDialogAccessibility } from "../dialogAccessibility";
import type { ZipPreview, ZipProblem } from "../tauri/commands";
import { generateReleaseNotes } from "./releaseNotes";

export function ReleaseNotesDialog({
  preview,
  error,
  initialVersion,
  archiveFileName,
  onInspect,
  onClose,
}: {
  preview: ZipPreview | null;
  error: string | null;
  initialVersion: string;
  archiveFileName: string | null;
  onInspect: (problem: ZipProblem) => void;
  onClose: () => void;
}) {
  const [version, setVersion] = useState(initialVersion);
  const [outputLanguage, setOutputLanguage] = useState(
    preview?.targetLang ?? "en",
  );
  const [versionConfirmed, setVersionConfirmed] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle",
  );
  const generated = useMemo(
    () =>
      preview
        ? generateReleaseNotes(
            preview,
            version.trim(),
            archiveFileName,
            outputLanguage,
          )
        : null,
    [archiveFileName, outputLanguage, preview, version],
  );
  const hasConflicts = Boolean(preview?.versionConflicts.length);
  const copyDisabled =
    !generated || !version.trim() || (hasConflicts && !versionConfirmed);
  const dialogRef = useRef<HTMLElement>(null);
  const { onDialogKeyDown } = useDialogAccessibility({
    dialogRef,
    onEscape: onClose,
  });

  async function copy() {
    if (!generated || copyDisabled) return;
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard access is unavailable.");
      }
      await navigator.clipboard.writeText(generated.text);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  }

  return (
    <div className="stv3-flow-overlay">
      <section
        ref={dialogRef}
        className="stv3-flow-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Translation notes"
        onKeyDown={onDialogKeyDown}
      >
        <div className="stv3-flow-head">
          <div>
            <h2 className="stv3-heading">Translation notes</h2>
            <div className="stv3-kicker">
              Copy-ready draft generated from the current package data
            </div>
          </div>
          <button
            className="stv3-icon-button"
            type="button"
            aria-label="Close translation notes"
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </button>
        </div>

        <div className="stv3-flow-body">
          {error && (
            <div className="stv3-flow-callout is-error" role="alert">
              <strong>Could not generate notes:</strong> {error}
            </div>
          )}
          {!preview && !error && <p>Preparing current package data …</p>}
          {preview && generated && (
            <>
              <div className="stv3-flow-fields">
                <label className="stv3-flow-field">
                  Advertised package version
                  <input
                    value={version}
                    onChange={(event) => {
                      setVersion(event.target.value);
                      setVersionConfirmed(false);
                      setCopyState("idle");
                    }}
                  />
                </label>
                <label className="stv3-flow-field">
                  Draft language
                  <select
                    value={outputLanguage}
                    onChange={(event) => {
                      setOutputLanguage(event.target.value);
                      setCopyState("idle");
                    }}
                  >
                    <option value={preview.targetLang}>
                      {preview.targetLanguage} ({preview.targetLang})
                    </option>
                    <option value="en">English</option>
                  </select>
                </label>
              </div>

              {generated.fellBackToEnglish && (
                <div className="stv3-flow-callout is-warning" role="status">
                  No maintained template was available for{" "}
                  <code>{outputLanguage}</code>. The complete draft uses
                  English.
                </div>
              )}

              {hasConflicts && (
                <label className="stv3-flow-callout is-warning stv3-confirm-line">
                  <input
                    type="checkbox"
                    checked={versionConfirmed}
                    onChange={(event) =>
                      setVersionConfirmed(event.target.checked)
                    }
                  />
                  <span>
                    Component versions differ:{" "}
                    {preview.versionConflicts
                      .map((item) => `${item.modName} ${item.version}`)
                      .join(", ")}
                    . I confirmed the advertised package version{" "}
                    {version || "above"}.
                  </span>
                </label>
              )}

              {preview.problems.length > 0 && (
                <>
                  <div className="stv3-flow-callout is-error">
                    <strong>
                      This package is not release-ready until these problems are
                      fixed:
                    </strong>
                  </div>
                  <ul className="stv3-flow-list">
                    {preview.problems.map((problem) => (
                      <li
                        key={`${problem.modUniqueId}:${problem.relativeDir}:${problem.key}`}
                      >
                        <span>
                          <strong>{problem.modName}</strong>
                          <br />
                          <code>{problem.key}</code> · {problem.reason}
                        </span>
                        <button
                          className="stv3-button stv3-button-quiet"
                          type="button"
                          onClick={() => onInspect(problem)}
                        >
                          Open issue
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              <label className="stv3-flow-field">
                Generated notes
                <textarea
                  aria-label="Generated release notes"
                  value={generated.text}
                  readOnly
                  spellCheck={false}
                />
              </label>

              {copyState === "error" && (
                <div className="stv3-flow-callout is-error" role="alert">
                  Could not access the clipboard.
                </div>
              )}
            </>
          )}
        </div>

        <div className="stv3-flow-foot">
          <button
            className="stv3-button stv3-button-quiet"
            type="button"
            onClick={onClose}
          >
            Close
          </button>
          <button
            className="stv3-button stv3-button-primary"
            type="button"
            disabled={copyDisabled}
            onClick={() => void copy()}
          >
            {copyState === "copied" ? (
              <CopyCheck aria-hidden="true" />
            ) : (
              <Copy aria-hidden="true" />
            )}
            {copyState === "copied" ? "Copied" : "Copy to clipboard"}
          </button>
        </div>
      </section>
    </div>
  );
}
