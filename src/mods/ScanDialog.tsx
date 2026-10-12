import { useEffect, useState } from "react";
import { type CSSProperties, useRef } from "react";
import { AlertTriangle, CheckCircle2, Info, RefreshCw, X } from "lucide-react";
import type {
  ExtraKeyDiagnostic,
  ScanResult,
  SkippedComponent,
} from "../tauri/commands";
import { useDialogAccessibility } from "../dialogAccessibility";

interface ScanDialogProps {
  scanning: boolean;
  result: ScanResult | null;
  error: string | null;
  focusDiagnostics?: boolean;
  retainedResult?: boolean;
  onOpenAddedStrings?: () => void;
  onReviewChangedSources?: () => void;
  onClose: () => void;
}

const completeProgress = {
  "--translator-batch-progress": "100%",
} as CSSProperties;

export function ScanDialog({
  scanning,
  result,
  error,
  focusDiagnostics = false,
  retainedResult = false,
  onOpenAddedStrings,
  onReviewChangedSources,
  onClose,
}: ScanDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const { onDialogKeyDown } = useDialogAccessibility({
    dialogRef,
    onEscape: onClose,
    escapeDisabled: scanning,
    initialFocusSelector: focusDiagnostics
      ? "[data-scan-diagnostics]"
      : undefined,
  });
  const complete = !scanning && !error && result != null;
  const warningCount = result?.warnings.length ?? 0;
  const skippedCount = result?.skippedComponents?.filter(
    (component) => component.requiresAttention,
  ).length;
  const expectedExclusionText = describeExpectedExclusions(
    result?.skippedComponents?.filter(
      (component) => !component.requiresAttention,
    ) ?? [],
  );
  const sourceDeltas = result?.sourceDeltas;
  const title = scanning
    ? "Scanning mods …"
    : error
      ? "Scan failed"
      : retainedResult
        ? "Latest scan"
        : result
          ? "Scan completed"
          : "Scan unavailable";

  return (
    <div className="translator-flow-overlay desktop-scan-overlay">
      <section
        ref={dialogRef}
        className="translator-flow-dialog translator-scan-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Scan"
        data-scanning={scanning}
        tabIndex={-1}
        onKeyDown={onDialogKeyDown}
      >
        <div className="translator-flow-head">
          <div>
            <h2 className="translator-heading">
              {complete && !retainedResult ? "Scan results" : title}
            </h2>
            <div className="translator-kicker">{"Mods folder (read-only)"}</div>
          </div>
          {!scanning && (
            <button
              className="translator-icon-button"
              type="button"
              aria-label="Close scan"
              onClick={onClose}
            >
              <X aria-hidden="true" />
            </button>
          )}
        </div>

        <div className="translator-flow-body">
          <div className="translator-progress-row">
            <span
              role="progressbar"
              aria-label="Scan progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={complete ? 100 : undefined}
              aria-valuetext={
                scanning
                  ? "Scanning; exact progress is unavailable"
                  : complete
                    ? "Scan completed"
                    : undefined
              }
              style={complete ? completeProgress : undefined}
            />
          </div>

          {scanning ? (
            <>
              <p>
                <RefreshCw aria-hidden="true" /> Reading manifests and i18n
                files …
              </p>
              <div className="translator-flow-callout">
                Exact scan progress is unavailable. Existing translation state
                remains untouched while the local folder is read.
              </div>
            </>
          ) : error ? (
            <div className="translator-flow-callout is-error" role="alert">
              <strong>Scan failed:</strong> {error}
            </div>
          ) : result ? (
            <ScanResultContent result={result} />
          ) : (
            <div className="translator-flow-callout">
              Scan result unavailable.
            </div>
          )}
        </div>

        <div className="translator-flow-foot">
          {!scanning &&
            !error &&
            Boolean(sourceDeltas?.stringsAdded && onOpenAddedStrings) && (
              <button
                className="translator-button translator-button-quiet"
                type="button"
                disabled={
                  scanning ||
                  !sourceDeltas ||
                  sourceDeltas.stringsAdded === 0 ||
                  !onOpenAddedStrings
                }
                title={
                  sourceDeltas
                    ? sourceDeltas.stringsAdded === 0
                      ? "No new strings were found in this scan"
                      : "Show exactly the strings added since the previous scan"
                    : "New-string deltas are unavailable in the current scan result"
                }
                onClick={onOpenAddedStrings}
              >
                {
                  <>
                    Show new strings (
                    {sourceDeltas?.stringsAdded ?? "Unavailable"})
                  </>
                }
              </button>
            )}
          {!scanning &&
            !error &&
            Boolean(sourceDeltas?.sourcesChanged && onReviewChangedSources) && (
              <button
                className={"translator-button translator-button-quiet"}
                type="button"
                disabled={
                  scanning ||
                  !sourceDeltas ||
                  sourceDeltas.sourcesChanged === 0 ||
                  !onReviewChangedSources
                }
                title={
                  sourceDeltas
                    ? sourceDeltas.sourcesChanged === 0
                      ? "No English strings changed in this scan"
                      : "Show exactly the English strings changed since the previous scan"
                    : "Changed-string details are unavailable in the current scan result"
                }
                onClick={onReviewChangedSources}
              >
                {
                  <>
                    Show changed strings (
                    {sourceDeltas?.sourcesChanged ?? "Unavailable"})
                  </>
                }
              </button>
            )}
          <button
            className="translator-button translator-button-quiet desktop-scan-close"
            type="button"
            disabled={scanning}
            onClick={onClose}
          >
            Close
          </button>
        </div>

        <span className="translator-sr-only" aria-live="polite">
          {scanning
            ? "Scan in progress"
            : error
              ? `Scan failed: ${error}`
              : result
                ? `Scan complete. ${result.modCount} ${result.modCount === 1 ? "mod" : "mods"} and ${result.fileCount} ${result.fileCount === 1 ? "i18n file" : "i18n files"} found. ${warningCount} scanner ${warningCount === 1 ? "warning" : "warnings"}; ${skippedCount == null ? "skipped-component count unavailable" : `${skippedCount} ${skippedCount === 1 ? "component" : "components"} skipped`}; ${expectedExclusionText.replace(/ (was|were) ignored$/, " ignored") || "nothing ignored"}.`
                : "Scan result unavailable"}
        </span>
      </section>
    </div>
  );
}

