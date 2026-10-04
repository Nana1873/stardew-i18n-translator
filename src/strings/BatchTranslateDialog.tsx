import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  listenAiRunProgress,
  type AiEngine,
  type AiRunProgress,
  type AiRunResult,
} from "../tauri/commands";
import {
  activeProgressSteps,
  aiStepKey,
  describeCurrentActivity,
  describeProgressChanges,
} from "./aiRunActivity";
import type { AiActivityMessage, AiActivityUpdate } from "../ui/activity";
import { WorkingDots } from "../ui/WorkingDots";
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

interface BatchTranslateDialogProps {
  items: BatchItem[];
  modName: string;
  engine?: LiveAiEngineOption;
  onLiveRun: (runId: string) => Promise<AiRunResult>;
  onCancelLiveRun?: (runId: string) => Promise<boolean>;
  onFinished: (result: BatchFinishedResult) => void;
  onClose: () => void;
}

export function BatchTranslateDialog(props: BatchTranslateDialogProps) {
  const [snapshot] = useState(props);
  return <AiRunProgressNotice {...snapshot} />;
}
function reportActivity(
  entries: AiActivityMessage[],
  activity?: Pick<AiActivityUpdate, "runId" | "activeSteps">,
) {
  if (!entries.length && !activity) return;
  window.dispatchEvent(
    new CustomEvent("translator-ai-activity", {
      detail: { time: Date.now(), entries, ...activity },
    }),
  );
}

function AiRunProgressNotice({
  items,
  modName,
  engine,
  onLiveRun,
  onCancelLiveRun,
  onFinished,
  onClose,
}: BatchTranslateDialogProps) {
  const runId = useRef(crypto.randomUUID());
  const runPromise = useRef<Promise<AiRunResult> | null>(null);
  const previous = useRef<AiRunProgress | null>(null);
  const started = useRef(false);
  const finished = useRef(false);
  const cancelling = useRef(false);
  const [progress, setProgress] = useState<AiRunProgress | null>(null);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [runFinished, setRunFinished] = useState(false);
  const noticeRef = useRef<HTMLElement>(null);

  function finish(result: BatchFinishedResult) {
    if (finished.current) return;
    finished.current = true;
    setRunFinished(true);
    reportActivity([], { runId: runId.current, activeSteps: [] });
    const restoreFocus = noticeRef.current?.contains(document.activeElement);
    onFinished(result);
    onClose();
    if (restoreFocus)
      window.dispatchEvent(new Event("translator-focus-filters"));
  }

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | null = null;
    void (async () => {
      try {
        const release = await listenAiRunProgress((event) => {
          if (!active || finished.current || event.runId !== runId.current)
            return;
          reportActivity(describeProgressChanges(previous.current, event), {
            runId: runId.current,
            activeSteps: cancelling.current ? [] : activeProgressSteps(event),
          });
          previous.current = event;
          setProgress(event);
        });
        if (!active) {
          release();
          return;
        }
        unlisten = release;
      } catch {
        // As in #254, the final command result is authoritative without events.
      }
      if (!active) return;
      if (!started.current) {
        started.current = true;
        reportActivity([
          {
            message: `AI translation started for ${modName}. ${engine?.label ?? "AI"}${engine?.model ? ` (${engine.model})` : ""}.`,
          },
          {
            message: "Preparing selected strings.",
            aiStep: aiStepKey(runId.current, undefined, "preparing"),
          },
        ]);
      }
      reportActivity([], {
        runId: runId.current,
        activeSteps:
          cancelling.current || finished.current
            ? []
            : previous.current
              ? activeProgressSteps(previous.current)
              : [aiStepKey(runId.current, undefined, "preparing")],
      });
      if (cancelling.current) {
        finish({
          runId: runId.current,
          done: previous.current?.completed ?? 0,
          total: items.length,
          outcome: "cancelled",
          engine: engine?.label ?? "AI",
          model: engine?.model,
          reasoning: engine?.reasoning,
        });
        return;
      }
      try {
        runPromise.current ??= onLiveRun(runId.current);
        const result = await runPromise.current;
        if (!active) return;
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
          runId: runId.current,
          done: previous.current?.completed ?? 0,
          total: items.length,
          outcome: "error",
          error: String(cause),
          engine: engine?.label ?? "AI",
          model: engine?.model,
          reasoning: engine?.reasoning,
        });
      }
    })();
    return () => {
      active = false;
      unlisten?.();
      reportActivity([], { runId: runId.current, activeSteps: [] });
    };
    // The selection and callbacks belong to one immutable run, as in #254.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function cancel() {
    if (cancelling.current || !onCancelLiveRun) return;
    cancelling.current = true;
    setCancelRequested(true);
    setCancelError(null);
    reportActivity([{ message: "AI translation cancellation requested." }], {
      runId: runId.current,
      activeSteps: [],
    });
    try {
      const accepted = await onCancelLiveRun(runId.current);
      if (!accepted && runPromise.current && !finished.current)
        throw new Error(
          "The cancellation request was not accepted. Try again.",
        );
    } catch (cause) {
      if (finished.current) return;
      const message = String(cause);
      cancelling.current = false;
      setCancelRequested(false);
      setCancelError(message);
      reportActivity([{ message, tone: "error" }], {
        runId: runId.current,
        activeSteps: previous.current
          ? activeProgressSteps(previous.current)
          : [aiStepKey(runId.current, undefined, "preparing")],
      });
    }
  }

  const total = progress?.total ?? items.length;
  const done = progress?.completed ?? 0;
  const phase = cancelRequested
    ? "Cancelling…"
    : progress
      ? describeCurrentActivity(progress)
      : "Preparing selected strings";
  const working =
    !cancelRequested &&
    !runFinished &&
    (!progress || activeProgressSteps(progress).length > 0);
  const target =
    document.getElementById("ai-progress-slot") ??
    document.getElementById("stardew-i18n-translator") ??
    document.body;
  if (!target) return null;
  return createPortal(
    <aside
      ref={noticeRef}
      className="desktop-ai-progress"
      aria-label="AI translation progress"
    >
      <div className="desktop-ai-progress-head">
        <strong>AI translation</strong>
        <span>{engine?.label ?? "AI"}</span>
        <button
          type="button"
          className="translator-button translator-button-quiet"
          aria-label="Cancel AI translation"
          onClick={() => void cancel()}
          disabled={cancelRequested || !onCancelLiveRun}
        >
          {cancelRequested ? "Cancelling…" : "Cancel"}
        </button>
      </div>
      <p className="desktop-ai-progress-scope" title={modName}>
        {modName}
      </p>
      <div className="desktop-ai-progress-count">
        <span>Saved to Review</span>
        <strong>
          {done} / {total}
        </strong>
      </div>
      <progress
        aria-label="Strings saved to Review"
        aria-valuetext={
          progress
            ? `${done} of ${total} suggestions saved to Review`
            : `${total} selected ${total === 1 ? "string is" : "strings are"} being prepared`
        }
        max={Math.max(1, total)}
        value={progress ? done : undefined}
      />
      <div className="desktop-ai-progress-phase" role="status">
        {phase}
        {working && <WorkingDots />}
      </div>
      {cancelError && (
        <p className="desktop-ai-progress-error" role="alert">
          {cancelError}
        </p>
      )}
    </aside>,
    target,
  );
}
