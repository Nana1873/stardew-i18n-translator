import { useMemo, useRef, useState, type ReactNode } from "react";
import { ZipSummary, ZipSourcePath, remainingZipWarnings } from "./ZipDetails";
import { AlertTriangle } from "lucide-react";
import {
  ExportDialogHead,
  ExportSection,
  LeftOutStrings,
} from "../export/ExportOverview";
import { useDialogAccessibility } from "../dialogAccessibility";
import {
  EXPORT_CHOOSER_FOCUS,
  useStickyExportHeight,
} from "../export/ExportChooser";
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
  untranslated = null,
  modFolders = [],
  modsPath,
  error,
  building,
  onInspect,
  onBuild,
  onClose,
  chooser,
  switching = false,
  subject,
  targetLanguage,
}: {
  preview: ZipPreview | null;
  combined?: boolean;
  /** Strings with no translation yet, counted like the JSON export. */
  untranslated?: number | null;
  modFolders?: ReadonlyArray<{ uniqueId: string; folderPath: string }>;
  modsPath?: string;
  error: string | null;
  building: boolean;
  onInspect: (problem: ZipProblem) => void;
  onBuild: (fileName: string, installFolders: ZipInstallFolder[]) => void;
  onClose: () => void;
  /** The Export… choice shown above the preview. */
  chooser?: ReactNode;
  /** True while another Export… choice loads: this preview is stale and
   * its actions wait. */
  switching?: boolean;
  /** Subtitle before the preview is ready. */
  subject?: string;
  /** "German (de)"; shown before the preview is ready. */
  targetLanguage?: string;
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
  // Strings with token errors are left out of the ZIP (English in game); they
  // never block building the rest.
  const blocked = Boolean(folderError);
  const empty = preview?.entries.length === 0;
  const hasVersionConflicts =
    !combined && Boolean(preview?.versionConflicts.length);
  const versionReady = !hasVersionConflicts || versionConfirmed;
  // Building, or a stale preview while another Export… choice loads.
  const locked = building || switching;

  const zipName = combined
    ? preview
      ? `${components.length} ${components.length === 1 ? "mod" : "mods"}`
      : (subject ?? "All mods")
    : (components[0]?.modName ?? preview?.packageName ?? subject);
  const language = preview
    ? `${preview.targetLanguage} (${preview.targetLang})`
    : targetLanguage;
  const displayedZipWarnings = remainingZipWarnings(preview);
  const dialogRef = useRef<HTMLElement>(null);
  useStickyExportHeight(dialogRef, Boolean(chooser));
  const { onDialogKeyDown } = useDialogAccessibility({
    dialogRef,
    onEscape: onClose,
    escapeDisabled: building,
    initialFocusSelector: chooser ? EXPORT_CHOOSER_FOCUS : undefined,
  });
  // Settings open by themselves only when something there needs attention.
  const settingsNeedAttention =
    hasVersionConflicts || Boolean(folderError) || (!combined && !version);

  return (
    <div className="translator-flow-overlay">
      <section
        ref={dialogRef}
        className="translator-flow-dialog desktop-xd"
        role="dialog"
        aria-modal="true"
        aria-busy={building}
        aria-labelledby="translator-zip-title"
        tabIndex={-1}
        onKeyDown={onDialogKeyDown}
      >
        <ExportDialogHead
          titleId="translator-zip-title"
          subject={zipName ?? "Preparing ZIP"}
          language={language}
          closeLabel="Close ZIP preview"
          closeDisabled={building}
          onClose={onClose}
        />
        {chooser}

        <div className="desktop-xd-body" aria-busy={switching || undefined}>
          {error && (
            <div className="desktop-xd-alert is-error" role="alert">
              <strong>Could not prepare ZIP:</strong> {error}
            </div>
          )}
          {!preview && !error && (
            <p className="desktop-xd-loading">Preparing the package…</p>
          )}
          {preview && (
            <>
              <ZipSummary
                preview={preview}
                untranslated={untranslated}
                leftOut={preview.problems.length}
              />
              <LeftOutStrings
                problems={preview.problems}
                target="ZIP"
                showModNames={combined}
                onInspect={onInspect}
                disabled={locked}
              />

              {hasVersionConflicts && (
                <label className="desktop-xd-alert is-warning desktop-xd-confirm">
                  <input
                    type="checkbox"
                    checked={versionConfirmed}
                    disabled={locked}
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
              {folderError && (
                <div className="desktop-xd-alert is-error" role="alert">
                  {folderError}
                </div>
              )}
              {displayedZipWarnings.length > 0 && (
                <div className="desktop-xd-alert is-warning">
                  <AlertTriangle aria-hidden="true" />
                  {displayedZipWarnings.length === 1 ? (
                    <p>{displayedZipWarnings[0]}</p>
                  ) : (
                    <ul>
                      {displayedZipWarnings.map((warning, index) => (
                        <li key={`${warning}:${index}`}>{warning}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {(preview.regionalFileHints?.length ?? 0) > 0 && (
                <div className="desktop-xd-alert is-info">
                  {preview.regionalFileHints?.map((hint) => (
                    <p key={hint}>{hint}</p>
                  ))}
                </div>
              )}

              <div className="desktop-xd-sections">
                <ExportSection
                  title="ZIP settings"
                  summary={fileName}
                  openWhen={settingsNeedAttention}
                >
                  <div className="desktop-xd-rows">
                    {!combined && (
                      <label className="desktop-xd-row">
                        <span>Version</span>
                        <input
                          value={version}
                          disabled={locked}
                          onChange={(event) => {
                            setVersion(event.target.value);
                            setVersionConfirmed(false);
                          }}
                        />
                      </label>
                    )}
                    <div className="desktop-xd-row">
                      <span>ZIP file</span>
                      <output title={fileName} aria-label="ZIP file">
                        {fileName}
                      </output>
                    </div>
                    {components.map((entry) => (
                      <div key={entry.modUniqueId} className="desktop-xd-row">
                        <label
                          htmlFor={`zip-folder-${entry.modUniqueId}`}
                          title={entry.modName}
                        >
                          {components.length === 1
                            ? "Install folder"
                            : entry.modName}
                        </label>
                        <div>
                          <input
                            id={`zip-folder-${entry.modUniqueId}`}
                            aria-describedby={`zip-source-${entry.modUniqueId}`}
                            value={
                              folderEdits.get(entry.modUniqueId) ??
                              entry.installFolder
                            }
                            disabled={locked}
                            onChange={(event) =>
                              setFolderEdits((current) =>
                                new Map(current).set(
                                  entry.modUniqueId,
                                  event.target.value,
                                ),
                              )
                            }
                          />
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
                      </div>
                    ))}
                  </div>
                </ExportSection>

                <ExportSection
                  title="Details"
                  summary={`${preview.entries.length} ${preview.entries.length === 1 ? "file" : "files"}`}
                >
                  <div className="desktop-xd-details">
                    <strong>Files after installation (relative to Mods)</strong>
                    {preview.entries.length > 0 ? (
                      <ul>
                        {preview.entries.map((entry) => (
                          <li key={`${entry.modUniqueId}:${entry.archivePath}`}>
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
                      <p>No translated files are ready to package.</p>
                    )}
                    {!combined && <p>Version from {preview.versionSource}.</p>}
                    {preview.omittedComponents.length > 0 && (
                      <p>
                        Omitted without translated output:{" "}
                        {preview.omittedComponents.join(", ")}.
                      </p>
                    )}
                  </div>
                </ExportSection>
              </div>
            </>
          )}
        </div>

        <div className="desktop-xd-foot">
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
              locked ||
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
            {building ? "Exporting…" : switching ? "Checking…" : "Save ZIP…"}
          </button>
        </div>
      </section>
    </div>
  );
}
