import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowRight, FileCheck2, GitCompareArrows } from "lucide-react";
import type { ScanResult, ScannedMod } from "../tauri/commands";

export type OverviewFilter =
  "has-value" | "translated" | "attention" | "untranslated" | "issues";

export interface DashboardLastExport {
  /** Real current-session export label, for example "Last export · Sample". */
  label: string;
  /** Real target path returned by the successful export command. */
  path: string;
}

interface DashboardProps {
  scan: ScanResult | null;
  scanning: boolean;
  /** Real completion time of the latest scan in this running session. */
  lastScanAt: number | null;
  /** "German (de)" subtitle fragment. */
  languageLine: string;
  onScan: () => void;
  scanEnabled: boolean;
  onOpenMod: (uniqueId: string) => void;
  onOpenAttention: (
    uniqueId: string,
    status: "outdated" | "review-needed",
  ) => void;
  onBrowse: () => void;
  /** Resume ordering only: modId -> epoch ms of its last open. */
  lastOpened: Record<string, number>;
  /** Opens the retained result of the latest real scan. */
  onShowScanDetails?: () => void;
  /** Applies one of the accepted cross-mod Overview shortcuts. */
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

function count(value: number): string {
  return numberFormat.format(value);
}

function scanAgeLabel(epochMs: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - epochMs) / 60_000));
  if (minutes < 1) return "scanned less than a minute ago";
  if (minutes < 60) return `scanned ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48)
    return `scanned ${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(hours / 24);
  return `scanned ${days} ${days === 1 ? "day" : "days"} ago`;
}

