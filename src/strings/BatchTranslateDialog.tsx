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
  TranslationResult,
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
  index: number;
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

interface BatchTranslateDialogProps {
  items: BatchItem[];
  modName: string;
  engine?: LiveAiEngineOption;
  onLiveRun?: (runId: string) => Promise<AiRunResult>;
  onCancelLiveRun?: (runId: string) => Promise<boolean>;
  onTranslate: (
    source: string,
    section?: string | null,
  ) => Promise<TranslationResult>;
  /** Legacy local-AI path: persist one finished result as Review. */
  onResult: (item: BatchItem, text: string) => Promise<void>;
  onFinished: (result: BatchFinishedResult) => void;
  onClose: () => void;
}

export function BatchTranslateDialog({
  items,
  modName,
  engine,
  onLiveRun,
  onCancelLiveRun,
  onTranslate,
  onResult,
  onFinished,
  onClose,
}: BatchTranslateDialogProps) {
  const [done, setDone] = useState(0);
  const [liveProgress, setLiveProgress] = useState<AiRunProgress | null>(null);
  const [currentKey, setCurrentKey] = useState<string | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const cancelRef = useRef(false);
  const runIdRef = useRef(createRunId());
  const liveRunPromiseRef = useRef<Promise<AiRunResult> | null>(null);
  const reportedRef = useRef(false);
  const startedAtRef = useRef(Date.now());
  const dialogRef = useRef<HTMLElement>(null);

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
    if (onCancelLiveRun && onLiveRun) {
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
      if (onLiveRun) {
        try {
          const unlisten = await listenAiRunProgress((event) => {
            if (!active || event.runId !== runId) return;
            setDone(event.completed);
            setLiveProgress(event);
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
        return;
      }

      let completed = 0;
      let failure: string | null = null;
      for (const item of items) {
        if (!active || cancelRef.current) break;
        setCurrentKey(item.key);
        try {
          const result = await onTranslate(item.source, item.section);
          await onResult(item, result.text);
          if (!active) return;
          completed += 1;
          setDone(completed);
        } catch (cause) {
          failure = String(cause);
          break;
        }
      }
      if (!active) return;
      finish({
        done: completed,
        total: items.length,
        outcome: failure
          ? "error"
          : completed === items.length
            ? "complete"
            : "cancelled",
        ...(failure ? { error: failure } : {}),
        engine: engine?.label ?? "Local AI",
        ...(engine?.model ? { model: engine.model } : {}),
        ...(engine?.reasoning ? { reasoning: engine.reasoning } : {}),
      });
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
  const indeterminate = Boolean(onLiveRun && !liveProgress);
  const phaseLabel = cancelRequested
    ? "Cancelling active batch"
    : liveProgress
      ? PHASE_LABELS[liveProgress.phase]
      : currentKey
        ? `Translating ${currentKey}`
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
                  ? `Cancelling the active AI batch; ${done} of ${total} suggestions saved to Review`
                  : indeterminate
                    ? `${total} selected strings are being prepared`
                    : `${done} of ${total} suggestions saved to Review; ${activityText.toLowerCase()}`
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
