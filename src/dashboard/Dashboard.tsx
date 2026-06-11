/**
 * Dashboard home — v1.5 redesign rollout ④ (SPEC §7.0, docs/design/).
 *
 * The landing screen answers "where do I stand?" before any table loads:
 * overview stat cards, the cross-mod review queue (every unreviewed AI
 * suggestion, sorted by backlog size), and "continue where you left off"
 * resume cards. Clicking anything jumps straight into the work view.
 */
import type { ScanResult, ScannedMod } from "../tauri/commands";

interface DashboardProps {
  scan: ScanResult | null;
  scanning: boolean;
  /** "German (de-DE) · …" subtitle fragment. */
  languageLine: string;
  onScan: () => void;
  scanEnabled: boolean;
  /** Open one mod in the work view. */
  onOpenMod: (uniqueId: string) => void;
  /** Open one mod filtered down to its review backlog. */
  onOpenReview: (uniqueId: string) => void;
  /** Switch to the work view without picking a mod. */
  onBrowse: () => void;
  /** modId → epoch ms of the last time it was opened (localStorage). */
  lastOpened: Record<string, number>;
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return "Up late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function agoLabel(epochMs: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - epochMs) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function Dashboard({
  scan,
  scanning,
  languageLine,
  onScan,
  scanEnabled,
  onOpenMod,
  onOpenReview,
  onBrowse,
  lastOpened,
}: DashboardProps) {
  const mods = scan?.mods ?? [];
  const withKeys = mods.filter((mod) => mod.totalKeys > 0);
  const totalKeys = withKeys.reduce((sum, mod) => sum + mod.totalKeys, 0);
  const translatedKeys = withKeys.reduce(
    (sum, mod) => sum + mod.translatedKeys,
    0,
  );
  const pct =
    totalKeys > 0 ? Math.round((translatedKeys / totalKeys) * 100) : 0;
  const reviewTotal = mods.reduce((sum, mod) => sum + mod.reviewNeeded, 0);
  const reviewMods = mods
    .filter((mod) => mod.reviewNeeded > 0)
    .sort((a, b) => b.reviewNeeded - a.reviewNeeded)
    .slice(0, 5);
  const inProgress = withKeys.filter(
    (mod) => mod.translatedKeys > 0 && mod.translatedKeys < mod.totalKeys,
  ).length;
  const untouched = withKeys.filter((mod) => mod.translatedKeys === 0).length;
  const recent = withKeys
    .filter((mod) => lastOpened[mod.uniqueId])
    .sort((a, b) => lastOpened[b.uniqueId] - lastOpened[a.uniqueId])
    .slice(0, 3);

  return (
    <main className="dash" aria-label="Dashboard">
      <div className="dash__head">
        <div>
          <h1 className="dash__greeting">{greeting()}</h1>
          <div className="dash__sub">
            {languageLine}
            {scan ? ` · ${scan.modCount} mods scanned` : ""}
          </div>
        </div>
        <button
          type="button"
          className="dash__scan"
          onClick={onScan}
          disabled={!scanEnabled}
        >
          {scanning
            ? "Scanning…"
            : scan
              ? "Scan for changes"
              : "Scan your Mods folder"}
        </button>
      </div>

      {!scan ? (
        <div className="dash__empty">
          Scan your Mods folder to see translation progress, the review queue,
          and where you left off.
        </div>
      ) : (
        <>
          <div className="dash__cards">
            <div className="dashcard">
              <div className="dashcard__label">Overall translated</div>
              <div className="dashcard__value">{pct}%</div>
              <div className="dashcard__bar">
                <span
                  className="dashcard__fill"
                  style={{ width: `${pct}%`, background: "#5ec488" }}
                />
              </div>
              <div className="dashcard__sub">
                {translatedKeys.toLocaleString()} / {totalKeys.toLocaleString()}{" "}
                strings
              </div>
            </div>
            <div className="dashcard dashcard--review">
              <div className="dashcard__label">Needs review</div>
              <div className="dashcard__value" style={{ color: "#ec8b3f" }}>
                {reviewTotal}
              </div>
              <div className="dashcard__sub">
                {reviewTotal > 0
                  ? `across ${reviewMods.length === 5 ? "5+" : mods.filter((m) => m.reviewNeeded > 0).length} mods`
                  : "queue is clear"}
              </div>
            </div>
            <div className="dashcard">
              <div className="dashcard__label">In progress</div>
              <div className="dashcard__value">{inProgress}</div>
              <div className="dashcard__sub">mods between 1–99%</div>
            </div>
            <div className="dashcard">
              <div className="dashcard__label">Untouched</div>
              <div className="dashcard__value">{untouched}</div>
              <div className="dashcard__sub">mods at 0%</div>
            </div>
          </div>

          {reviewTotal > 0 && (
            <div className="dash__queue">
              <div className="dash__queue-head">
                <span className="dash__queue-icon" aria-hidden>
                  ⚑
                </span>
                <div>
                  <div className="dash__queue-title">Review queue</div>
                  <div className="dash__queue-sub">
                    {reviewTotal} AI suggestion{reviewTotal === 1 ? "" : "s"}{" "}
                    awaiting your judgement
                  </div>
                </div>
              </div>
              <div className="dash__queue-rows">
                {reviewMods.map((mod) => (
                  <QueueRow
                    key={mod.uniqueId}
                    mod={mod}
                    max={reviewMods[0].reviewNeeded}
                    onOpen={() => onOpenReview(mod.uniqueId)}
                  />
                ))}
              </div>
            </div>
          )}

          <div className="dash__sectionlabel">Continue where you left off</div>
          {recent.length > 0 ? (
            <div className="dash__recent">
              {recent.map((mod) => (
                <ResumeCard
                  key={mod.uniqueId}
                  mod={mod}
                  ago={agoLabel(lastOpened[mod.uniqueId])}
                  onOpen={() => onOpenMod(mod.uniqueId)}
                />
              ))}
            </div>
          ) : (
            <div className="dash__sub">
              Nothing opened yet — pick a mod from the list.
            </div>
          )}

          <button type="button" className="dash__browse" onClick={onBrowse}>
            Browse all mods →
          </button>
        </>
      )}
    </main>
  );
}

