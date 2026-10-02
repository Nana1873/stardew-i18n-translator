import type {
  AiRunProgress,
  AiRunPhase,
  AiRunRecovery,
} from "../tauri/commands";

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

/** Semantic snapshot changes only; provider streaming activity is shown in the run information. */
export function describeProgressChanges(
  previous: AiRunProgress | null,
  next: AiRunProgress,
) {
  const entries: { message: string; warning?: boolean }[] = [];
  if (
    next.parallelLimit !== undefined &&
    next.parallelLimit !== previous?.parallelLimit
  ) {
    entries.push({
      message: `Parallel limit · up to ${next.parallelLimit} ${next.parallelLimit === 1 ? "batch" : "batches"}`,
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
      before.batchSize !== batch.batchSize
    ) {
      entries.push({
        message:
          prefix +
          AI_PHASE_LABELS[batch.phase] +
          (batch.batchSize === undefined
            ? ""
            : ` · ${batch.batchSize} ${batch.batchSize === 1 ? "string" : "strings"}`),
      });
    }
    if (batch.recovery && batch.recovery !== before?.recovery) {
      entries.push({
        message: prefix + RECOVERY_LABELS[batch.recovery],
        warning: true,
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
      message: `${saved} ${saved === 1 ? "suggestion" : "suggestions"} saved to Review · ${next.completed} / ${next.total}`,
    });
  }
  return entries;
}
