import type {
  AiRunProgress,
  AiRunPhase,
  AiRunRecovery,
} from "../tauri/commands";
import type { AiActivityMessage } from "../ui/activity";

export const AI_PHASE_LABELS: Record<AiRunPhase, string> = {
  preparing: "Preparing batch",
  translating: "Translating draft",
  reviewing: "Checking translation quality",
  terminologyRepair: "Checking terminology",
  tokenRepair: "Repairing protected tokens",
  saving: "Validating & saving",
};

const RECOVERY_LABELS: Record<AiRunRecovery, string> = {
  transientRetry: "Retrying temporary failure",
  structureRetry: "Retrying response structure",
  split: "Splitting affected batch",
};

function batchPrefix(progress: AiRunProgress) {
  // Aggregate provider events do not identify a batch in parallel snapshots.
  return progress.batchActivity === undefined &&
    (progress.activeBatches ?? 1) <= 1 &&
    progress.batchIndex !== undefined
    ? `Batch ${progress.batchIndex} · `
    : "";
}

export function describeCurrentActivity(progress: AiRunProgress) {
  const active = progress.batchActivity?.length ?? progress.activeBatches;
  if (active === 0) return "Finishing run";
  if (active !== undefined && active > 1) return `${active} batches active`;
  const batch = progress.batchActivity?.[0] ?? progress;
  return (
    (batch.batchIndex === undefined ? "" : `Batch ${batch.batchIndex} · `) +
    (batch.recovery
      ? RECOVERY_LABELS[batch.recovery]
      : AI_PHASE_LABELS[batch.phase]) +
    (batch.batchSize === undefined
      ? ""
      : ` · ${batch.batchSize} ${batch.batchSize === 1 ? "string" : "strings"}`)
  );
}

export function aiStepKey(
  runId: string,
  batchIndex: number | undefined,
  phase: AiRunPhase,
) {
  return `${runId}:${batchIndex ?? "run"}:${phase}`;
}

export function activeProgressSteps(progress: AiRunProgress) {
  if (progress.completed >= progress.total) return [];
  // A provider failure is not an active sequential step. Parallel provider
  // events have no batch identity; their explicit batch snapshots remain authoritative.
  if (
    progress.batchActivity === undefined &&
    progress.providerStage === "failed" &&
    !progress.recovery
  )
    return [];
  return (progress.batchActivity ?? [progress]).map((batch) =>
    aiStepKey(progress.runId, batch.batchIndex, batch.phase),
  );
}

/** Record actual step changes, not repeated streaming snapshots or text deltas. */
export function describeProgressChanges(
  previous: AiRunProgress | null,
  next: AiRunProgress,
) {
  const entries: AiActivityMessage[] = [];
  if (
    next.parallelLimit !== undefined &&
    next.parallelLimit !== previous?.parallelLimit
  ) {
    entries.push({
      message: `Parallel limit · up to ${next.parallelLimit} ${next.parallelLimit === 1 ? "batch" : "batches"}`,
    });
  }

  if (next.providerStage === "failed" && previous?.providerStage !== "failed") {
    entries.push({
      message: batchPrefix(next) + "Provider request failed",
      warning: true,
    });
  }

  const received = (next.translated ?? 0) - (previous?.translated ?? 0);
  if (received > 0) {
    entries.push({
      message: `${batchPrefix(next)}${received} ${received === 1 ? "draft" : "drafts"} received · ${next.translated} / ${next.total}`,
    });
  }

  const batches = next.batchActivity ?? [
    {
      batchIndex: next.batchIndex,
      phase: next.phase,
      batchSize: next.batchSize,
      recovery: next.recovery,
    },
  ];
  for (const batch of [...batches].sort(
    (a, b) => (a.batchIndex ?? 0) - (b.batchIndex ?? 0),
  )) {
    const before =
      previous?.batchActivity === undefined
        ? previous?.batchIndex === batch.batchIndex
          ? previous
          : undefined
        : previous.batchActivity.find(
            (entry) => entry.batchIndex === batch.batchIndex,
          );
    const prefix =
      batch.batchIndex === undefined ? "" : `Batch ${batch.batchIndex} · `;
    if (
      !before ||
      before.phase !== batch.phase ||
      before.batchSize !== batch.batchSize ||
      (before.recovery && !batch.recovery)
    ) {
      entries.push({
        message:
          prefix +
          AI_PHASE_LABELS[batch.phase] +
          (batch.batchSize === undefined
            ? ""
            : ` · ${batch.batchSize} ${batch.batchSize === 1 ? "string" : "strings"}`),
        aiStep: aiStepKey(next.runId, batch.batchIndex, batch.phase),
      });
    }
    if (batch.recovery && batch.recovery !== before?.recovery) {
      entries.push({
        message: prefix + RECOVERY_LABELS[batch.recovery],
        warning: true,
        aiStep: aiStepKey(next.runId, batch.batchIndex, batch.phase),
      });
    }
  }

  if (
    next.retries > (previous?.retries ?? 0) &&
    !entries.some((entry) => entry.warning)
  ) {
    entries.push({
      message: `Retry requested · ${next.retries} ${next.retries === 1 ? "retry" : "retries"} total`,
      warning: true,
    });
  }
  if (
    next.splits > (previous?.splits ?? 0) &&
    !entries.some((entry) => entry.message.includes(RECOVERY_LABELS.split))
  ) {
    entries.push({
      message: `Batch split requested · ${next.splits} ${next.splits === 1 ? "split" : "splits"} total`,
      warning: true,
    });
  }
  // Removing an active batch can also mean failure or cancellation. Only the
  // backend's persisted completion count can establish a save.
  const saved = next.completed - (previous?.completed ?? 0);
  if (saved > 0) {
    entries.push({
      message: `${batchPrefix(next)}${saved} ${saved === 1 ? "string" : "strings"} saved to Review`,
    });
  }
  return entries;
}
