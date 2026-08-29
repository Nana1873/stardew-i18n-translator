import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowRight, FileCheck2, GitCompareArrows } from "lucide-react";
import type { ScanResult, ScannedMod } from "../tauri/commands";

export type OverviewFilter = "has-value" | "translated" | "untranslated";

export interface DashboardLastExport {
  /** Real current-session export label, for example "Last export · Sample". */
  label: string;
  /** Real target path returned by the successful export command. */
  path: string;
  /** Real folder to reveal; differs from path when path names a file. */
  folder: string;
}

interface DashboardProps {
  scan: ScanResult | null;
  scanning: boolean;
  /** Real completion time of the latest scan in this running session. */
  lastScanAt: number | null;
  /** Shared application clock, refreshed once per minute. */
  now: number;
  /** "German (de)" subtitle fragment. */
  languageLine: string;
  onScan: () => void;
  scanEnabled: boolean;
  onOpenMod: (uniqueId: string) => void;
  onBrowse: () => void;
  /** Resume ordering only: modId -> epoch ms of its last open. */
  lastOpened: Record<string, number>;
  /** Opens the retained result of the latest real scan. */
  onShowScanDetails?: () => void;
  /** Applies one of the cross-mod Overview filter shortcuts. */
  onOpenOverviewFilter?: (filter: OverviewFilter) => void;
  /** Latest genuine successful export in this running app session. */
  lastExport?: DashboardLastExport | null;
  onShowLastExport?: () => void;
}

interface StatusTooltipState {
  text: string;
  left: number;
  top: number;
  anchorCenter: number;
  anchorTop: number;
  anchorBottom: number;
}

const numberFormat = new Intl.NumberFormat("en-US");
const activityDateFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

function count(value: number): string {
  return numberFormat.format(value);
}

function scanAgeLabel(epochMs: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - epochMs) / 60_000));
  if (minutes < 1) return "scanned less than a minute ago";
  if (minutes < 60) return `scanned ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48)
    return `scanned ${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(hours / 24);
  return `scanned ${days} ${days === 1 ? "day" : "days"} ago`;
}

