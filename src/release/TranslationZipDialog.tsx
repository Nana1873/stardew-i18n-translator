import { useMemo, useRef, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { useDialogAccessibility } from "../dialogAccessibility";
import type { ZipPreview, ZipProblem } from "../tauri/commands";

function safeFileName(value: string): string {
  const safe = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[ .]+$/, "");
  return safe.toLowerCase().endsWith(".zip") ? safe : `${safe}.zip`;
}

export function TranslationZipDialog({
  preview,
  componentCount,
  error,
  building,
  onInspect,
  onReleaseNotes,
  onBuild,
  onClose,
}: {
  preview: ZipPreview | null;
  componentCount: number | null;
  error: string | null;
  building: boolean;
  onInspect: (problem: ZipProblem) => void;
  onReleaseNotes: (version: string, fileName: string) => void;
  onBuild: (version: string, fileName: string) => void;
  onClose: () => void;
}) {
  const [version, setVersion] = useState(preview?.selectedVersion ?? "");
  const [versionConfirmed, setVersionConfirmed] = useState(false);
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
  const hasVersionConflicts = Boolean(preview?.versionConflicts.length);
  const versionReady = !hasVersionConflicts || versionConfirmed;
  const dialogRef = useRef<HTMLElement>(null);
  const { onDialogKeyDown } = useDialogAccessibility({
    dialogRef,
    onEscape: onClose,
    escapeDisabled: building,
  });

  return (
    <div className="stv3-flow-overlay">
      <section
        ref={dialogRef}
        className="stv3-flow-dialog"
        role="dialog"
        aria-modal="true"
        aria-busy={building}
        aria-label="Build translation ZIP"
        onKeyDown={onDialogKeyDown}
      >
        <div className="stv3-flow-head">
          <div>
            <h2 className="stv3-heading">Build translation ZIP</h2>
            <div className="stv3-kicker">
              {preview
                ? `${preview.packageName} · ${
                    componentCount == null
                      ? "component count unavailable"
                      : componentCount === 1
                        ? "single mod"
                        : `package with ${componentCount} components`
                  }`
                : "Preparing package preview"}
            </div>
          </div>
          <button
            className="stv3-icon-button"
            type="button"
            aria-label="Close ZIP preview"
            onClick={onClose}
            disabled={building}
          >
            <X aria-hidden="true" />
          </button>
        </div>

        <div className="stv3-flow-body">
          {error && (
            <div className="stv3-flow-callout is-error" role="alert">
              <strong>Could not prepare ZIP:</strong> {error}
            </div>
          )}
          {!preview && !error && <p>Preparing current package data …</p>}
          {preview && (
            <>
              <div className="stv3-flow-fields">
                <label className="stv3-flow-field">
                  Package version
                  <input
                    value={version}
                    disabled={building}
                    onChange={(event) => {
                      setVersion(event.target.value);
                      setVersionConfirmed(false);
                    }}
                  />
                </label>
                <label className="stv3-flow-field">
                  Archive name
                  <input value={fileName} readOnly />
                </label>
              </div>

              <p className="stv3-kicker">
                Version selected from <strong>{preview.versionSource}</strong>.
                The native save dialog lets you edit the final filename.
              </p>

              {hasVersionConflicts && (
                <label className="stv3-flow-callout is-warning stv3-confirm-line">
                  <input
                    type="checkbox"
                    checked={versionConfirmed}
                    disabled={building}
                    onChange={(event) =>
                      setVersionConfirmed(event.target.checked)
                    }
                  />
                  <span>
                    Component versions differ:{" "}
                    {preview.versionConflicts
                      .map((item) => `${item.modName} ${item.version}`)
                      .join(", ")}
                    . I verified the advertised package version{" "}
                    {version.trim() || "above"}.
                  </span>
                </label>
              )}

              {preview.problems.length > 0 && (
                <>
                  <div className="stv3-flow-callout is-error" role="alert">
                    <strong>ZIP blocked:</strong> {preview.problems.length}{" "}
                    {preview.problems.length === 1
                      ? "problem must"
                      : "problems must"}{" "}
                    be fixed or explicitly accepted. No partial archive will be
                    written.
                  </div>
                  <ul
                    className="stv3-flow-list"
                    aria-label="Blocking ZIP problems"
                  >
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
                          disabled={building}
                        >
                          Open issue
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              <div>
                <strong>Included files</strong>
                {preview.entries.length > 0 ? (
                  <ul className="stv3-flow-list">
                    {preview.entries.map((entry) => (
                      <li key={entry.archivePath}>
                        <code>{entry.archivePath}</code>
                        <span>
                          {entry.strings} strings
                          {entry.outdated > 0
                            ? ` · ${entry.outdated} changed`
                            : ""}
                          {entry.reviewNeeded > 0
                            ? ` · ${entry.reviewNeeded} to review`
                            : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="stv3-flow-callout">
                    No translated files are ready to package.
                  </div>
                )}
              </div>

              {preview.omittedComponents.length > 0 && (
                <p className="stv3-kicker">
                  Omitted without translated output:{" "}
                  {preview.omittedComponents.join(", ")}.
                </p>
              )}

              {preview.warnings.length > 0 && (
                <div className="stv3-flow-callout is-warning">
                  <AlertTriangle aria-hidden="true" />
                  <ul>
                    {preview.warnings.map((warning, index) => (
                      <li key={`${warning}:${index}`}>{warning}</li>
                    ))}
                  </ul>
                </div>
              )}

              <p className="stv3-kicker">
                {preview.totalStrings} of {preview.totalSourceStrings} source
                strings will be included from the real package preview.
              </p>
            </>
          )}
        </div>

        <div className="stv3-flow-foot">
          <button
            className="stv3-button stv3-button-quiet"
            type="button"
            onClick={onClose}
            disabled={building}
          >
            Cancel
          </button>
          <button
            className="stv3-button stv3-button-quiet"
            type="button"
            disabled={!preview || building || !version.trim()}
            onClick={() => onReleaseNotes(version.trim(), fileName)}
          >
            Translation notes
          </button>
          <button
            className="stv3-button stv3-button-primary"
            type="button"
            disabled={
              !preview ||
              blocked ||
              empty ||
              building ||
              !version.trim() ||
              !versionReady
            }
            onClick={() => onBuild(version.trim(), fileName)}
          >
            {building ? "Building …" : "Choose save location …"}
          </button>
        </div>
      </section>
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
  const dialogRef = useRef<HTMLElement>(null);
  const { onDialogKeyDown } = useDialogAccessibility({
    dialogRef,
    onEscape: onCancel,
  });

  return (
    <div className="stv3-flow-overlay">
      <section
        ref={dialogRef}
        className="stv3-flow-dialog stv3-flow-dialog-compact"
        role="dialog"
        aria-modal="true"
        aria-label="Confirm ZIP overwrite"
        onKeyDown={onDialogKeyDown}
      >
        <div className="stv3-flow-head">
          <div>
            <h2 className="stv3-heading">Replace existing ZIP?</h2>
            <div className="stv3-kicker">Explicit overwrite confirmation</div>
          </div>
          <button
            className="stv3-icon-button"
            type="button"
            aria-label="Cancel ZIP overwrite"
            onClick={onCancel}
          >
            <X aria-hidden="true" />
          </button>
        </div>
        <div className="stv3-flow-body">
          <div className="stv3-result-path">
            <span>Existing archive</span>
            <code>{fileName}</code>
          </div>
          <div className="stv3-flow-callout is-warning">
            The existing archive is kept unless the replacement finishes
            successfully.
          </div>
        </div>
        <div className="stv3-flow-foot">
          <button
            className="stv3-button stv3-button-quiet"
            type="button"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className="stv3-button stv3-button-primary"
            type="button"
            onClick={onConfirm}
          >
            Replace ZIP
          </button>
        </div>
      </section>
    </div>
  );
}
