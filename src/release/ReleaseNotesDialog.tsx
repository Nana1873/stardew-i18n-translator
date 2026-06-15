import { useMemo, useState } from "react";
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
    <div className="editor__backdrop" onMouseDown={onClose}>
      <div
        className="exportdlg releasedlg"
        role="dialog"
        aria-label="Translation release notes"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="exportdlg__head">
          <strong>Translation release notes</strong>
          <span className="editor__crumbs">
            {preview?.packageName ?? "Preview"}
          </span>
        </div>
        <div className="exportdlg__body">
          {error && <p className="exportdlg__error">{error}</p>}
          {!preview && !error && <p>Preparing current package data...</p>}
          {preview && generated && (
            <>
              <div className="releasedlg__fields">
                <label>
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
                <label>
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
                <p className="zipdlg__notice" role="status">
                  No maintained template was available for{" "}
                  <code>{outputLanguage}</code>. The complete draft uses
                  English.
                </p>
              )}
              {hasConflicts && (
                <div className="releasedlg__conflict">
                  <strong>Component versions differ.</strong>
                  <span>
                    Selected from {preview.versionSource}:{" "}
                    {preview.selectedVersion}. Other versions:{" "}
                    {preview.versionConflicts
                      .map((item) => `${item.modName} ${item.version}`)
                      .join(", ")}
                    .
                  </span>
                  <label>
                    <input
                      type="checkbox"
                      checked={versionConfirmed}
                      onChange={(event) =>
                        setVersionConfirmed(event.target.checked)
                      }
                    />
                    I confirmed the advertised package version above.
                  </label>
                </div>
              )}
              {preview.problems.length > 0 && (
                <div className="releasedlg__problems">
                  <strong>
                    This package is not release-ready until these problems are
                    fixed:
                  </strong>
                  <ul>
                    {preview.problems.map((problem) => (
                      <li
                        key={`${problem.modUniqueId}:${problem.relativeDir}:${problem.key}`}
                      >
                        <button
                          type="button"
                          onClick={() => onInspect(problem)}
                        >
                          {problem.modName} <code>{problem.key}</code>
                        </button>
                        <span>{problem.reason}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <textarea
                className="releasedlg__preview"
                aria-label="Generated release notes"
                value={generated.text}
                readOnly
                spellCheck={false}
              />
              {copyState === "error" && (
                <p className="exportdlg__error" role="alert">
                  Could not access the clipboard.
                </p>
              )}
            </>
          )}
        </div>
        <div className="exportdlg__foot">
          <button
            type="button"
            className="exportdlg__secondary"
            onClick={onClose}
          >
            Close
          </button>
          <button
            type="button"
            disabled={copyDisabled}
            onClick={() => void copy()}
          >
            {copyState === "copied" ? "Copied" : "Copy to clipboard"}
          </button>
        </div>
      </div>
    </div>
  );
}
