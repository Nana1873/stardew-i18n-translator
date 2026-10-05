import { useEffect } from "react";
import { ZipSummary, ZipSourcePath, remainingZipWarnings } from "./ZipDetails";
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
  modFolders = [],
  modsPath,
  error,
  building,
  onInspect,
  onBuild,
  onClose,
}: {
  preview: ZipPreview | null;
  combined?: boolean;
  componentCount: number | null;
  modFolders?: ReadonlyArray<{ uniqueId: string; folderPath: string }>;
  modsPath?: string;
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
    (folderEdits.get(id) ?? fallback).replaceAll("\\", "/");
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
  const title = "Export translation ZIP";
  const versionReady = !hasVersionConflicts || versionConfirmed;

  const zipName = combined
    ? "All mods"
    : (components[0]?.modName ?? preview?.packageName);
  const displayedZipWarnings = remainingZipWarnings(preview);
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
        className={"translator-flow-dialog desktop-zip-dialog"}
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
              {
                <>
                  <span>{zipName ?? "Preparing ZIP"}</span>
                  {preview && (
                    <span className="desktop-zip-language">
                      {preview.targetLanguage} ({preview.targetLang})
                    </span>
                  )}
                </>
              }
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
              {<ZipSummary preview={preview} />}
              <div className="translator-flow-fields">
                {!combined && (
                  <label className="translator-flow-field">
                    {"Version"}
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
                {
                  <div className="translator-flow-field desktop-zip-filename">
                    <span>ZIP file</span>
                    <output title={fileName} aria-label="ZIP file">
                      {fileName}
                    </output>
                  </div>
                }
              </div>

              {false}

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

              {
                <div className="translator-flow-fields">
                  {components.map((entry) => (
                    <div key={entry.modUniqueId} className="desktop-zip-folder">
                      <label className="translator-flow-field">
                        {components.length === 1
                          ? "Install folder"
                          : entry.modName}
                        <input
                          aria-describedby={`zip-source-${entry.modUniqueId}`}
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
                      <ZipSourcePath
                        descriptionId={`zip-source-${entry.modUniqueId}`}
                        path={
                          modFolders.find(
                            (mod) => mod.uniqueId === entry.modUniqueId,
                          )?.folderPath
                        }
                        modsPath={modsPath}
                        installFolder={entry.installFolder}
                      />
                    </div>
                  ))}
                </div>
              }
              {folderError && (
                <div className="translator-flow-callout is-error" role="alert">
                  {folderError}
                </div>
              )}

              {
                <details className="desktop-zip-details">
                  <summary>
                    Details{" "}
                    <span>
                      {preview.entries.length}{" "}
                      {preview.entries.length === 1 ? "file" : "files"}
                    </span>
                  </summary>
                  <div className="desktop-zip-files">
                    <div>
                      <strong>
                        Files after installation (relative to Mods)
                      </strong>
                      {preview.entries.length > 0 ? (
                        <ul className="translator-flow-list">
                          {preview.entries.map((entry) => (
                            <li
                              key={`${entry.modUniqueId}:${entry.archivePath}`}
                            >
                              <code>
                                {folderFor(
                                  entry.modUniqueId,
                                  entry.installFolder,
                                )}
                                /
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
                    {!combined && (
                      <p className="translator-kicker">
                        Version from {preview.versionSource}.
                      </p>
                    )}
                  </div>
                </details>
              }

              {preview.omittedComponents.length > 0 && (
                <p className="translator-kicker">
                  Omitted without translated output:{" "}
                  {preview.omittedComponents.join(", ")}.
                </p>
              )}

              {displayedZipWarnings.length > 0 && (
                <div className="translator-flow-callout is-warning">
                  <AlertTriangle aria-hidden="true" />
                  <ul>
                    {displayedZipWarnings.map((warning, index) => (
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
            {building ? "Exporting…" : "Save ZIP…"}
          </button>
        </div>
      </section>
    </div>
  );
}
