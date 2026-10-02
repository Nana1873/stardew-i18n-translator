/**
 * Compact progress surface for one selected-string AI run.
 *
 * Engine choice lives in Settings. Opening this surface starts exactly the
 * selected Open/Changed rows immediately; completed suggestions are persisted
 * as Review before the backend returns them. The only decision left here is
 * whether to cancel an active run.
 */
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { useDialogAccessibility } from "../dialogAccessibility";
import type {
  AiEngine,
  AiRunProgress,
  AiRunResult,
  ProviderActivityStage,
} from "../tauri/commands";
import { listenAiRunProgress, CLOUD_ENGINE_LABEL } from "../tauri/commands";
import { AI_PHASE_LABELS, describeProgressChanges } from "./aiRunActivity";

export interface LiveAiEngineOption {
  id: AiEngine;
  label: string;
  ready: boolean;
  model: string;
  reasoning: string;
  unavailableReason?: string;
  note: string;
  qualityReview?: boolean;
}

/** One selected string captured when a run starts. */
export interface BatchItem {
  modUniqueId?: string;
  key: string;
  file: string;
  source: string;
  status: "untranslated" | "outdated";
  section?: string | null;
}

export interface BatchFinishedResult {
  runId?: string;
  done: number;
  total: number;
  outcome: "complete" | "cancelled" | "error";
  error?: string;
  engine?: string;
  model?: string;
  reasoning?: string;
}

function createRunId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `ai-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}

const CLOUD_ACTIVITY_LABELS: Record<ProviderActivityStage, string> = {
  starting: "Starting request",
  working: "Working",
  reasoning: "Reasoning",
  writingResponse: "Writing response",
  completed: "Response received",
  failed: "Error reported",
};

function formatElapsed(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatTokenCount(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

function formatActivityAge(totalSeconds: number): string {
  return totalSeconds < 2 ? "just now" : `${formatElapsed(totalSeconds)} ago`;
}

function formatEstimatedRemaining(totalSeconds: number): string {
  const minutes = Math.max(1, Math.ceil(totalSeconds / 60));
  if (minutes < 60) return `about ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0
    ? `about ${hours} hr ${remainingMinutes} min`
    : `about ${hours} hr`;
}

interface BatchTranslateDialogProps {
  items: BatchItem[];
  modName: string;
  engine?: LiveAiEngineOption;
  onLiveRun: (runId: string) => Promise<AiRunResult>;
  onCancelLiveRun?: (runId: string) => Promise<boolean>;
  onFinished: (result: BatchFinishedResult) => void;
  onClose: () => void;
}

