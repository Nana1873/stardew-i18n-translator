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
  const [liveTotal, setLiveTotal] = useState<number | null>(null);
  const [hasLiveProgress, setHasLiveProgress] = useState(false);
  const [currentKey, setCurrentKey] = useState<string | null>(null);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const cancelRef = useRef(false);
  const runIdRef = useRef(createRunId());
  const liveRunPromiseRef = useRef<Promise<AiRunResult> | null>(null);
  const reportedRef = useRef(false);
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

  const { focusInitial, onDialogKeyDown } = useDialogAccessibility({
    dialogRef,
    onEscape: cancel,
  });

  useEffect(() => {
    const frame = requestAnimationFrame(focusInitial);
    return () => cancelAnimationFrame(frame);
  }, [focusInitial]);

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
            setLiveTotal(event.total);
            setHasLiveProgress(true);
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

  const total = liveTotal ?? items.length;
  const progress = total > 0 ? Math.round((done / total) * 100) : 0;
  const indeterminate = Boolean(onLiveRun && !hasLiveProgress);

  return (
    <div className="stv3-flow-overlay">
      <section
        ref={dialogRef}
        className="stv3-flow-dialog stv3-ai-progress-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="AI translation progress"
        onKeyDown={onDialogKeyDown}
      >
        <div className="stv3-flow-head">
          <div>
            <h2 className="stv3-heading">
              <Sparkles aria-hidden="true" />{" "}
              {cancelRequested
                ? "Cancelling…"
                : "Translating selected strings…"}
            </h2>
            <div className="stv3-kicker">
              {engine?.label ?? "AI"} · completed suggestions enter Review ·{" "}
              {modName}
            </div>
          </div>
        </div>

        <div className="stv3-flow-body">
          <div className="stv3-ai-count">
            <span>
              {currentKey ? (
                <>
                  Current: <code>{currentKey}</code>
                </>
              ) : (
                "Selected strings"
              )}
            </span>
            <strong>
              {done} / {total}
            </strong>
          </div>
          <div className="stv3-progress-row">
            <span
              role="progressbar"
              aria-label="AI translation progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={indeterminate ? undefined : progress}
              aria-valuetext={
                indeterminate
                  ? `${total} selected strings are being translated`
                  : `${done} of ${total} strings translated`
              }
              data-indeterminate={indeterminate ? "true" : undefined}
              style={
                {
                  "--stv3-batch-progress": `${indeterminate ? 35 : progress}%`,
                } as CSSProperties
              }
            />
          </div>
          {cancelError && (
            <div className="stv3-flow-callout is-error" role="alert">
              {cancelError}
            </div>
          )}
        </div>

        <div className="stv3-flow-foot">
          <button
            className="stv3-button stv3-button-quiet"
            type="button"
            onClick={cancel}
            disabled={cancelRequested}
            autoFocus
          >
            {cancelRequested ? "Cancelling…" : "Cancel"}
          </button>
        </div>
      </section>
    </div>
  );
}