function QueueRow({
  mod,
  max,
  onOpen,
}: {
  mod: ScannedMod;
  max: number;
  onOpen: () => void;
}) {
  const width = max > 0 ? Math.max(6, (mod.reviewNeeded / max) * 100) : 0;
  return (
    <button type="button" className="queuerow" onClick={onOpen}>
      <span className="queuerow__name" title={mod.name}>
        {mod.name}
      </span>
      <span className="queuerow__bar">
        <span className="queuerow__fill" style={{ width: `${width}%` }} />
      </span>
      <span className="queuerow__count">{mod.reviewNeeded}</span>
    </button>
  );
}

function ResumeCard({
  mod,
  ago,
  onOpen,
}: {
  mod: ScannedMod;
  ago: string;
  onOpen: () => void;
}) {
  const pct = Math.round(mod.progress * 100);
  return (
    <button type="button" className="recentcard" onClick={onOpen}>
      <span className="recentcard__top">
        <span className="recentcard__name" title={mod.name}>
          {mod.name}
        </span>
        <span className="recentcard__pct">{pct}%</span>
      </span>
      <span className="dashcard__bar">
        <span
          className="dashcard__fill"
          style={{
            width: `${pct}%`,
            background: pct >= 100 ? "#5ec488" : "var(--gold)",
          }}
        />
      </span>
      <span className="recentcard__bottom">
        <span>
          {mod.totalKeys.toLocaleString()} strings · {ago}
        </span>
        <span className="recentcard__resume">Resume →</span>
      </span>
    </button>
  );
}
