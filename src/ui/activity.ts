import type { OperationHistoryEntry } from "../tauri/commands";
import type { ResultTrayData } from "../results/ResultTray";

export type ActivityTone = "info" | "success" | "warning" | "error";
export interface NoticeOptions {
  /** Routine clipboard/selection feedback needs only a toast. */
  activity?: boolean;
}
export interface ManualSaveActivity {
  identity: string;
  modUniqueId: string;
  modName: string;
  key: string;
  acceptedMismatch: boolean;
}
export type ActivityDetails =
  | { kind: "operation"; entry: OperationHistoryEntry }
  | { kind: "result"; data: ResultTrayData }
  | { kind: "scan"; time: number };
export type ActivityEvent =
  | { kind: "save"; save: ManualSaveActivity }
  | {
      kind: "message";
      message: string;
      tone: ActivityTone;
      details?: ActivityDetails;
    };
export interface ActivityEntry {
  id: number;
  time: number;
  message: string;
  tone: ActivityTone;
  details?: ActivityDetails;
  saves?: { modUniqueId: string; identities: string[] };
}
export interface ActivityBuffer {
  entries: ActivityEntry[];
  omitted: number;
}

export function reportActivity(event: ActivityEvent) {
  window.dispatchEvent(
    new CustomEvent("translator-activity", {
      detail: { event, time: Date.now() },
    }),
  );
}

/** Keep a bounded session log, protecting the latest 100 warnings/errors
 * from being displaced by routine batch progress. Preserve chronological order. */
export function appendActivity(
  buffer: ActivityBuffer,
  event: ActivityEvent,
  time: number,
  id: number,
): ActivityBuffer {
  const entries = [...buffer.entries];
  if (event.kind === "save") {
    const save = event.save;
    const previous = entries.at(-1);
    if (
      !save.acceptedMismatch &&
      previous?.saves &&
      previous.saves.modUniqueId === save.modUniqueId &&
      time - previous.time >= 0 &&
      time - previous.time <= 5000
    ) {
      const identities = [
        ...new Set([...previous.saves.identities, save.identity]),
      ];
      entries[entries.length - 1] = {
        ...previous,
        time,
        message: `${identities.length} ${identities.length === 1 ? "translation" : "translations"} saved · ${save.modName}`,
        saves: { modUniqueId: save.modUniqueId, identities },
      };
    } else {
      entries.push({
        id,
        time,
        tone: save.acceptedMismatch ? "warning" : "success",
        message: save.acceptedMismatch
          ? `Translation saved · ${save.modName} · ${save.key} · Token mismatch accepted; export allowed.`
          : `1 translation saved · ${save.modName}`,
        ...(save.acceptedMismatch
          ? {}
          : {
              saves: {
                modUniqueId: save.modUniqueId,
                identities: [save.identity],
              },
            }),
      });
    }
  } else {
    entries.push({
      id,
      time,
      message: event.message,
      tone: event.tone,
      details: event.details,
    });
  }
  let omitted = buffer.omitted;
  while (entries.length > 500) {
    const attention = entries.filter(
      (entry) => entry.tone === "warning" || entry.tone === "error",
    );
    const protectedIds = new Set(
      attention.slice(-100).map((entry) => entry.id),
    );
    const index = entries.findIndex((entry) => !protectedIds.has(entry.id));
    entries.splice(index, 1);
    omitted += 1;
  }
  return { entries, omitted };
}

export function operationActivity(
  entry: OperationHistoryEntry,
  modNames: ReadonlyMap<string, string>,
): ActivityEvent {
  const components = entry.details.filter(
    (detail) => detail.label === "Component",
  );
  const context = components.length
    ? components
        .map((detail) => modNames.get(detail.value) ?? detail.value)
        .join(", ")
    : (entry.details.find((detail) => detail.label === "Scope")?.value ??
      entry.fileName);
  const counts = entry.details
    .filter(
      (detail) =>
        (entry.kind === "import" &&
          ["Local translations preserved", "Skipped empty values"].includes(
            detail.label,
          )) ||
        (entry.kind === "export" && detail.label === "Strings written"),
    )
    .map((detail) => `${detail.label}: ${detail.value}`);
  const outcome = entry.outcome === "success" ? "" : ` · ${entry.outcome}`;
  return {
    kind: "message",
    message: `${entry.title}${context ? ` · ${context}` : ""}${outcome}: ${entry.summary}${counts.length ? ` ${counts.join(" · ")}.` : ""}`,
    tone:
      entry.outcome === "failed"
        ? "error"
        : entry.outcome === "success"
          ? "success"
          : "warning",
    details: { kind: "operation", entry: { ...entry, canUndo: false } },
  };
}
