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
  const duplicates = groupDuplicateIds(warnings, skippedForAttention);
  const otherSkips = skippedForAttention.filter(
    (component) => !duplicates.grouped.has(component),
  );
  const problemCount = otherSkips.length + warnings.length;
  const extraKeySummary = `${extraKeys.length} ${extraKeys.length === 1 ? "translation entry" : "translation entries"} without matching English source`;
  const mods = `${result.modCount} ${result.modCount === 1 ? "mod" : "mods"}`;
  const files = `${result.fileCount} ${result.fileCount === 1 ? "translation file" : "translation files"}`;
  const changeLine = describeSourceChanges(result.sourceDeltas);

  return (
    <>
      <div
        className={`translator-scan-status ${problemCount > 0 ? "is-attention" : "is-ready"}`}
        role="group"
        aria-label="Latest scan result"
      >
        <span className="translator-scan-status-icon" aria-hidden="true">
          {problemCount > 0 ? <AlertTriangle /> : <CheckCircle2 />}
        </span>
        <div>
          <strong>
            {problemCount > 0
              ? `${problemCount} ${problemCount === 1 ? "item needs" : "items need"} a look`
              : "Everything is ready"}
          </strong>
          <span>
            {`Read ${mods} with ${files}.`}
            {problemCount > 0 && " Your saved work is safe."}
          </span>
          <span
            className={`translator-scan-changes${changeLine.highlight ? " has-changes" : ""}`}
          >
            <RefreshCw aria-hidden="true" />
            {changeLine.text}
          </span>
        </div>
      </div>

      {problemCount > 0 && (
        <section
          className="translator-scan-attention is-warning"
          tabIndex={-1}
          data-scan-diagnostics
          aria-labelledby="scan-attention-title"
        >
          <h3
            id="scan-attention-title"
            className="translator-scan-section-title"
          >
            Needs attention <span>{problemCount}</span>
          </h3>
          <ul className="translator-scan-cards" aria-label="Skipped components">
            {otherSkips.map((component, index) => (
              <li
                className="translator-scan-card"
                key={`${component.relativeLocation}:${component.componentUniqueId ?? index}`}
              >
                <AlertTriangle aria-hidden="true" />
                <div>
                  <strong>
                    {component.componentName ??
                      component.componentUniqueId ??
                      component.packageId ??
                      "Unnamed component"}
                  </strong>
                  <p>
                    {plainSkipReason(component.reason)}
                    {component.restOfPackageLoaded &&
                      " The rest of this mod was loaded."}
                  </p>
                  <details className="translator-scan-details">
                    <summary>Details</summary>
                    <code>{component.relativeLocation}</code>
                    <span>{component.reason}</span>
                  </details>
                </div>
              </li>
            ))}
            {warnings.map((warning, index) => (
              <li className="translator-scan-card" key={`${warning}:${index}`}>
                <AlertTriangle aria-hidden="true" />
                <div>
                  <strong>{warningTitle(warning)}</strong>
                  <p>{warning}</p>
                  {(duplicates.byWarning.get(index)?.length ?? 0) > 0 && (
                    <ul
                      className="translator-scan-card-mods"
                      aria-label="Affected mods"
                    >
                      {duplicates.byWarning.get(index)!.map((component) => (
                        <li key={component.relativeLocation}>
                          <code>
                            Mods/{modFolder(component.relativeLocation)}
                          </code>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {expectedExclusions.length > 0 && (
        <details className="translator-scan-footnote">
          <summary>
            <Info aria-hidden="true" />{" "}
            {describeExpectedExclusions(expectedExclusions)} (expected, no
            action needed)
          </summary>
          <ul aria-label="Expected scan exclusions">
            {expectedExclusions.map((component, index) => (
              <li
                key={`${component.relativeLocation}:${component.componentUniqueId ?? index}`}
              >
                <strong>
                  {component.componentName ??
                    component.componentUniqueId ??
                    component.packageId ??
                    component.relativeLocation}
                </strong>{" "}
                {component.reason}
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

/** What a translator needs to know about English source changes since the
 * previous scan. A comparison is only unavailable when the scan had problems,
 * which are listed under Needs attention. */
function describeSourceChanges(deltas: ScanResult["sourceDeltas"]): {
  text: string;
  highlight: boolean;
} {
  if (!deltas)
    return {
      text: "New and changed texts are listed again once the problems below are fixed.",
      highlight: false,
    };
  const parts = [
    deltas.stringsAdded > 0 ? `${deltas.stringsAdded} new` : "",
    deltas.sourcesChanged > 0 ? `${deltas.sourcesChanged} changed` : "",
  ].filter(Boolean);
  if (parts.length === 0)
    return {
      text: "No new or changed English text since your last scan.",
      highlight: false,
    };
  const total = deltas.stringsAdded + deltas.sourcesChanged;
  return {
    text: `Since your last scan: ${parts.join(" and ")} ${total === 1 ? "text" : "texts"} to translate.`,
    highlight: true,
  };
}

/** Duplicate-UniqueID warnings name only the ID; the scan also skips each
 * affected folder. Show those folders inside the warning instead of as
 * separate cards, so one problem is one card. */
function groupDuplicateIds(
  warnings: string[],
  skips: SkippedComponent[],
): {
  byWarning: Map<number, SkippedComponent[]>;
  grouped: Set<SkippedComponent>;
} {
  const byWarning = new Map<number, SkippedComponent[]>();
  const grouped = new Set<SkippedComponent>();
  warnings.forEach((warning, index) => {
    const ids = /same ID \(([^)]*)\)/i
      .exec(warning)?.[1]
      ?.split(",")
      .map((id) => id.trim().toLowerCase());
    if (!ids) return;
    const affected = skips.filter(
      (component) =>
        /UniqueID is duplicated/i.test(component.reason) &&
        ids.includes((component.componentUniqueId ?? "").toLowerCase()),
    );
    affected.forEach((component) => grouped.add(component));
    byWarning.set(index, affected);
  });
  return { byWarning, grouped };
}

/** The mod folder of a skip location such as `Mod/i18n/default.json`. */
function modFolder(location: string): string {
  const cut = location.search(/\/i18n(\/|$)/i);
  return cut > 0 ? location.slice(0, cut) : location;
}

/** A short title for a free-text scanner warning. */
function warningTitle(warning: string): string {
  if (/same ID \(/i.test(warning)) return "Duplicate mod ID";
  if (/could not be scanned completely/i.test(warning))
    return "Incomplete scan";
  if (/cannot be read|unreadable/i.test(warning)) return "Unreadable file";
  if (/translation[- ]state|saved translations/i.test(warning))
    return "Saved translations";
  if (/baseline|comparison/i.test(warning)) return "Change comparison";
  return "Scan note";
}

/** A short, plain explanation of a skip; the technical reason stays under
 * Details for bug reports to the mod author. */
function plainSkipReason(reason: string): string {
  if (/mixed top-level and language-folder|duplicate source key/i.test(reason))
    return "It uses a translation file layout that SMAPI does not support, so it was left out.";
  if (/translation state is unavailable/i.test(reason))
    return "Its saved translations could not be loaded safely, so it was left out.";
  if (/manifest/i.test(reason))
    return "Its manifest.json could not be read, so it was left out.";
  if (/outside the configured mods folder/i.test(reason))
    return "It points outside the Mods folder and was left out for safety.";
  if (
    /invalid json|expected .* at line|could not read|non-string value|flat json object/i.test(
      reason,
    )
  )
    return "A translation file in this mod is damaged and was left out. Reinstalling the mod usually fixes it; your other mods are not affected.";
  return "Part of this mod could not be read and was left out.";
}
