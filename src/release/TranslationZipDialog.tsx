import { useMemo, useRef, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { useDialogAccessibility } from "../dialogAccessibility";
import type {
  ZipPreview,
  ZipProblem,
  ZipInstallFolder,
} from "../tauri/commands";

function safeFileName(value: string): string {
  const safe = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[ .]+$/, "");
  return safe.toLowerCase().endsWith(".zip") ? safe : `${safe}.zip`;
}

export function TranslationZipDialog({
  preview,
  combined = false,
  componentCount,
  error,
  building,
  onInspect,
  onBuild,
  onClose,
}: {
  preview: ZipPreview | null;
  combined?: boolean;
  componentCount: number | null;
  error: string | null;
  building: boolean;
  onInspect: (problem: ZipProblem) => void;
  onBuild: (fileName: string, installFolders: ZipInstallFolder[]) => void;
  onClose: () => void;
}) {
  const [version, setVersion] = useState(preview?.selectedVersion ?? "");
  const [versionConfirmed, setVersionConfirmed] = useState(false);
  const [folderEdits, setFolderEdits] = useState<Map<string, string>>(
    new Map(),
  );
  const components = Array.from(
    new Map(
      (preview?.entries ?? []).map((entry) => [entry.modUniqueId, entry]),
    ).values(),
  );
  const folderFor = (id: string, fallback: string) =>
    (folderEdits.get(id) ?? fallback).trim().replaceAll("\\", "/");
  const installFolders = components.map((entry) => ({
    modUniqueId: entry.modUniqueId,
    folder: folderFor(entry.modUniqueId, entry.installFolder),
  }));
  const invalidFolder = installFolders.some(({ folder }) =>
    folder
      .split("/")
      .some(
        (segment) =>
          !segment ||
          segment === "." ||
          segment === ".." ||
          /[<>:"|?*\u0000-\u001f]/.test(segment) ||
          /[ .]$/.test(segment) ||
          /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i.test(segment),
      ),
  );
  const duplicateFolder =
    new Set(installFolders.map((item) => item.folder.toLowerCase())).size !==
    installFolders.length;
  const folderError = invalidFolder
    ? "Use valid folder names relative to Mods, without absolute paths or '..'."
    : duplicateFolder
      ? "Several mods use the same installation folder. Choose distinct folders."
      : null;
  const fileName = useMemo(
    () =>
      preview
        ? combined
          ? preview.defaultFileName
          : safeFileName(
              `${preview.packageName} - ${version} - ${preview.targetLanguage} (${preview.targetLang}).zip`,
            )
        : "",
    [preview, version, combined],
  );
  const blocked = Boolean(preview?.problems.length) || Boolean(folderError);
  const empty = preview?.entries.length === 0;
  const hasVersionConflicts =
    !combined && Boolean(preview?.versionConflicts.length);
  const title = combined
    ? "Build translation ZIP · all mods"
    : "Build translation ZIP";
  const versionReady = !hasVersionConflicts || versionConfirmed;
  const dialogRef = useRef<HTMLElement>(null);
  const { onDialogKeyDown } = useDialogAccessibility({
    dialogRef,
    onEscape: onClose,
    escapeDisabled: building,
  });

  return (
    <div className="translator-flow-overlay">
      <section
        ref={dialogRef}
        className="translator-flow-dialog"
        role="dialog"
        aria-modal="true"
        aria-busy={building}
        aria-label={title}
        onKeyDown={onDialogKeyDown}
      >
        <div className="translator-flow-head">
          <div>
            <h2 className="translator-heading">{title}</h2>
            <div className="translator-kicker">
              {combined
                ? "Translations for all scanned mods"
                : preview
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
            className="translator-icon-button"
            type="button"
            aria-label="Close ZIP preview"
            onClick={onClose}
            disabled={building}
          >
            <X aria-hidden="true" />
          </button>
        </div>

        <div className="translator-flow-body">
          {error && (
            <div className="translator-flow-callout is-error" role="alert">
              <strong>Could not prepare ZIP:</strong> {error}
            </div>
          )}
          {!preview && !error && <p>Preparing current package data …</p>}
          {preview && (
            <>
              <div
                className="translator-preflight-metrics"
                aria-label="ZIP coverage and review"
              >
                <div className="translator-preflight-metric">
                  <strong>
                    {preview.totalStrings} / {preview.totalSourceStrings}
                  </strong>
                  <span>source strings included</span>
                </div>
                <div className="translator-preflight-metric">
                  <strong>
                    {preview.entries.reduce(
                      (sum, entry) => sum + entry.reviewNeeded,
                      0,
                    )}
                  </strong>
                  <span>in Review</span>
                </div>
                <div className="translator-preflight-metric">
                  <strong>
                    {preview.entries.reduce(
                      (sum, entry) => sum + entry.outdated,
                      0,
                    )}
                  </strong>
                  <span>Changed</span>
                </div>
              </div>
              <div className="translator-flow-fields">
                {!combined && (
                  <label className="translator-flow-field">
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
                )}
                <label className="translator-flow-field">
                  Archive name
                  <input value={fileName} readOnly />
                </label>
              </div>

              {!combined && (
                <p className="translator-kicker">
                  Version selected from <strong>{preview.versionSource}</strong>
                  . The native save dialog lets you edit the final filename.
                </p>
              )}

              {hasVersionConflicts && (
                <label className="translator-flow-callout is-warning translator-confirm-line">
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
                  <div
                    className="translator-flow-callout is-error"
                    role="alert"
                  >
                    <strong>ZIP blocked:</strong> {preview.problems.length}{" "}
                    {preview.problems.length === 1
                      ? "problem must"
                      : "problems must"}{" "}
                    be fixed or explicitly accepted. No partial archive will be
                    written.
                  </div>
                  <ul
                    className="translator-flow-list"
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
                          className="translator-button translator-button-quiet"
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

              <div className="translator-flow-fields">
                {components.map((entry) => (
                  <label
                    key={entry.modUniqueId}
                    className="translator-flow-field"
                  >
                    Install folder · {entry.modName}
                    <input
                      value={
                        folderEdits.get(entry.modUniqueId) ??
                        entry.installFolder
                      }
                      disabled={building}
                      onChange={(event) =>
                        setFolderEdits((current) =>
                          new Map(current).set(
                            entry.modUniqueId,
                            event.target.value,
                          ),
                        )
                      }
                    />
                  </label>
                ))}
              </div>
              {folderError && (
                <div className="translator-flow-callout is-error" role="alert">
                  {folderError}
                </div>
              )}

              <div>
                <strong>Installed files · paths relative to Mods</strong>
                {preview.entries.length > 0 ? (
                  <ul className="translator-flow-list">
                    {preview.entries.map((entry) => (
                      <li key={`${entry.modUniqueId}:${entry.archivePath}`}>
                        <code>
                          {folderFor(entry.modUniqueId, entry.installFolder)}/
                          {entry.archivePath.slice(
                            entry.installFolder.length + 1,
                          )}
                        </code>
                        <span>
                          {entry.strings}{" "}
                          {entry.strings === 1 ? "string" : "strings"}
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
                  <div className="translator-flow-callout">
                    No translated files are ready to package.
                  </div>
                )}
              </div>

              {preview.omittedComponents.length > 0 && (
                <p className="translator-kicker">
                  Omitted without translated output:{" "}
                  {preview.omittedComponents.join(", ")}.
                </p>
              )}

              {preview.warnings.length > 0 && (
                <div className="translator-flow-callout is-warning">
                  <AlertTriangle aria-hidden="true" />
                  <ul>
                    {preview.warnings.map((warning, index) => (
                      <li key={`${warning}:${index}`}>{warning}</li>
                    ))}
                  </ul>
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
            disabled={building}
          >
            Cancel
          </button>
          <button
            className="translator-button translator-button-primary"
            type="button"
            disabled={
              !preview ||
              blocked ||
              empty ||
              building ||
              (!combined && !version.trim()) ||
              !versionReady
            }
            onClick={() =>
              onBuild(
                fileName,
                installFolders.filter(
                  (item) =>
                    item.folder !==
                    components.find(
                      (entry) => entry.modUniqueId === item.modUniqueId,
                    )?.installFolder,
                ),
              )
            }
          >
            {building ? "Building …" : "Choose save location …"}
          </button>
        </div>
      </section>
    </div>
  );
}
