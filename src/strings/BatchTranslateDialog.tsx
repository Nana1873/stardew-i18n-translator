/**
 * Compact progress surface for one selected-string AI run.
 *
 * Engine choice lives in Settings. Opening this surface starts exactly the
 * selected Open/Changed rows immediately; completed suggestions are persisted
 * as Review before the backend returns them. The only decision left here is
 * whether to cancel an active run.
 */
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { useDialogAccessibility } from "../dialogAccessibility";
import type {
  AiEngine,
  AiRunProgress,
  AiRunRecovery,
  AiRunResult,
  CodexActivityStage,
} from "../tauri/commands";
import { listenAiRunProgress } from "../tauri/commands";

export interface LiveAiEngineOption {
  id: AiEngine;
  label: string;
  ready: boolean;
  model: string;
  reasoning: string;
  unavailableReason?: string;
  note: string;
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

const PHASE_LABELS: Record<AiRunProgress["phase"], string> = {
  preparing: "Preparing batch",
  translating: "Translating draft",
  reviewing: "Reviewing quality",
  terminologyRepair: "Checking terminology",
  tokenRepair: "Repairing protected tokens",
  saving: "Validating & saving",
};

const RECOVERY_LABELS: Record<AiRunRecovery, string> = {
  transientRetry: "Retrying temporary failure",
  structureRetry: "Retrying response structure",
  split: "Splitting affected batch",
};

const CODEX_ACTIVITY_LABELS: Record<CodexActivityStage, string> = {
  starting: "Starting process",
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
  const [liveProgress, setLiveProgress] = useState<AiRunProgress | null>(null);
  const [lastCodexActivity, setLastCodexActivity] = useState<{
    sequence: number;
    stage: CodexActivityStage;
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
          recordCompletionCheckpoint(event.completed, event.total);
          setDone(event.completed);
          setLiveProgress(event);
          const stage = event.codexStage;
          const sequence = event.codexActivitySequence;
          if (stage && sequence !== undefined) {
            setLastCodexActivity((current) =>
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

  const total = liveProgress?.total ?? items.length;
  const progressPercent = total > 0 ? Math.round((done / total) * 100) : 0;
  const indeterminate = !liveProgress;
  const phaseLabel = cancelRequested
    ? "Cancelling active batch"
    : liveProgress
      ? PHASE_LABELS[liveProgress.phase]
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
  const activityText = activityParts.join(" · ");
  const metaParts = [
    `${engine?.label ?? "AI"} active`,
    formatElapsed(elapsedSeconds),
  ];
  if (!cancelRequested && liveProgress?.recovery) {
    metaParts.push(RECOVERY_LABELS[liveProgress.recovery]);
  }
  if (liveProgress?.retries) {
    metaParts.push(
      `${liveProgress.retries} ${liveProgress.retries === 1 ? "retry" : "retries"}`,
    );
  }
  if (liveProgress?.splits) {
    metaParts.push(
      `${liveProgress.splits} ${liveProgress.splits === 1 ? "split" : "splits"}`,
    );
  }
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
  const activityAge = lastCodexActivity
    ? Math.max(
        0,
        Math.floor((Date.now() - lastCodexActivity.receivedAt) / 1_000),
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
              <Sparkles aria-hidden="true" />{" "}
              {cancelRequested
                ? "Cancelling…"
                : "Translating selected strings…"}
            </h2>
            <div className="translator-kicker">
              {engine?.label ?? "AI"} · completed suggestions enter Review ·{" "}
              {modName}
            </div>
          </div>
        </div>

        <div className="translator-flow-body">
          <div className="translator-ai-count">
            <span>Saved to Review</span>
            <strong>
              {done} / {total}
            </strong>
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
            {lastCodexActivity && activityAge !== null && (
              <span>
                Codex activity ·{" "}
                {CODEX_ACTIVITY_LABELS[lastCodexActivity.stage]} ·{" "}
                {formatActivityAge(activityAge)}
              </span>
            )}
            {!cancelRequested && estimatedRemainingSeconds !== null && (
              <span>
                Estimated remaining ·{" "}
                {formatEstimatedRemaining(estimatedRemainingSeconds)}
              </span>
            )}
            {usageText && <span>Codex reported · {usageText}</span>}
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
                  ? `Cancelling the active AI batch; ${done} of ${total} ${total === 1 ? "suggestion" : "suggestions"} saved to Review`
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