export function BatchTranslateDialog({
  items,
  modName,
  engine,
  onLiveRun,
  onCancelLiveRun,
  onFinished,
  onClose,
}: BatchTranslateDialogProps) {
  const [done, setDone] = useState(0);
  const [activityLog, setActivityLog] = useState([
    {
      id: 0,
      seconds: 0,
      message: "Preparing selected strings",
      warning: false,
    },
  ]);
  const previousProgressRef = useRef<AiRunProgress | null>(null);
  const activitySequenceRef = useRef(0);
  const activityLogRef = useRef<HTMLDivElement>(null);
  const followActivityRef = useRef(true);
  const [liveProgress, setLiveProgress] = useState<AiRunProgress | null>(null);
  const [lastCloudActivity, setLastCloudActivity] = useState<{
    sequence: number;
    stage: ProviderActivityStage;
    receivedAt: number;
  } | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [estimatedRemainingSeconds, setEstimatedRemainingSeconds] = useState<
    number | null
  >(null);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const cancelRef = useRef(false);
  const runIdRef = useRef(createRunId());
  const liveRunPromiseRef = useRef<Promise<AiRunResult> | null>(null);
  const reportedRef = useRef(false);
  const startedAtRef = useRef(Date.now());
  const completedCheckpointRef = useRef(0);
  const dialogRef = useRef<HTMLElement>(null);

  function recordCompletionCheckpoint(completed: number, total: number) {
    if (completed <= completedCheckpointRef.current) return;
    const elapsedAtCheckpoint = Math.max(
      1,
      Math.floor((Date.now() - startedAtRef.current) / 1_000),
    );
    completedCheckpointRef.current = completed;
    if (completed >= total) {
      setEstimatedRemainingSeconds(null);
      return;
    }
    setEstimatedRemainingSeconds(
      Math.ceil((elapsedAtCheckpoint / completed) * (total - completed)),
    );
  }

  function appendActivity(entries: { message: string; warning?: boolean }[]) {
    if (entries.length === 0) return;
    const seconds = Math.max(
      0,
      Math.floor((Date.now() - startedAtRef.current) / 1_000),
    );
    const next = entries.map((entry) => ({
      id: ++activitySequenceRef.current,
      seconds,
      message: entry.message,
      warning: Boolean(entry.warning),
    }));
    // Retain useful phase transitions without growing the dialog for long runs.
    setActivityLog((current) => [...current, ...next].slice(-200));
  }

  useEffect(() => {
    const log = activityLogRef.current;
    if (log && followActivityRef.current) log.scrollTop = log.scrollHeight;
  }, [activityLog]);

  function finish(result: BatchFinishedResult) {
    if (reportedRef.current) return;
    reportedRef.current = true;
    onFinished(result);
    onClose();
  }

  function cancel() {
    if (cancelRef.current) return;
    cancelRef.current = true;
    setCancelRequested(true);
    appendActivity([
      { message: "Cancellation requested · waiting for active work to stop" },
    ]);
    setEstimatedRemainingSeconds(null);
    if (onCancelLiveRun) {
      void onCancelLiveRun(runIdRef.current).catch((cause) =>
        setCancelError(String(cause)),
      );
    }
  }

  const { onDialogKeyDown } = useDialogAccessibility({
    dialogRef,
    onEscape: cancel,
  });

  useEffect(() => {
    const update = () => {
      setElapsedSeconds(
        Math.max(0, Math.floor((Date.now() - startedAtRef.current) / 1_000)),
      );
    };
    update();
    const interval = window.setInterval(update, 1_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    let active = true;
    let unlistenProgress: (() => void) | null = null;
    const runId = runIdRef.current;

    function releaseProgressListener() {
      const unlisten = unlistenProgress;
      unlistenProgress = null;
      unlisten?.();
    }

    (async () => {
      try {
        const unlisten = await listenAiRunProgress((event) => {
          if (!active || event.runId !== runId) return;
          if (!cancelRef.current) {
            appendActivity(
              describeProgressChanges(previousProgressRef.current, event),
            );
          }
          previousProgressRef.current = event;
          recordCompletionCheckpoint(event.completed, event.total);
          setDone(event.completed);
          setLiveProgress(event);
          const stage = event.providerStage;
          const sequence = event.providerActivitySequence;
          if (stage && sequence !== undefined) {
            setLastCloudActivity((current) =>
              current?.sequence === sequence
                ? current
                : {
                    sequence,
                    stage,
                    receivedAt: Date.now(),
                  },
            );
          }
        });
        if (!active) {
          unlisten();
          return;
        }
        unlistenProgress = unlisten;
      } catch {
        // The final command result remains authoritative when event delivery
        // is unavailable (for example in a browser-only preview).
      }
      if (!active) return;
      if (cancelRef.current) {
        finish({
          runId,
          done: 0,
          total: items.length,
          outcome: "cancelled",
          engine: engine?.label ?? "AI",
          ...(engine?.model ? { model: engine.model } : {}),
          ...(engine?.reasoning ? { reasoning: engine.reasoning } : {}),
        });
        return;
      }
      try {
        liveRunPromiseRef.current ??= onLiveRun(runId);
        const result = await liveRunPromiseRef.current;
        if (!active) return;
        setDone(result.completed);
        finish({
          runId: result.runId,
          done: result.completed,
          total: result.requested,
          outcome: result.outcome,
          ...(result.error ? { error: result.error } : {}),
          engine: engine?.label ?? result.engine,
          model: result.model,
          reasoning: result.reasoning,
        });
      } catch (cause) {
        if (!active) return;
        finish({
          runId,
          done: 0,
          total: items.length,
          outcome: "error",
          error: String(cause),
          engine: engine?.label ?? "AI",
          ...(engine?.model ? { model: engine.model } : {}),
          ...(engine?.reasoning ? { reasoning: engine.reasoning } : {}),
        });
      }
    })();

    return () => {
      active = false;
      releaseProgressListener();
    };
    // Items are an immutable selection snapshot for this one run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const modelLabel =
    engine?.id === "chatgpt" &&
    /^gpt-\d+(?:\.\d+)?(?:-[a-z]+)*$/i.test(engine.model)
      ? engine.model
          .split("-")
          .map((part) =>
            part.toLowerCase() === "gpt"
              ? "GPT"
              : part.charAt(0).toUpperCase() + part.slice(1),
          )
          .join(" ")
      : engine?.model;
  const engineSummary = [
    engine?.label ?? "AI",
    modelLabel,
    engine?.reasoning
      ? engine.reasoning.charAt(0).toUpperCase() + engine.reasoning.slice(1)
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const total = liveProgress?.total ?? items.length;
  const translated = Math.min(
    total,
    Math.max(done, liveProgress?.translated ?? done),
  );
  const progressPercent = total > 0 ? Math.round((done / total) * 100) : 0;
  const indeterminate = !liveProgress;
  const phaseLabel = cancelRequested
    ? liveProgress?.batchActivity
      ? "Cancelling active batches"
      : "Cancelling active batch"
    : liveProgress
      ? AI_PHASE_LABELS[liveProgress.phase]
      : "Preparing selected strings";
  const activityParts = [phaseLabel];
  if (
    !cancelRequested &&
    liveProgress?.batchIndex !== undefined &&
    liveProgress.batchTotal !== undefined
  ) {
    activityParts.push(
      `Batch ${liveProgress.batchIndex} of ${liveProgress.batchTotal}`,
    );
  }
  if (!cancelRequested && liveProgress?.batchSize !== undefined) {
    activityParts.push(
      `${liveProgress.batchSize} ${liveProgress.batchSize === 1 ? "string" : "strings"}`,
    );
  }
  const batchActivity = liveProgress?.batchActivity;
  const parallelSummary =
    batchActivity === undefined
      ? null
      : [
          `${batchActivity.length} ${batchActivity.length === 1 ? "batch" : "batches"} active`,
          ...(liveProgress?.parallelLimit
            ? [`up to ${liveProgress.parallelLimit}`]
            : []),
          ...(liveProgress?.batchTotal
            ? [`${liveProgress.batchTotal} batches total`]
            : []),
        ].join(" · ");
  const activityText =
    !cancelRequested && parallelSummary !== null
      ? parallelSummary
      : activityParts.join(" · ");
  const metaParts = [`Elapsed · ${formatElapsed(elapsedSeconds)}`];
  const usage = liveProgress?.usage;
  const usageText = usage
    ? [
        `${formatTokenCount(usage.inputTokens)} input${
          usage.cachedInputTokens
            ? ` (${formatTokenCount(usage.cachedInputTokens)} cached)`
            : ""
        }`,
        `${formatTokenCount(usage.outputTokens)} output`,
        ...(usage.reasoningOutputTokens
          ? [`${formatTokenCount(usage.reasoningOutputTokens)} reasoning`]
          : []),
      ].join(" · ")
    : null;
  const activityAge = lastCloudActivity
    ? Math.max(
        0,
        Math.floor((Date.now() - lastCloudActivity.receivedAt) / 1_000),
      )
    : null;

  return (
    <div className="translator-flow-overlay">
      <section
        ref={dialogRef}
        className="translator-flow-dialog translator-ai-progress-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="AI translation progress"
        onKeyDown={onDialogKeyDown}
      >
        <div className="translator-flow-head">
          <div>
            <h2 className="translator-heading">
              {cancelRequested
                ? "Cancelling…"
                : "Translating selected strings…"}
            </h2>
            <div className="translator-kicker">{engineSummary}</div>
          </div>
        </div>

        <div className="translator-flow-body">
          <div className="translator-ai-count">
            <span>Saved to Review</span>
            <strong>
              {done} / {total}
            </strong>
          </div>
          <div className="translator-progress-row">
            <span
              role="progressbar"
              aria-label="AI translation progress"
              aria-valuemin={0}
              aria-valuemax={total}
              aria-valuenow={indeterminate ? undefined : done}
              aria-valuetext={
                cancelRequested
                  ? `Cancelling active AI work; ${done} of ${total} ${total === 1 ? "suggestion" : "suggestions"} saved to Review`
                  : indeterminate
                    ? `${total} selected ${total === 1 ? "string is" : "strings are"} being prepared`
                    : `${done} of ${total} ${total === 1 ? "suggestion" : "suggestions"} saved to Review; ${activityText.toLowerCase()}`
              }
              data-indeterminate={indeterminate ? "true" : undefined}
              style={
                {
                  "--translator-batch-progress": `${indeterminate ? 35 : progressPercent}%`,
                } as CSSProperties
              }
            />
          </div>
          <div
            className="translator-ai-activity"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {activityText}
          </div>
          <div className="translator-ai-meta">
            <span>{metaParts.join(" · ")}</span>
            {!cancelRequested && estimatedRemainingSeconds !== null && (
              <span>
                Estimated remaining ·{" "}
                {formatEstimatedRemaining(estimatedRemainingSeconds)}
              </span>
            )}
          </div>
          <dl className="translator-ai-facts">
            <div>
              <dt>Mod</dt>
              <dd>{modName}</dd>
            </div>
            <div>
              <dt>Drafts received</dt>
              <dd>
                <output aria-label="Translated strings">
                  {translated} / {total}
                </output>
              </dd>
            </div>
            {engine?.qualityReview !== undefined && (
              <div>
                <dt>Quality check</dt>
                <dd>{engine.qualityReview ? "On" : "Off"}</dd>
              </div>
            )}
            {lastCloudActivity && activityAge !== null && (
              <div>
                <dt>{CLOUD_ENGINE_LABEL} activity</dt>
                <dd>
                  {CLOUD_ACTIVITY_LABELS[lastCloudActivity.stage]} ·{" "}
                  {formatActivityAge(activityAge)}
                </dd>
              </div>
            )}
            {usageText && (
              <div>
                <dt>Tokens reported</dt>
                <dd>{usageText}</dd>
              </div>
            )}
            {batchActivity === undefined &&
              liveProgress?.activeBatches !== undefined && (
                <div>
                  <dt>Active batches</dt>
                  <dd>
                    {liveProgress.activeBatches}
                    {liveProgress.parallelLimit
                      ? " · up to " + liveProgress.parallelLimit
                      : ""}
                  </dd>
                </div>
              )}
            {Boolean(liveProgress?.retries) && (
              <div>
                <dt>Retries</dt>
                <dd>{liveProgress?.retries}</dd>
              </div>
            )}
            {Boolean(liveProgress?.splits) && (
              <div>
                <dt>Splits</dt>
                <dd>{liveProgress?.splits}</dd>
              </div>
            )}
          </dl>
          <div className="translator-ai-log-heading">
            <span>Activity log</span>
            {activityLog.length === 200 && <small>Latest 200 events</small>}
          </div>
          <div
            ref={activityLogRef}
            className="translator-ai-log"
            role="log"
            aria-label="Batch activity"
            aria-live="polite"
            aria-relevant="additions"
            tabIndex={0}
            onScroll={(event) => {
              const log = event.currentTarget;
              followActivityRef.current =
                log.scrollHeight - log.scrollTop - log.clientHeight < 24;
            }}
          >
            <ol>
              {activityLog.map((entry) => (
                <li key={entry.id} data-warning={entry.warning || undefined}>
                  <time>{formatElapsed(entry.seconds)}</time>
                  <span>{entry.message}</span>
                </li>
              ))}
            </ol>
          </div>
          {cancelError && (
            <div className="translator-flow-callout is-error" role="alert">
              {cancelError}
            </div>
          )}
        </div>

        <div className="translator-flow-foot">
          <button
            className="translator-button translator-button-quiet"
            type="button"
            onClick={cancel}
            disabled={cancelRequested}
          >
            {cancelRequested ? "Cancelling…" : "Cancel"}
          </button>
        </div>
      </section>
    </div>
  );
}
