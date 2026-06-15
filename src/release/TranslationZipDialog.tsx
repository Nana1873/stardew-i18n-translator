import { useEffect, useMemo, useState } from "react";
import type { ZipPreview, ZipProblem } from "../tauri/commands";

function safeFileName(value: string): string {
  const safe = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[ .]+$/, "");
  return safe.toLowerCase().endsWith(".zip") ? safe : `${safe}.zip`;
}

export function TranslationZipDialog({
  preview,
  error,
  building,
  onInspect,
  onBuild,
  onClose,
}: {
  preview: ZipPreview | null;
  error: string | null;
  building: boolean;
  onInspect: (problem: ZipProblem) => void;
  onBuild: (fileName: string) => void;
  onClose: () => void;
}) {
  const [version, setVersion] = useState(preview?.selectedVersion ?? "");
  useEffect(() => {
    if (preview) setVersion(preview.selectedVersion);
  }, [preview]);
  const fileName = useMemo(
    () =>
      preview
        ? safeFileName(
            `${preview.packageName} - ${version} - ${preview.targetLanguage} (${preview.targetLang}).zip`,
          )
        : "",
    [preview, version],
  );
  const blocked = Boolean(preview?.problems.length);
  const empty = preview?.entries.length === 0;

  return (
    <div className="editor__backdrop" onMouseDown={onClose}>
      <div
        className="exportdlg zipdlg"
        role="dialog"
        aria-label="Build translation ZIP"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="exportdlg__head">
          <strong>Build translation ZIP</strong>
          <span className="editor__crumbs">
            {preview?.packageName ?? "Preview"}
          </span>
        </div>
        <div className="exportdlg__body">
          {error && <p className="exportdlg__error">{error}</p>}
          {!preview && !error && <p>Preparing package preview...</p>}
          {preview && (
            <>
              <div className="zipdlg__fields">
                <label>
                  Package version
                  <input
                    value={version}
                    onChange={(event) => setVersion(event.target.value)}
                  />
                </label>
                <label>
                  Archive name
                  <input value={fileName} readOnly />
                </label>
              </div>
              <p className="exportdlg__muted">
                Version selected from <strong>{preview.versionSource}</strong>.
                The save dialog lets you edit the final filename.
              </p>
              {preview.versionConflicts.length > 0 && (
                <div className="zipdlg__notice">
                  Component versions differ:{" "}
                  {preview.versionConflicts
                    .map((item) => `${item.modName} ${item.version}`)
                    .join(", ")}
                </div>
              )}
              <h3>Included files</h3>
              {preview.entries.length > 0 ? (
                <ul className="zipdlg__entries">
                  {preview.entries.map((entry) => (
                    <li key={entry.archivePath}>
                      <code>{entry.archivePath}</code>
                      <span>
                        {entry.strings} strings
                        {entry.outdated > 0
                          ? `, ${entry.outdated} outdated`
                          : ""}
                        {entry.reviewNeeded > 0
                          ? `, ${entry.reviewNeeded} need review`
                          : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="exportdlg__muted">
                  No translated files are ready to package.
                </p>
              )}
              {preview.omittedComponents.length > 0 && (
                <p className="exportdlg__muted">
                  Omitted without translated output:{" "}
                  {preview.omittedComponents.join(", ")}
                </p>
              )}
              {preview.warnings.length > 0 && (
                <ul className="zipdlg__warnings">
                  {preview.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              )}
              {preview.problems.length > 0 && (
                <>
                  <h3>Blocking problems</h3>
                  <ul className="zipdlg__problems">
                    {preview.problems.map((problem) => (
                      <li
                        key={`${problem.modUniqueId}:${problem.relativeDir}:${problem.key}`}
                      >
                        <button
                          type="button"
                          onClick={() => onInspect(problem)}
                        >
                          <strong>{problem.modName}</strong>{" "}
                          <code>{problem.key}</code>
                        </button>
                        <span>{problem.reason}</span>
                      </li>
                    ))}
                  </ul>
                </>
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
            Cancel
          </button>
          <button
            type="button"
            disabled={
              !preview || blocked || empty || building || !version.trim()
            }
            onClick={() => onBuild(fileName)}
          >
            {building ? "Building..." : "Choose location..."}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ZipOverwriteDialog({
  fileName,
  onConfirm,
  onCancel,
}: {
  fileName: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="editor__backdrop" onMouseDown={onCancel}>
      <div
        className="exportdlg"
        role="dialog"
        aria-label="Confirm ZIP overwrite"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="exportdlg__head">
          <strong>Replace existing ZIP?</strong>
        </div>
        <div className="exportdlg__body">
          <p>
            <code>{fileName}</code> already exists.
          </p>
          <p className="exportdlg__muted">
            The existing archive is kept unless the replacement finishes
            successfully.
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
            Replace ZIP
          </button>
        </div>
      </div>
    </div>
  );
}
