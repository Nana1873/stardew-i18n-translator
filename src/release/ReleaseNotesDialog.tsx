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
    <div className="translator-flow-overlay">
      <section
        ref={dialogRef}
        className="translator-flow-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Translation notes"
        onKeyDown={onDialogKeyDown}
      >
        <div className="translator-flow-head">
          <div>
            <h2 className="translator-heading">Translation notes</h2>
            <div className="translator-kicker">
              Copy-ready draft generated from the current package data
            </div>
          </div>
          <button
            className="translator-icon-button"
            type="button"
            aria-label="Close translation notes"
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </button>
        </div>

        <div className="translator-flow-body">
          {error && (
            <div className="translator-flow-callout is-error" role="alert">
              <strong>Could not generate notes:</strong> {error}
            </div>
          )}
          {!preview && !error && <p>Preparing current package data …</p>}
          {preview && generated && (
            <>
              <div className="translator-flow-fields">
                <label className="translator-flow-field">
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
                <label className="translator-flow-field">
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
                <div
                  className="translator-flow-callout is-warning"
                  role="status"
                >
                  No maintained template was available for{" "}
                  <code>{outputLanguage}</code>. The complete draft uses
                  English.
                </div>
              )}

              {hasConflicts && (
                <label className="translator-flow-callout is-warning translator-confirm-line">
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
                  <div className="translator-flow-callout is-error">
                    <strong>
                      This package is not release-ready until these problems are
                      fixed:
                    </strong>
                  </div>
                  <ul className="translator-flow-list">
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
                          className="translator-button translator-button-quiet"
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

              <label className="translator-flow-field">
                Generated notes
                <textarea
                  aria-label="Generated release notes"
                  value={generated.text}
                  readOnly
                  spellCheck={false}
                />
              </label>

              {copyState === "error" && (
                <div className="translator-flow-callout is-error" role="alert">
                  Could not access the clipboard.
                </div>
              )}
            </>
          )}
        </div>

        <div className="translator-flow-foot">
          <button
            className="translator-button translator-button-quiet"
            type="button"
            onClick={onClose}
          >
            Close
          </button>
          <button
            className="translator-button translator-button-primary"
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
