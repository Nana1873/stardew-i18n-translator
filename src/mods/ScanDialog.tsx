import { type CSSProperties, useRef } from "react";
import { AlertTriangle, CheckCircle2, RefreshCw, X } from "lucide-react";
import type { ScanResult } from "../tauri/commands";
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
  "--stv3-batch-progress": "100%",
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
    initialFocusSelector: focusDiagnostics
      ? "[data-scan-diagnostics]"
      : undefined,
  });
  const complete = !scanning && !error && result != null;
  const warningCount = result?.warnings.length ?? 0;
  const skippedCount = result?.skippedComponents?.length;
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
    <div className="stv3-flow-overlay">
      <section
        ref={dialogRef}
        className="stv3-flow-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Scan"
        onKeyDown={onDialogKeyDown}
      >
        <div className="stv3-flow-head">
          <div>
            <h2 className="stv3-heading">{title}</h2>
            <div className="stv3-kicker">Local Mods folder · read-only</div>
          </div>
          {!scanning && (
            <button
              className="stv3-icon-button"
              type="button"
              aria-label="Close scan"
              onClick={onClose}
            >
              <X aria-hidden="true" />
            </button>
          )}
        </div>

        <div className="stv3-flow-body">
          <div className="stv3-progress-row">
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
              <div className="stv3-flow-callout">
                Exact scan progress is unavailable. Existing translation state
                remains untouched while the local folder is read.
              </div>
            </>
          ) : error ? (
            <div className="stv3-flow-callout is-error" role="alert">
              <strong>Scan failed:</strong> {error}
            </div>
          ) : result ? (
            <ScanResultContent result={result} />
          ) : (
            <div className="stv3-flow-callout">Scan result unavailable.</div>
          )}
        </div>

        <div className="stv3-flow-foot">
          <button
            className="stv3-button stv3-button-quiet"
            type="button"
            disabled={scanning}
            onClick={onClose}
          >
            Close
          </button>
          <button
            className="stv3-button stv3-button-quiet"
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
            Open new strings · {sourceDeltas?.stringsAdded ?? "Unavailable"}
          </button>
          <button
            className="stv3-button stv3-button-primary"
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
                  ? "No English sources changed in this scan"
                  : "Show exactly the sources changed since the previous scan"
                : "Changed-source deltas are unavailable in the current scan result"
            }
            onClick={onReviewChangedSources}
          >
            Review changed sources ·{" "}
            {sourceDeltas?.sourcesChanged ?? "Unavailable"}
          </button>
        </div>

        <span className="stv3-sr-only" aria-live="polite">
          {scanning
            ? "Scan in progress"
            : error
              ? `Scan failed: ${error}`
              : result
                ? `Scan complete. ${result.modCount} mods and ${result.fileCount} files found. ${warningCount} scanner ${warningCount === 1 ? "warning" : "warnings"}; ${skippedCount == null ? "skipped-component count unavailable" : `${skippedCount} ${skippedCount === 1 ? "component" : "components"} skipped`}.`
                : "Scan result unavailable"}
        </span>
      </section>
    </div>
  );
}

function ScanResultContent({ result }: { result: ScanResult }) {
  const warnings = result.warnings;
  const skipped = result.skippedComponents;
  const extraKeys = result.extraKeys ?? [];
  const diagnosticParts: string[] = [];
  if (warnings.length > 0) {
    diagnosticParts.push(
      `${warnings.length} scanner ${warnings.length === 1 ? "warning" : "warnings"}`,
    );
  }
  if (skipped == null) {
    diagnosticParts.push("Skipped-component details unavailable");
  } else if (skipped.length > 0) {
    diagnosticParts.push(
      `${skipped.length} ${skipped.length === 1 ? "component" : "components"} skipped`,
    );
  }
  if (extraKeys.length > 0) {
    diagnosticParts.push(
      `${extraKeys.length} unused target ${extraKeys.length === 1 ? "key" : "keys"}`,
    );
  }
  const hasDiagnostics = diagnosticParts.length > 0;

  return (
    <>
      <p>
        <CheckCircle2 aria-hidden="true" /> Read {result.modCount}{" "}
        {result.modCount === 1 ? "mod" : "mods"} and {result.fileCount}{" "}
        {result.fileCount === 1 ? "i18n file" : "i18n files"}.
      </p>
      <div className="stv3-preflight-metrics" aria-label="Latest scan result">
        <Metric value={result.modCount} label="mods found" />
        <Metric value={result.fileCount} label="i18n files" />
        <Metric
          value={result.sourceDeltas?.sourcesChanged ?? "Unavailable"}
          label="sources changed"
        />
        <Metric
          value={result.sourceDeltas?.stringsAdded ?? "Unavailable"}
          label="strings added"
        />
        <Metric
          value={result.sourceDeltas?.stringsRemoved ?? "Unavailable"}
          label="strings removed"
        />
        <Metric
          value={skipped == null ? "Unavailable" : skipped.length}
          label="components skipped"
        />
      </div>

      <div
        className={`stv3-flow-callout${hasDiagnostics ? " is-warning" : ""}`}
        tabIndex={-1}
        data-scan-diagnostics
      >
        {hasDiagnostics ? (
          <p>
            <AlertTriangle aria-hidden="true" />{" "}
            <strong>{diagnosticParts.join(" · ")}.</strong>
            {(warnings.length > 0 || (skipped?.length ?? 0) > 0) &&
              " Existing work was preserved."}
            {extraKeys.length > 0 &&
              " SMAPI ignores unused target keys; they do not affect progress or block export."}
          </p>
        ) : (
          <p>No scanner warnings were reported.</p>
        )}

        {skipped && skipped.length > 0 && (
          <ul className="stv3-flow-list" aria-label="Skipped components">
            {skipped.map((component, index) => (
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
                    : "Package not otherwise loaded"}
                </span>
              </li>
            ))}
          </ul>
        )}

        {warnings.length > 0 && (
          <ul className="stv3-flow-list" aria-label="Scan warnings">
            {warnings.map((warning, index) => (
              <li key={`${warning}:${index}`}>
                <span>{warning}</span>
                <span>Warning</span>
              </li>
            ))}
          </ul>
        )}

        {extraKeys.length > 0 && (
          <ul className="stv3-flow-list" aria-label="Unused translation keys">
            {extraKeys.map((diagnostic, index) => (
              <li key={`${diagnostic.targetPath}:${diagnostic.key}:${index}`}>
                <span>
                  <strong>{diagnostic.modName}</strong>
                  <br />
                  <code>{diagnostic.targetPath}</code>
                </span>
                <code>{diagnostic.key}</code>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function Metric({ value, label }: { value: number | string; label: string }) {
  return (
    <div className="stv3-preflight-metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}
