import { useEffect, useRef, useState } from "react";
import { CircleAlert } from "lucide-react";
import type { OperationHistoryEntry } from "../tauri/commands";
import type { StringTableFilter } from "../strings/StringTable";

// Workspace status controls and activity feedback.
export function DesktopFilters({
  status,
  items,
  issues,
  issueCount,
  onStatus,
  onIssues,
  onHelp,
  onHideHelp,
}: {
  status: StringTableFilter;
  items: Array<{ value: StringTableFilter; label: string; count: number }>;
  issues: boolean;
  issueCount: number;
  onStatus: (status: StringTableFilter) => void;
  onIssues: (issues: boolean) => void;
  onHelp?: (target: HTMLElement, status: StringTableFilter | "issues") => void;
  onHideHelp?: () => void;
}) {
  return (
    <div className="desktop-filters" aria-label="String filters">
      <div
        className="desktop-status-labels"
        role="group"
        aria-label="String view"
      >
        {items.map((item) => (
          <button
            key={item.value}
            className="desktop-filter-action desktop-task-label"
            type="button"
            aria-label={item.label + " " + item.count}
            aria-pressed={!issues && status === item.value}
            data-status={item.value}
            onFocus={(event) => onHelp?.(event.currentTarget, item.value)}
            onBlur={onHideHelp}
            onPointerEnter={(event) =>
              onHelp?.(event.currentTarget, item.value)
            }
            onPointerLeave={onHideHelp}
            onClick={() => onStatus(item.value)}
          >
            {item.label}{" "}
            <span className="desktop-filter-count">{item.count}</span>
          </button>
        ))}
        <button
          className="desktop-filter-action desktop-task-label desktop-issues"
          type="button"
          aria-pressed={issues}
          aria-label={`Issues ${issueCount}`}
          disabled={!issues && issueCount === 0}
          data-status="issues"
          onFocus={(event) => onHelp?.(event.currentTarget, "issues")}
          onBlur={onHideHelp}
          onPointerEnter={(event) => onHelp?.(event.currentTarget, "issues")}
          onPointerLeave={onHideHelp}
          onClick={() => onIssues(true)}
        >
          <CircleAlert aria-hidden /> Issues
          <span className="desktop-filter-count">{issueCount}</span>
        </button>
      </div>
    </div>
  );
}

export function ValidationIcon() {
  return <CircleAlert className="desktop-validation-icon" aria-hidden />;
}

export function FileActionLabel({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <>
      <span className="desktop-export-copy">
        <span className="desktop-export-title">{title}</span>
        {description && (
          <span className="desktop-export-description">{description}</span>
        )}
      </span>
    </>
  );
}

export function ActivityLog({
  lastScanAt,
  modCount,
  totalStrings,
  language,
  scanning,
  warningCount,
  skippedCount,
  scanError,
  history,
  notice,
  noticeTone = "info",
}: {
  lastScanAt: number | null;
  modCount: number;
  totalStrings: number;
  language: string;
  scanning: boolean;
  warningCount: number;
  skippedCount: number | null;
  scanError: string | null;
  history: OperationHistoryEntry[];
  notice: string | null;
  noticeTone?: "info" | "success" | "warning" | "error";
}) {
  const [messages, setMessages] = useState<
    Array<{
      time: number;
      message: string;
      tone: "info" | "success" | "warning" | "error";
    }>
  >([]);
  const logRef = useRef<HTMLDivElement>(null);
  const followTail = useRef(true);
  const [unread, setUnread] = useState(false);
  function append(
    message: string,
    time = Date.now(),
    tone: "info" | "success" | "warning" | "error" = "info",
  ) {
    setMessages((current) => [...current, { time, message, tone }].slice(-80));
  }
  useEffect(() => {
    function onAiActivity(event: Event) {
      const { time, entries } = (
        event as CustomEvent<{
          time: number;
          entries: Array<{
            message: string;
            warning?: boolean;
            tone?: "info" | "success" | "warning" | "error";
          }>;
        }>
      ).detail;
      setMessages((current) =>
        [
          ...current,
          ...entries.map((entry) => ({
            time,
            message: entry.message,
            tone:
              entry.tone ??
              (entry.warning ? ("warning" as const) : ("info" as const)),
          })),
        ].slice(-80),
      );
    }
    window.addEventListener("translator-ai-activity", onAiActivity);
    return () =>
      window.removeEventListener("translator-ai-activity", onAiActivity);
  }, []);
  useEffect(() => {
    if (scanning) append("Scanning mods…");
  }, [scanning]);
  useEffect(() => {
    if (scanError) append("Scan failed: " + scanError, Date.now(), "error");
  }, [scanError]);
  useEffect(() => {
    const diagnostics = [
      ...(warningCount > 0
        ? [
            `${warningCount} scanner ${warningCount === 1 ? "warning" : "warnings"}`,
          ]
        : []),
      ...(skippedCount === null
        ? ["skipped-component details unavailable"]
        : skippedCount > 0
          ? [
              `${skippedCount} ${skippedCount === 1 ? "component" : "components"} skipped`,
            ]
          : []),
    ];
    if (lastScanAt)
      append(
        `Scan completed: ${modCount} ${modCount === 1 ? "mod" : "mods"}, ${totalStrings} source ${totalStrings === 1 ? "string" : "strings"}, ${language}.${diagnostics.length ? ` ${diagnostics.join(", ")}.` : ""}`,
        lastScanAt,
        diagnostics.length ? "warning" : "success",
      );
  }, [lastScanAt]);
  useEffect(() => {
    if (notice) append(notice, Date.now(), noticeTone);
  }, [notice, noticeTone]);
  useEffect(() => {
    const latest = history[0];
    if (latest)
      append(
        `${latest.title}: ${latest.summary}`,
        latest.completedAtEpochMs,
        latest.outcome === "failed"
          ? "error"
          : latest.outcome === "warning" || latest.outcome === "blocked"
            ? "warning"
            : latest.outcome === "success"
              ? "success"
              : "info",
      );
  }, [history[0]?.id]);
  useEffect(() => {
    if (logRef.current && followTail.current)
      logRef.current.scrollTop = logRef.current.scrollHeight;
    else if (messages.length) setUnread(true);
  }, [messages]);

  return (
    <section className="desktop-log-panel" aria-label="Activity log">
      <div className="desktop-log-head">
        <h2>Activity log</h2>
        {unread && (
          <button
            type="button"
            className="translator-button translator-button-quiet"
            onClick={() => {
              followTail.current = true;
              setUnread(false);
              if (logRef.current)
                logRef.current.scrollTop = logRef.current.scrollHeight;
            }}
          >
            Latest entries
          </button>
        )}
        <div id="ai-progress-slot" />
      </div>
      <div
        className="desktop-log"
        role="log"
        aria-live="polite"
        ref={logRef}
        onScroll={(event) => {
          const log = event.currentTarget;
          followTail.current =
            log.scrollHeight - log.scrollTop - log.clientHeight <= 12;
          if (followTail.current) setUnread(false);
        }}
      >
        {messages.length === 0 ? (
          <p>Ready. Scan your mods to begin.</p>
        ) : (
          messages.map((entry, index) => (
            <p key={index} data-tone={entry.tone}>
              <time>{new Date(entry.time).toLocaleTimeString("en-GB")}</time>{" "}
              {entry.message}
            </p>
          ))
        )}
      </div>
    </section>
  );
}
