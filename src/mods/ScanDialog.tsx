import { type CSSProperties, useRef } from "react";
import { AlertTriangle, CheckCircle2, Info, RefreshCw, X } from "lucide-react";
import type { ExtraKeyDiagnostic, ScanResult } from "../tauri/commands";
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

function countLabel(
  value: number | string,
  singular: string,
  plural: string,
): string {
  return value === 1 ? singular : plural;
}

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
  const expectedExclusionCount = result?.skippedComponents?.filter(
    (component) => !component.requiresAttention,
  ).length;
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
    <div className="translator-flow-overlay">
      <section
        ref={dialogRef}
        className="translator-flow-dialog translator-scan-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Scan"
        tabIndex={-1}
        onKeyDown={onDialogKeyDown}
      >
        <div className="translator-flow-head">
          <div>
            <h2 className="translator-heading">{title}</h2>
            <div className="translator-kicker">
              Local Mods folder · read-only
            </div>
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
          <button
            className="translator-button translator-button-quiet"
            type="button"
            disabled={scanning}
            onClick={onClose}
          >
            Close
          </button>
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
            Open new{" "}
            {countLabel(
              sourceDeltas?.stringsAdded ?? "Unavailable",
              "string",
              "strings",
            )}{" "}
            · {sourceDeltas?.stringsAdded ?? "Unavailable"}
          </button>
          <button
            className="translator-button translator-button-primary"
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
            Review changed{" "}
            {countLabel(
              sourceDeltas?.sourcesChanged ?? "Unavailable",
              "string",
              "strings",
            )}{" "}
            · {sourceDeltas?.sourcesChanged ?? "Unavailable"}
          </button>
        </div>

        <span className="translator-sr-only" aria-live="polite">
          {scanning
            ? "Scan in progress"
            : error
              ? `Scan failed: ${error}`
              : result
                ? `Scan complete. ${result.modCount} ${result.modCount === 1 ? "mod" : "mods"} and ${result.fileCount} ${result.fileCount === 1 ? "i18n file" : "i18n files"} found. ${warningCount} scanner ${warningCount === 1 ? "warning" : "warnings"}; ${skippedCount == null ? "skipped-component count unavailable" : `${skippedCount} ${skippedCount === 1 ? "component" : "components"} skipped`}; ${expectedExclusionCount ?? 0} community language ${expectedExclusionCount === 1 ? "pack" : "packs"} ignored.`
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
  const warningParts: string[] = [];
  if (warnings.length > 0) {
    warningParts.push(
      `${warnings.length} scanner ${warnings.length === 1 ? "warning" : "warnings"}`,
    );
  }
  if (skipped == null) {
    warningParts.push("Skipped-component details unavailable");
  } else if (skippedForAttention.length > 0) {
    warningParts.push(
      `${skippedForAttention.length} ${skippedForAttention.length === 1 ? "component" : "components"} skipped`,
    );
  }
  const hasWarningDiagnostics = warningParts.length > 0;
  const hasInformation = expectedExclusions.length > 0 || extraKeys.length > 0;
  const extraKeySummary = `${extraKeys.length} ${
    extraKeys.length === 1
      ? "translation entry has"
      : "translation entries have"
  } no matching English source`;

  return (
    <>
      <p>
        <CheckCircle2 aria-hidden="true" /> Read {result.modCount}{" "}
        {result.modCount === 1 ? "mod" : "mods"} and {result.fileCount}{" "}
        {result.fileCount === 1 ? "i18n file" : "i18n files"}.
      </p>
      <div
        className="translator-preflight-metrics"
        aria-label="Latest scan result"
      >
        <Metric
          value={result.modCount}
          label={countLabel(result.modCount, "mod found", "mods found")}
        />
        <Metric
          value={result.fileCount}
          label={countLabel(result.fileCount, "i18n file", "i18n files")}
        />
        <Metric
          value={result.sourceDeltas?.sourcesChanged ?? "Unavailable"}
          label={countLabel(
            result.sourceDeltas?.sourcesChanged ?? "Unavailable",
            "English string changed",
            "English strings changed",
          )}
        />
        <Metric
          value={result.sourceDeltas?.stringsAdded ?? "Unavailable"}
          label={countLabel(
            result.sourceDeltas?.stringsAdded ?? "Unavailable",
            "string added",
            "strings added",
          )}
        />
        <Metric
          value={result.sourceDeltas?.stringsRemoved ?? "Unavailable"}
          label={countLabel(
            result.sourceDeltas?.stringsRemoved ?? "Unavailable",
            "string removed",
            "strings removed",
          )}
        />
        <Metric
          value={skipped == null ? "Unavailable" : skippedForAttention.length}
          label={countLabel(
            skipped == null ? "Unavailable" : skippedForAttention.length,
            "component skipped",
            "components skipped",
          )}
        />
      </div>

      <div
        className={`translator-flow-callout translator-scan-diagnostics${hasWarningDiagnostics ? " is-warning" : ""}`}
        tabIndex={-1}
        data-scan-diagnostics
      >
        {hasWarningDiagnostics && (
          <section className="translator-scan-warning-section">
            <p>
              <AlertTriangle aria-hidden="true" />{" "}
              <strong>{warningParts.join(" · ")}.</strong>
              {(warnings.length > 0 || skippedForAttention.length > 0) &&
                " Existing work was preserved."}
            </p>

            {skippedForAttention.length > 0 && (
              <ul
                className="translator-flow-list"
                aria-label="Skipped components"
              >
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
                      </strong>
                      {component.packageId && (
                        <>
                          <br />
                          <span>Package: {component.packageId}</span>
                        </>
                      )}
                      <br />
                      <code>{component.relativeLocation}</code>
                      <br />
                      <span>{component.reason}</span>
                    </span>
                    <span>
                      {component.restOfPackageLoaded
                        ? "Rest of package loaded"
                        : "No translatable files from this package were loaded"}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {warnings.length > 0 && (
              <ul className="translator-flow-list" aria-label="Scan warnings">
                {warnings.map((warning, index) => (
                  <li key={`${warning}:${index}`}>
                    <span>{warning}</span>
                    <span>Warning</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {!hasWarningDiagnostics && !hasInformation && (
          <p>No scanner warnings were reported.</p>
        )}

        {expectedExclusions.length > 0 && (
          <section className="translator-scan-info-section">
            <p className="translator-scan-info-summary">
              <Info aria-hidden="true" />{" "}
              <strong>
                {expectedExclusions.length}{" "}
                {expectedExclusions.length === 1
                  ? "community language pack was"
                  : "community language packs were"}{" "}
                ignored.
              </strong>{" "}
              This is expected and needs no action.
            </p>
            <ul
              className="translator-flow-list"
              aria-label="Expected scan exclusions"
            >
              {expectedExclusions.map((component, index) => {
                const displayName =
                  component.componentName ??
                  component.componentUniqueId ??
                  component.packageId ??
                  "Community language pack";
                const showPackage =
                  Boolean(component.packageId) &&
                  component.packageId !== displayName;
                const showLocation =
                  component.relativeLocation !== displayName &&
                  component.relativeLocation !== component.packageId;
                return (
                  <li
                    key={`${component.relativeLocation}:${component.componentUniqueId ?? index}`}
                  >
                    <span>
                      <strong>{displayName}</strong>
                      {showPackage && (
                        <>
                          <br />
                          <span>Package: {component.packageId}</span>
                        </>
                      )}
                      {showLocation && (
                        <>
                          <br />
                          <code>{component.relativeLocation}</code>
                        </>
                      )}
                      <br />
                      <span>{component.reason}</span>
                    </span>
                    <span>No action needed</span>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {extraKeys.length > 0 && (
          <section className="translator-scan-info-section">
            <p className="translator-scan-info-summary">
              <Info aria-hidden="true" /> <strong>{extraKeySummary}.</strong>{" "}
              They are in the translation file, but not in the mod&apos;s
              English source file (default.json), usually because the mod
              removed or renamed them. SMAPI ignores them. They do not count
              toward progress or block export. No action is required. The next
              export omits them from the new translation file and retains the
              original file in its backup.
            </p>
            <ul
              className="translator-scan-extra-groups"
              aria-label="Translation entries without matching English source"
            >
              {extraKeyGroups.map((group) => (
                <li key={`${group.modName}:${group.targetPath}`}>
                  <strong>{group.modName}</strong>
                  <details open={group.keys.length <= 3}>
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
          </section>
        )}
      </div>
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

function Metric({ value, label }: { value: number | string; label: string }) {
  return (
    <div className="translator-preflight-metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}
