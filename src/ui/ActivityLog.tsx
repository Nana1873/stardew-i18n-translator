import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp, Copy } from "lucide-react";
import type { OperationHistoryEntry } from "../tauri/commands";
import {
  appendActivity,
  operationActivity,
  reportActivity,
  type ActivityBuffer,
  type ActivityDetails,
  type ActivityEvent,
  type AiActivityUpdate,
} from "./activity";
import { WorkingDots } from "./WorkingDots";

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
  modNames,
  height,
  onHeightChange,
  onDetails,
  notifications,
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
  modNames: ReadonlyMap<string, string>;
  height: number;
  onHeightChange: (height: number) => void;
  onDetails: (details: ActivityDetails) => void;
  notifications?: ReactNode;
}) {
  const [buffer, setBuffer] = useState<ActivityBuffer>({
    entries: [],
    omitted: 0,
  });
  const sequence = useRef(0);
  const [aiActivity, setAiActivity] = useState<{
    runId: string;
    steps: string[];
  } | null>(null);
  const seenOperations = useRef(new Set<string>());
  const seenScan = useRef<number | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const followTail = useRef(true);
  const resizing = useRef<{ y: number; height: number } | null>(null);
  const [unread, setUnread] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle",
  );
  const maximumHeight = Math.max(106, Math.floor(window.innerHeight * 0.45));
  function append(event: ActivityEvent, time = Date.now()) {
    const id = ++sequence.current;
    setBuffer((current) => appendActivity(current, event, time, id));
  }
  function resize(next: number) {
    onHeightChange(Math.max(80, Math.min(maximumHeight, next)));
  }
  function toggleExpanded() {
    resize(height > 106 ? 106 : 300);
  }
  useEffect(() => {
    function onActivity(event: Event) {
      const detail = (
        event as CustomEvent<{ event: ActivityEvent; time: number }>
      ).detail;
      append(detail.event, detail.time);
    }
    function onAiActivity(event: Event) {
      const { time, entries, runId, activeSteps } = (
        event as CustomEvent<AiActivityUpdate>
      ).detail;
      if (runId && activeSteps)
        setAiActivity((current) =>
          activeSteps.length || current?.runId === runId
            ? { runId, steps: activeSteps }
            : current,
        );
      for (const entry of entries)
        append(
          {
            kind: "message",
            message: entry.message,
            tone: entry.tone ?? (entry.warning ? "warning" : "info"),
            aiStep: entry.aiStep,
          },
          time,
        );
    }
    window.addEventListener("translator-activity", onActivity);
    window.addEventListener("translator-ai-activity", onAiActivity);
    return () => {
      window.removeEventListener("translator-activity", onActivity);
      window.removeEventListener("translator-ai-activity", onAiActivity);
    };
  }, []);
  useEffect(() => {
    if (scanning)
      append({ kind: "message", message: "Scanning mods…", tone: "info" });
  }, [scanning]);
  useEffect(() => {
    if (scanError)
      append({
        kind: "message",
        message: `Scan failed: ${scanError}`,
        tone: "error",
      });
  }, [scanError]);
  useEffect(() => {
    if (!lastScanAt || seenScan.current === lastScanAt) return;
    seenScan.current = lastScanAt;
    const diagnostics = [
      ...(warningCount
        ? [
            `${warningCount} scanner ${warningCount === 1 ? "warning" : "warnings"}`,
          ]
        : []),
      ...(skippedCount === null
        ? ["skipped-component details unavailable"]
        : skippedCount
          ? [
              `${skippedCount} ${skippedCount === 1 ? "component" : "components"} skipped`,
            ]
          : []),
    ];
    append(
      {
        kind: "message",
        message: `Scan completed: ${modCount} ${modCount === 1 ? "mod" : "mods"}, ${totalStrings} source ${totalStrings === 1 ? "string" : "strings"}, ${language}.${diagnostics.length ? ` ${diagnostics.join(", ")}.` : ""}`,
        tone: diagnostics.length ? "warning" : "success",
        details: { kind: "scan", time: lastScanAt },
      },
      lastScanAt,
    );
  }, [lastScanAt]);
  useEffect(() => {
    // A refresh may contain several completed operations, or only changed undo
    // availability. Log each identity once, in completion order.
    for (const entry of [...history].reverse()) {
      if (seenOperations.current.has(entry.id)) continue;
      seenOperations.current.add(entry.id);
      append(operationActivity(entry, modNames), entry.completedAtEpochMs);
    }
    while (seenOperations.current.size > 1000)
      seenOperations.current.delete(
        seenOperations.current.values().next().value!,
      );
  }, [history]);
  useEffect(() => {
    if (logRef.current && followTail.current)
      logRef.current.scrollTop = logRef.current.scrollHeight;
    else if (buffer.entries.length) setUnread(true);
  }, [buffer]);
  useEffect(() => {
    if (copyState !== "copied") return;
    const timer = window.setTimeout(() => setCopyState("idle"), 2000);
    return () => window.clearTimeout(timer);
  }, [copyState]);
  async function copyLog() {
    try {
      if (!navigator.clipboard?.writeText)
        throw new Error("Clipboard unavailable");
      const prefix = buffer.omitted
        ? [`${buffer.omitted} older entries omitted.`]
        : [];
      await navigator.clipboard.writeText(
        [
          ...prefix,
          ...buffer.entries.map(
            (entry) =>
              `${new Date(entry.time).toLocaleTimeString("en-GB")} [${entry.tone}] ${entry.message}`,
          ),
        ].join("\n"),
      );
      setCopyState("copied");
    } catch {
      reportActivity({
        kind: "message",
        message: "Could not copy the Activity log to the clipboard.",
        tone: "error",
      });
      setCopyState("error");
    }
  }
  // A retry may revisit a phase. Only its newest entry can be active.
  const latestSteps = new Map(
    buffer.entries
      .filter((entry) => entry.aiStep)
      .map((entry) => [entry.aiStep, entry.id]),
  );
  const activeSteps = new Set(aiActivity?.steps);
  return (
    <section className="desktop-log-panel" aria-label="Activity log">
      <div
        className="desktop-notifications"
        role="region"
        aria-label="Notifications"
      >
        {notifications}
        <div id="ai-progress-slot" />
      </div>
      <div
        className="desktop-log-resize"
        role="separator"
        aria-label="Resize Activity log"
        aria-orientation="horizontal"
        aria-valuemin={80}
        aria-valuemax={maximumHeight}
        aria-valuenow={Math.min(height, maximumHeight)}
        tabIndex={0}
        onDoubleClick={toggleExpanded}
        onKeyDown={(event) => {
          if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
          event.preventDefault();
          resize(height + (event.key === "ArrowUp" ? 40 : -40));
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          resizing.current = {
            y: event.clientY,
            height: Math.min(height, maximumHeight),
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (resizing.current)
            resize(
              resizing.current.height + resizing.current.y - event.clientY,
            );
        }}
        onPointerUp={() => {
          resizing.current = null;
        }}
        onLostPointerCapture={() => {
          resizing.current = null;
        }}
      />
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
        <button
          type="button"
          className="translator-button translator-button-quiet"
          onClick={() => void copyLog()}
          disabled={!buffer.entries.length}
        >
          <Copy aria-hidden />{" "}
          {copyState === "copied"
            ? "Copied"
            : copyState === "error"
              ? "Retry copy"
              : "Copy log"}
        </button>
        <button
          type="button"
          className="translator-button translator-button-quiet"
          aria-label={
            height > 106 ? "Collapse Activity log" : "Expand Activity log"
          }
          aria-expanded={height > 106}
          aria-controls="activity-log-entries"
          onClick={toggleExpanded}
        >
          {height > 106 ? (
            <ChevronDown aria-hidden />
          ) : (
            <ChevronUp aria-hidden />
          )}
        </button>
      </div>
      <div
        className="desktop-log"
        id="activity-log-entries"
        role="log"
        aria-live="polite"
        ref={logRef}
        tabIndex={0}
        aria-label="Activity entries"
        onScroll={(event) => {
          const log = event.currentTarget;
          followTail.current =
            log.scrollHeight - log.scrollTop - log.clientHeight <= 12;
          if (followTail.current) setUnread(false);
        }}
      >
        {buffer.omitted > 0 && (
          <p className="desktop-log-omitted">
            {buffer.omitted} older entries omitted. Recent warnings and errors
            are retained.
          </p>
        )}
        {buffer.entries.length === 0 ? (
          <p>Ready. Scan your mods to begin.</p>
        ) : (
          buffer.entries.map((entry) => {
            const working =
              !!entry.aiStep &&
              activeSteps.has(entry.aiStep) &&
              latestSteps.get(entry.aiStep) === entry.id;
            const available =
              entry.details?.kind !== "scan" ||
              (entry.details.time === lastScanAt && !scanning && !scanError);
            return (
              <p
                key={entry.id}
                data-tone={entry.tone}
                data-ai-active={working || undefined}
              >
                <time dateTime={new Date(entry.time).toISOString()}>
                  {new Date(entry.time).toLocaleTimeString("en-GB")}
                </time>{" "}
                {entry.message}
                {working && <WorkingDots />}
                {entry.details && (
                  <button
                    type="button"
                    className="desktop-log-details"
                    disabled={!available}
                    title={
                      available
                        ? undefined
                        : "Only the latest scan details are available."
                    }
                    aria-label={`Details: ${entry.message}`}
                    onClick={() => onDetails(entry.details!)}
                  >
                    Details
                  </button>
                )}
              </p>
            );
          })
        )}
      </div>
    </section>
  );
}