function lastOpenedLabel(epochMs: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - epochMs) / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  if (hours < 48) return "Yesterday";
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} days ago`;
  return activityDateFormat.format(new Date(epochMs));
}

export function Dashboard({
  scan,
  scanning,
  lastScanAt,
  now,
  languageLine,
  onScan,
  scanEnabled,
  onOpenMod,
  onBrowse,
  lastOpened,
  onShowScanDetails,
  onOpenOverviewFilter,
  lastExport = null,
  onShowLastExport,
}: DashboardProps) {
  const [statusTooltip, setStatusTooltip] = useState<StatusTooltipState | null>(
    null,
  );
  const statusTooltipRef = useRef<HTMLDivElement>(null);
  const mods = scan?.mods ?? [];
  const withKeys = mods.filter((mod) => mod.totalKeys > 0);
  const totalKeys = withKeys.reduce((sum, mod) => sum + mod.totalKeys, 0);
  const withText = withKeys.reduce((sum, mod) => sum + mod.translatedKeys, 0);
  const open = Math.max(0, totalKeys - withText);
  const withTextPct =
    totalKeys > 0 ? Math.round((withText / totalKeys) * 100) : 0;
  const openPct = totalKeys > 0 ? Math.round((open / totalKeys) * 100) : 0;
  const allStatusesKnown =
    scan != null && withKeys.every((mod) => mod.statusCounts != null);
  const reviewedCurrent = allStatusesKnown
    ? withKeys.reduce(
        (sum, mod) => sum + (mod.statusCounts?.translated ?? 0),
        0,
      )
    : null;
  const reviewedPct =
    reviewedCurrent == null
      ? null
      : totalKeys > 0
        ? Math.round((reviewedCurrent / totalKeys) * 100)
        : 0;
  const recent = withKeys
    .filter((mod) => Number.isFinite(lastOpened[mod.uniqueId]))
    .sort((a, b) => lastOpened[b.uniqueId] - lastOpened[a.uniqueId])
    .slice(0, 4);
  const continueMod = recent[0] ?? withKeys[0] ?? null;
  const targetLanguage = languageLine.split(" (")[0].trim() || "target";
  const scanDeltaSummary = scan?.sourceDeltas
    ? `${count(scan.sourceDeltas.sourcesChanged)} English ${
        scan.sourceDeltas.sourcesChanged === 1 ? "string" : "strings"
      } changed · ${count(scan.sourceDeltas.stringsAdded)} ${
        scan.sourceDeltas.stringsAdded === 1 ? "string" : "strings"
      } added · ${count(scan.sourceDeltas.stringsRemoved)} ${
        scan.sourceDeltas.stringsRemoved === 1 ? "string" : "strings"
      } removed`
    : "change, added, and removed deltas unavailable";
  const attentionSkippedCount = scan?.skippedComponents?.filter(
    (component) => component.requiresAttention,
  ).length;

  useEffect(() => {
    const hideTooltip = () => setStatusTooltip(null);
    window.addEventListener("resize", hideTooltip);
    return () => window.removeEventListener("resize", hideTooltip);
  }, []);

  useLayoutEffect(() => {
    if (!statusTooltip || !statusTooltipRef.current) return;
    const tip = statusTooltipRef.current.getBoundingClientRect();
    const left = Math.min(
      window.innerWidth - tip.width - 8,
      Math.max(8, statusTooltip.anchorCenter - tip.width / 2),
    );
    const below = statusTooltip.anchorBottom + 7;
    const top =
      below + tip.height <= window.innerHeight - 8
        ? below
        : Math.max(8, statusTooltip.anchorTop - tip.height - 7);
    const roundedLeft = Math.round(left);
    const roundedTop = Math.round(top);
    setStatusTooltip((current) => {
      if (
        !current ||
        (current.left === roundedLeft && current.top === roundedTop)
      ) {
        return current;
      }
      return { ...current, left: roundedLeft, top: roundedTop };
    });
  }, [
    statusTooltip?.text,
    statusTooltip?.anchorCenter,
    statusTooltip?.anchorTop,
    statusTooltip?.anchorBottom,
  ]);

  function showStatusHelp(target: HTMLElement, text: string) {
    const rect = target.getBoundingClientRect();
    setStatusTooltip({
      text,
      left: 8,
      top: 8,
      anchorCenter: rect.left + rect.width / 2,
      anchorTop: rect.top,
      anchorBottom: rect.bottom,
    });
  }

  function openFilter(filter: OverviewFilter) {
    if (onOpenOverviewFilter) onOpenOverviewFilter(filter);
    else onBrowse();
  }

  return (
    <main className="translator-overview" aria-label="Overview">
      <div className="translator-overview-head">
        <div>
          <h1 className="translator-heading">Overview</h1>
          <div className="translator-kicker">
            {languageLine}
            {scan
              ? ` · ${scan.modCount} ${scan.modCount === 1 ? "mod" : "mods"}`
              : " · not scanned"}
            {scan
              ? lastScanAt == null
                ? " · scan time unavailable"
                : ` · ${scanAgeLabel(lastScanAt, now)}`
              : ""}
          </div>
        </div>
        {continueMod ? (
          <button
            className="translator-button translator-button-primary"
            type="button"
            onClick={() => onOpenMod(continueMod.uniqueId)}
          >
            <ArrowRight aria-hidden="true" /> Continue {continueMod.name}
          </button>
        ) : (
          <button
            className="translator-button translator-button-primary"
            type="button"
            onClick={onScan}
            disabled={!scanEnabled}
          >
            <GitCompareArrows aria-hidden="true" />
            {scanning ? "Scanning …" : "Scan mods"}
          </button>
        )}
      </div>

      <div className="translator-overview-stats">
        <button
          className="translator-overview-stat"
          type="button"
          onClick={() => openFilter("has-value")}
        >
          <span>Has {languageLine.split(" (")[0]} text</span>
          <strong>
            {scan
              ? `${count(withText)} / ${count(totalKeys)} · ${withTextPct}%`
              : "Unavailable"}
          </strong>
          <small>Includes values still needing review</small>
        </button>
        <button
          className="translator-overview-stat"
          type="button"
          onClick={() =>
            reviewedCurrent == null ? onScan() : openFilter("translated")
          }
          disabled={reviewedCurrent == null && !scanEnabled}
        >
          <span>Reviewed &amp; current</span>
          <strong>
            {reviewedCurrent == null
              ? scan
                ? "Scan again"
                : "Unavailable"
              : `${count(reviewedCurrent)} · ${reviewedPct}%`}
          </strong>
          <small>
            {reviewedCurrent == null
              ? scan
                ? "Run a scan to calculate current status"
                : "Scan the Mods folder to calculate current status"
              : "Done for the current English source"}
          </small>
        </button>
        <button
          className="translator-overview-stat"
          type="button"
          onClick={() => openFilter("untranslated")}
        >
          <span>Open</span>
          <strong>
            {scan ? `${count(open)} · ${openPct}%` : "Unavailable"}
          </strong>
          <small>No target-language value yet</small>
        </button>
      </div>

      {scan ? (
        <button
          className="translator-scan-summary"
          type="button"
          onClick={onShowScanDetails}
          disabled={!onShowScanDetails}
          title={
            onShowScanDetails
              ? "Show the latest scan details"
              : "Latest scan details are unavailable"
          }
        >
          <GitCompareArrows aria-hidden="true" />
          <span>
            <strong>
              Latest scan: {count(scan.modCount)}{" "}
              {scan.modCount === 1 ? "mod" : "mods"} · {count(scan.fileCount)}{" "}
              {scan.fileCount === 1 ? "i18n file" : "i18n files"}
            </strong>
            <span>
              {scan.warnings.length} scanner{" "}
              {scan.warnings.length === 1 ? "warning" : "warnings"} ·{" "}
              {attentionSkippedCount == null
                ? "skipped-component count unavailable"
                : `${attentionSkippedCount} ${attentionSkippedCount === 1 ? "component" : "components"} skipped`}
              {` · ${scanDeltaSummary}`}
            </span>
          </span>
          <span aria-hidden="true">→</span>
        </button>
      ) : (
        <button
          className="translator-scan-summary"
          type="button"
          onClick={onScan}
          disabled={!scanEnabled}
        >
          <GitCompareArrows aria-hidden="true" />
          <span>
            <strong>No scan result available</strong>
            <span>
              Scan the configured Mods folder to populate this Overview.
            </span>
          </span>
          <span aria-hidden="true">→</span>
        </button>
      )}

      <div className="translator-last-export">
        <FileCheck2 aria-hidden="true" />
        <span>
          <strong>
            {lastExport?.label ?? "Last export · Unavailable in this session"}
          </strong>
          <code>
            {lastExport?.path ??
              "No successful export path is available in this session."}
          </code>
        </span>
        <button
          className="translator-button translator-button-quiet"
          type="button"
          onClick={onShowLastExport}
          disabled={!lastExport || !onShowLastExport}
        >
          Show in folder
        </button>
      </div>

      <section className="translator-section">
        <div className="translator-section-head">
          <h2 className="translator-heading">Recently opened</h2>
          <div className="translator-kicker">Resume where you left off</div>
        </div>
        <table className="translator-overview-table">
          <thead>
            <tr>
              <th>Mod</th>
              <th>Progress</th>
              <th>Last opened</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {recent.length > 0 ? (
              recent.map((mod) => (
                <RecentRow
                  key={mod.uniqueId}
                  mod={mod}
                  targetLanguage={targetLanguage}
                  lastOpenedAt={lastOpened[mod.uniqueId]}
                  now={now}
                  onOpen={() => onOpenMod(mod.uniqueId)}
                  onShowStatusHelp={showStatusHelp}
                  onHideStatusHelp={() => setStatusTooltip(null)}
                />
              ))
            ) : (
              <tr>
                <td colSpan={4}>
                  <span className="translator-kicker">
                    No recently opened mods yet.
                  </span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      {statusTooltip && (
        <div
          ref={statusTooltipRef}
          className="translator-status-tooltip"
          role="tooltip"
          style={{ left: statusTooltip.left, top: statusTooltip.top }}
        >
          {statusTooltip.text}
        </div>
      )}
    </main>
  );
}

function RecentRow({
  mod,
  targetLanguage,
  lastOpenedAt,
  now,
  onOpen,
  onShowStatusHelp,
  onHideStatusHelp,
}: {
  mod: ScannedMod;
  targetLanguage: string;
  lastOpenedAt: number;
  now: number;
  onOpen: () => void;
  onShowStatusHelp: (target: HTMLElement, text: string) => void;
  onHideStatusHelp: () => void;
}) {
  const openCount = Math.max(0, mod.totalKeys - mod.translatedKeys);
  const changed = mod.statusCounts?.outdated ?? 0;
  const status =
    changed > 0
      ? {
          className: "translator-state is-change",
          label: `${count(changed)} changed`,
          help: `The English source changed after this ${targetLanguage} translation was saved. The existing translation may be outdated and should be reviewed.`,
        }
      : mod.reviewNeeded > 0
        ? {
            className: "translator-state is-review",
            label: `${count(mod.reviewNeeded)} to review`,
            help: "This imported or AI-generated suggestion still needs human approval.",
          }
        : openCount > 0
          ? {
              className: "translator-state",
              label: `${count(openCount)} open`,
              help: `No accepted ${targetLanguage} translation exists yet.`,
            }
          : {
              className: "translator-state is-ready",
              label: "Done",
              help: `The ${targetLanguage} translation was explicitly saved or accepted for the current English source.`,
            };

  return (
    <tr>
      <td>
        <button
          className="translator-overview-link"
          type="button"
          onClick={onOpen}
        >
          {mod.name}
        </button>
      </td>
      <td>
        {count(mod.translatedKeys)} / {count(mod.totalKeys)}
      </td>
      <td>
        <time
          dateTime={new Date(lastOpenedAt).toISOString()}
          title={`Opened ${new Date(lastOpenedAt).toLocaleString("en-US")}`}
        >
          {lastOpenedLabel(lastOpenedAt, now)}
        </time>
      </td>
      <td>
        <span
          className={status.className}
          data-status-help={status.help}
          aria-description={status.help}
          onPointerEnter={(event) =>
            onShowStatusHelp(event.currentTarget, status.help)
          }
          onPointerLeave={onHideStatusHelp}
        >
          {status.label}
        </span>
      </td>
    </tr>
  );
}