export function Dashboard({
  scan,
  scanning,
  lastScanAt,
  languageLine,
  onScan,
  scanEnabled,
  onOpenMod,
  onOpenAttention,
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
  const reviewTotal = mods.reduce((sum, mod) => sum + mod.reviewNeeded, 0);
  const allStatusesKnown =
    withKeys.length > 0 && withKeys.every((mod) => mod.statusCounts != null);
  const reviewedCurrent = allStatusesKnown
    ? withKeys.reduce(
        (sum, mod) => sum + (mod.statusCounts?.translated ?? 0),
        0,
      )
    : null;
  const reviewedPct =
    reviewedCurrent != null && totalKeys > 0
      ? Math.round((reviewedCurrent / totalKeys) * 100)
      : null;
  const changedKnown = allStatusesKnown
    ? withKeys.reduce((sum, mod) => sum + (mod.statusCounts?.outdated ?? 0), 0)
    : null;
  const attentionRows = mods
    .flatMap((mod) => {
      const rows: Array<{
        mod: ScannedMod;
        status: "outdated" | "review-needed";
        count: number;
      }> = [];
      const changed = mod.statusCounts?.outdated;
      if (changed != null && changed > 0) {
        rows.push({ mod, status: "outdated", count: changed });
      }
      if (mod.reviewNeeded > 0) {
        rows.push({
          mod,
          status: "review-needed",
          count: mod.reviewNeeded,
        });
      }
      return rows;
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);
  const recent = withKeys
    .filter((mod) => lastOpened[mod.uniqueId] != null)
    .sort((a, b) => lastOpened[b.uniqueId] - lastOpened[a.uniqueId])
    .slice(0, 4);
  const continueMod = recent[0] ?? withKeys[0] ?? null;
  const targetLanguage = languageLine.split(" (")[0].trim() || "target";

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
    <main className="stv3-overview" aria-label="Overview">
      <div className="stv3-overview-head">
        <div>
          <h1 className="stv3-heading">Overview</h1>
          <div className="stv3-kicker">
            {languageLine}
            {scan ? ` · ${scan.modCount} mods` : " · not scanned"}
            {scan
              ? lastScanAt == null
                ? " · scan time unavailable"
                : ` · ${scanAgeLabel(lastScanAt)}`
              : ""}
          </div>
        </div>
        {continueMod ? (
          <button
            className="stv3-button stv3-button-primary"
            type="button"
            onClick={() => onOpenMod(continueMod.uniqueId)}
          >
            <ArrowRight aria-hidden="true" /> Continue {continueMod.name}
          </button>
        ) : (
          <button
            className="stv3-button stv3-button-primary"
            type="button"
            onClick={onScan}
            disabled={!scanEnabled}
          >
            <GitCompareArrows aria-hidden="true" />
            {scanning ? "Scanning …" : "Scan mods"}
          </button>
        )}
      </div>

      <div className="stv3-overview-stats">
        <button
          className="stv3-overview-stat"
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
          className="stv3-overview-stat"
          type="button"
          onClick={() => openFilter("translated")}
        >
          <span>Reviewed &amp; current</span>
          <strong>
            {reviewedCurrent == null
              ? "Unavailable"
              : `${count(reviewedCurrent)} · ${reviewedPct}%`}
          </strong>
          <small>
            {reviewedCurrent == null
              ? "All-mod status aggregation is not available yet"
              : "Done for the current English source"}
          </small>
        </button>
        <button
          className="stv3-overview-stat"
          type="button"
          onClick={() => openFilter("attention")}
        >
          <span>Needs attention</span>
          <strong>
            {!scan
              ? "Unavailable"
              : `${count(reviewTotal)} Review · ${
                  changedKnown == null
                    ? "Changed unavailable"
                    : `${count(changedKnown)} Changed`
                }`}
          </strong>
          <small>
            {!scan
              ? "No scan data is available"
              : changedKnown == null
                ? "Review is known; Changed and validation issues unavailable"
                : "Changed and Review are known; validation issues unavailable"}
          </small>
        </button>
        <button
          className="stv3-overview-stat"
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
          className="stv3-scan-summary"
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
              Latest scan: {count(scan.modCount)} mods · {count(scan.fileCount)}{" "}
              i18n files
            </strong>
            <span>
              {scan.warnings.length} scanner{" "}
              {scan.warnings.length === 1 ? "warning" : "warnings"} ·
              skipped-component count and change, added, and removed deltas
              unavailable
            </span>
          </span>
          <span aria-hidden="true">→</span>
        </button>
      ) : (
        <button
          className="stv3-scan-summary"
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

      <div className="stv3-last-export">
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
          className="stv3-button stv3-button-quiet"
          type="button"
          onClick={onShowLastExport}
          disabled={!lastExport || !onShowLastExport}
        >
          Show in folder
        </button>
      </div>

      <div className="stv3-overview-grid">
        <section className="stv3-section">
          <div className="stv3-section-head">
            <h2 className="stv3-heading">Recently edited</h2>
            <div className="stv3-kicker">
              Resume recently opened mods · edit time unavailable
            </div>
          </div>
          <table className="stv3-overview-table">
            <thead>
              <tr>
                <th>Mod</th>
                <th>Progress</th>
                <th>Last activity</th>
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
                    onOpen={() => onOpenMod(mod.uniqueId)}
                    onShowStatusHelp={showStatusHelp}
                    onHideStatusHelp={() => setStatusTooltip(null)}
                  />
                ))
              ) : (
                <tr>
                  <td colSpan={4}>
                    <span className="stv3-kicker">
                      Unavailable · no mod has been opened in this portable
                      workspace yet.
                    </span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>

        <section className="stv3-section">
          <div className="stv3-section-head">
            <h2 className="stv3-heading">Needs attention</h2>
            <div className="stv3-kicker">
              Top real queues · per-mod validation issue counts unavailable
            </div>
          </div>
          <div className="stv3-attention-list">
            {attentionRows.map(({ mod, status, count: queueCount }) => (
              <button
                key={`${mod.uniqueId}:${status}`}
                className="stv3-attention-row"
                type="button"
                onClick={() => onOpenAttention(mod.uniqueId, status)}
              >
                <span>
                  <span className="stv3-row-title">
                    {mod.name} · {count(queueCount)}
                  </span>
                  {status === "outdated" ? (
                    <span className="stv3-attention-badges">
                      <span className="stv3-attention-badge">
                        Changed source
                      </span>
                      <span className="stv3-attention-badge">
                        Update assistant · Unavailable
                      </span>
                    </span>
                  ) : (
                    <span className="stv3-row-meta">
                      AI suggestions awaiting review
                    </span>
                  )}
                </span>
                <span aria-hidden="true">→</span>
              </button>
            ))}
            {attentionRows.length === 0 && (
              <div className="stv3-attention-row">
                <span>
                  <span className="stv3-row-title">
                    No known Changed or Review queue
                  </span>
                  <span className="stv3-row-meta">
                    {changedKnown == null
                      ? "Changed and validation issue totals are unavailable."
                      : "Validation issue totals are unavailable."}
                  </span>
                </span>
                <span aria-hidden="true">—</span>
              </div>
            )}
            <button
              className="stv3-attention-row"
              type="button"
              onClick={() => openFilter("issues")}
            >
              <span>
                <span className="stv3-row-title">
                  Validation issues · Unavailable
                </span>
                <span className="stv3-row-meta">
                  Per-mod validation issue counts are unavailable
                </span>
              </span>
              <span aria-hidden="true">→</span>
            </button>
            <button
              className="stv3-attention-row"
              type="button"
              onClick={() => openFilter("attention")}
            >
              <span>
                <span className="stv3-row-title">
                  View combined attention queue
                </span>
                <span className="stv3-row-meta">
                  Changed and Review use real statuses; validation issues stay
                  unavailable.
                </span>
              </span>
              <span>
                {scan
                  ? `${count(reviewTotal)} Review · ${
                      changedKnown == null
                        ? "Changed unavailable"
                        : `${count(changedKnown)} Changed`
                    } →`
                  : "Unavailable →"}
              </span>
            </button>
          </div>
        </section>
      </div>

      {statusTooltip && (
        <div
          ref={statusTooltipRef}
          className="stv3-status-tooltip"
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
  onOpen,
  onShowStatusHelp,
  onHideStatusHelp,
}: {
  mod: ScannedMod;
  targetLanguage: string;
  onOpen: () => void;
  onShowStatusHelp: (target: HTMLElement, text: string) => void;
  onHideStatusHelp: () => void;
}) {
  const openCount = Math.max(0, mod.totalKeys - mod.translatedKeys);
  const changed = mod.statusCounts?.outdated ?? 0;
  const status =
    changed > 0
      ? {
          className: "stv3-state is-change",
          label: `${count(changed)} changed`,
          help: `The English source changed after this ${targetLanguage} translation was saved. The existing translation may be outdated and should be reviewed.`,
        }
      : mod.reviewNeeded > 0
        ? {
            className: "stv3-state is-review",
            label: `${count(mod.reviewNeeded)} to review`,
            help: "This imported or AI-generated suggestion still needs human approval.",
          }
        : openCount > 0
          ? {
              className: "stv3-state",
              label: `${count(openCount)} open`,
              help: `No accepted ${targetLanguage} translation exists yet.`,
            }
          : {
              className: "stv3-state is-ready",
              label: "Done",
              help: `The ${targetLanguage} translation was explicitly saved or accepted for the current English source.`,
            };

  return (
    <tr>
      <td>
        <button className="stv3-overview-link" type="button" onClick={onOpen}>
          {mod.name}
        </button>
      </td>
      <td>
        {count(mod.translatedKeys)} / {count(mod.totalKeys)}
      </td>
      <td>Unavailable</td>
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
