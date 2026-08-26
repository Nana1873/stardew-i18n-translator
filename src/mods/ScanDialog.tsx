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
            disabled
            title="New-string deltas are unavailable in the current scan result"
          >
            Open new strings · Unavailable
          </button>
          <button
            className="stv3-button stv3-button-primary"
            type="button"
            disabled
            title="Changed-source deltas are unavailable in the current scan result"
          >
            Review changed sources · Unavailable
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
        <Metric value="Unavailable" label="sources changed" />
        <Metric value="Unavailable" label="strings added" />
        <Metric value="Unavailable" label="strings removed" />
        <Metric
          value={skipped == null ? "Unavailable" : skipped.length}
          label="components skipped"
        />
      </div>
      <div className="stv3-flow-callout">
        Change, added-string, and removed-string deltas are unavailable in the
        current backend result. No scan history is invented.
      </div>

      {skipped == null ? (
        <div className="stv3-flow-callout" tabIndex={-1} data-scan-diagnostics>
          Structured skipped-component details are unavailable in this scan
          result.
        </div>
      ) : skipped.length > 0 ? (
        <>
          <div
            className="stv3-flow-callout is-warning"
            tabIndex={-1}
            data-scan-diagnostics
          >
            <AlertTriangle aria-hidden="true" />{" "}
            <strong>{skipped.length}</strong>{" "}
            {skipped.length === 1 ? "component was" : "components were"}{" "}
            skipped. Other readable components remain loaded.
          </div>
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
        </>
      ) : (
        <div className="stv3-flow-callout" tabIndex={-1} data-scan-diagnostics>
          No components were skipped.
        </div>
      )}

      {warnings.length > 0 ? (
        <>
          <div
            className="stv3-flow-callout is-warning"
            tabIndex={-1}
            data-scan-diagnostics
          >
            <AlertTriangle aria-hidden="true" />{" "}
            <strong>
              {warnings.length} scanner{" "}
              {warnings.length === 1 ? "warning was" : "warnings were"}{" "}
              reported.
            </strong>{" "}
            Existing work was preserved.
          </div>
          <ul className="stv3-flow-list" aria-label="Scan warnings">
            {warnings.map((warning, index) => (
              <li key={`${warning}:${index}`}>
                <span>{warning}</span>
                <span>Warning</span>
              </li>
            ))}
          </ul>
          <p className="stv3-kicker">
            Scanner warning text is shown unchanged.
          </p>
        </>
      ) : (
        <div className="stv3-flow-callout" tabIndex={-1} data-scan-diagnostics>
          No scanner warnings were reported.
        </div>
      )}

      {extraKeys.length > 0 && (
        <>
          <div className="stv3-flow-callout is-warning">
            <strong>Optional cleanup:</strong> {extraKeys.length} unused target{" "}
            {extraKeys.length === 1 ? "key was" : "keys were"} found. SMAPI
            ignores these keys; they do not affect progress or block export.
          </div>
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
        </>
      )}
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