function ScanResultContent({ result }: { result: ScanResult }) {
  const warnings = result.warnings;
  const skipped = result.skippedComponents;
  const skippedForAttention =
    skipped?.filter((component) => component.requiresAttention) ?? [];
  const expectedExclusions =
    skipped?.filter((component) => !component.requiresAttention) ?? [];
  const extraKeys = result.extraKeys ?? [];
  const extraKeyGroups = groupExtraKeys(extraKeys);
  const problemCount = skippedForAttention.length + warnings.length;
  const extraKeySummary = `${extraKeys.length} ${extraKeys.length === 1 ? "translation entry" : "translation entries"} without matching English source`;
  const mods = `${result.modCount} ${result.modCount === 1 ? "mod" : "mods"}`;
  const files = `${result.fileCount} ${result.fileCount === 1 ? "translation file" : "translation files"}`;

  return (
    <>
      <p
        className={`translator-scan-summary${problemCount > 0 ? " is-warning" : " is-success"}`}
      >
        {problemCount > 0 ? (
          <AlertTriangle aria-hidden="true" />
        ) : (
          <CheckCircle2 aria-hidden="true" />
        )}{" "}
        {problemCount > 0
          ? `Read ${mods} with ${files}. ${problemCount} ${problemCount === 1 ? "item needs" : "items need"} a look; your saved work is safe.`
          : `Read ${mods} with ${files}. Everything is ready.`}
      </p>
      <p
        className="translator-scan-changes"
        aria-label="Changes since the last scan"
      >
        {describeSourceChanges(result.sourceDeltas)}
      </p>

      {problemCount > 0 && (
        <section
          className="translator-flow-callout translator-scan-diagnostics is-warning"
          tabIndex={-1}
          data-scan-diagnostics
        >
          <ul className="translator-flow-list" aria-label="Skipped components">
            {skippedForAttention.map((component, index) => (
              <li
                key={`${component.relativeLocation}:${component.componentUniqueId ?? index}`}
              >
                <span>
                  <strong>
                    {component.componentName ??
                      component.componentUniqueId ??
                      component.packageId ??
                      "Unnamed component"}
                  </strong>{" "}
                  {plainSkipReason(component.reason)}
                  {component.restOfPackageLoaded &&
                    " The rest of this mod was loaded."}
                  <details className="translator-scan-details">
                    <summary>Details</summary>
                    <code>{component.relativeLocation}</code>
                    <span>{component.reason}</span>
                  </details>
                </span>
              </li>
            ))}
          </ul>
          {warnings.length > 0 && (
            <ul className="translator-flow-list" aria-label="Scan warnings">
              {warnings.map((warning, index) => (
                <li key={`${warning}:${index}`}>
                  <span>{warning}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {expectedExclusions.length > 0 && (
        <details className="translator-scan-extra-info translator-scan-info-section">
          <summary>
            <Info aria-hidden="true" />{" "}
            {describeExpectedExclusions(expectedExclusions)} (expected, no
            action needed)
          </summary>
          <ul
            className="translator-flow-list"
            aria-label="Expected scan exclusions"
          >
            {expectedExclusions.map((component, index) => (
              <li
                key={`${component.relativeLocation}:${component.componentUniqueId ?? index}`}
              >
                <span>
                  <strong>
                    {component.componentName ??
                      component.componentUniqueId ??
                      component.packageId ??
                      component.relativeLocation}
                  </strong>{" "}
                  {component.reason}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {extraKeys.length > 0 && (
        <details className="translator-scan-extra-info">
          <summary>
            <Info aria-hidden="true" /> {extraKeySummary}
          </summary>
          <p>
            These entries are in the translation file but not in the local
            English source (default.json or default/*.json). They do not count
            toward progress or block export. Exports omit these entries. Folder
            exports retain the original file in a backup; ZIP exports leave the
            original files unchanged.
          </p>
          <ul
            className="translator-scan-extra-groups"
            aria-label="Translation entries without matching English source"
          >
            {extraKeyGroups.map((group) => (
              <li key={`${group.modName}:${group.targetPath}`}>
                <strong>{group.modName}</strong>
                <details>
                  <summary>
                    <code>{group.displayPath}</code>
                    <span>
                      {group.keys.length}{" "}
                      {group.keys.length === 1 ? "entry" : "entries"}
                    </span>
                  </summary>
                  <p className="translator-scan-extra-path">
                    Translation file: <code>{group.targetPath}</code>
                  </p>
                  <ul aria-label={`${group.displayPath} unmatched entries`}>
                    {group.keys.map((key) => (
                      <li key={key}>
                        <code>{key}</code>
                        <span>Not found in English source</span>
                      </li>
                    ))}
                  </ul>
                </details>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

interface ExtraKeyGroup {
  modName: string;
  targetPath: string;
  displayPath: string;
  keys: string[];
}

function groupExtraKeys(diagnostics: ExtraKeyDiagnostic[]): ExtraKeyGroup[] {
  const groups = new Map<string, ExtraKeyGroup>();
  for (const diagnostic of diagnostics) {
    const groupKey = `${diagnostic.modName}\u0000${diagnostic.targetPath}`;
    const existing = groups.get(groupKey);
    if (existing) {
      existing.keys.push(diagnostic.key);
      continue;
    }
    const parts = diagnostic.targetPath.split(/[\\/]/);
    const fileName = parts[parts.length - 1] || diagnostic.targetPath;
    const relativeDir = diagnostic.relativeDir.replace(/[\\/]+$/, "");
    groups.set(groupKey, {
      modName: diagnostic.modName,
      targetPath: diagnostic.targetPath,
      displayPath: relativeDir ? `${relativeDir}/${fileName}` : fileName,
      keys: [diagnostic.key],
    });
  }
  return [...groups.values()];
}

/** Expected exclusions are community language packs (they belong to a
 * package) or `i18n` folders SMAPI does not load: without a manifest, or
 * deeper inside a mod than the folder beside its manifest. */
function describeExpectedExclusions(components: SkippedComponent[]): string {
  if (components.length === 0) return "";
  const folders = components.filter(
    (component) => !component.packageId && !component.componentUniqueId,
  ).length;
  const packs = components.length - folders;
  const parts = [
    packs > 0
      ? `${packs} community language ${packs === 1 ? "pack" : "packs"}`
      : "",
    folders > 0
      ? `${folders} i18n ${folders === 1 ? "folder" : "folders"} that SMAPI does not load`
      : "",
  ].filter(Boolean);
  return `${parts.join(" and ")} ${components.length === 1 ? "was" : "were"} ignored`;
}

/** One sentence about English source changes since the previous scan. */
function describeSourceChanges(deltas: ScanResult["sourceDeltas"]): string {
  if (!deltas)
    return "Changes since the last scan could not be compared this time.";
  const parts = [
    deltas.sourcesChanged > 0 ? `${deltas.sourcesChanged} changed` : "",
    deltas.stringsAdded > 0 ? `${deltas.stringsAdded} new` : "",
    deltas.stringsRemoved > 0 ? `${deltas.stringsRemoved} removed` : "",
  ].filter(Boolean);
  return parts.length === 0
    ? "No English text changed since the last scan."
    : `English text since the last scan: ${parts.join(", ")}.`;
}

/** A short, plain explanation of a skip; the technical reason stays under
 * Details for bug reports to the mod author. */
function plainSkipReason(reason: string): string {
  if (/duplicate.*uniqueid/i.test(reason))
    return "Two mods use the same ID, so their translations were left out. Remove the extra copy.";
  if (/translation state is unavailable/i.test(reason))
    return "Its saved translations could not be loaded safely, so it was left out.";
  if (/manifest/i.test(reason))
    return "Its manifest.json could not be read, so it was left out.";
  if (/outside the configured mods folder/i.test(reason))
    return "It points outside the Mods folder and was left out for safety.";
  if (
    /invalid json|expected .* at line|could not read|non-string value/i.test(
      reason,
    )
  )
    return "A translation file in this mod is damaged and was left out.";
  return "Part of this mod could not be read and was left out.";
}
