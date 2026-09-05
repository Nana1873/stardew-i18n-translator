import { useEffect, useRef, useState } from "react";
import {
  nexusSourceComponents,
  nexusSourceDiskCoverage,
} from "./resolveTranslation";
import {
  nexusFindTranslations,
  type NexusSearchResult,
  type ScannedMod,
  type SkippedComponent,
} from "../tauri/commands";

export interface NexusSearchEntry {
  modId: number;
  localNames: string[];
  result?: NexusSearchResult;
  error?: string;
}
export interface NexusSearchState {
  entries: NexusSearchEntry[];
  running: boolean;
  completed: number;
  total: number;
  noId: number;
  skippedComplete: number;
  cancelled: boolean;
  stoppedReason?: string;
}
const emptyState = (): NexusSearchState => ({
  entries: [],
  running: false,
  completed: 0,
  total: 0,
  noId: 0,
  skippedComplete: 0,
  cancelled: false,
});

export function nexusSearchTargets(
  mods: ScannedMod[],
  includeComplete = false,
  retainIds: number[] = [],
  skippedComponents: SkippedComponent[] = [],
) {
  const targets = new Map<number, string[]>();
  let noId = 0;
  for (const mod of mods) {
    if (
      !mod.nexusId ||
      !Number.isSafeInteger(mod.nexusId) ||
      mod.nexusId <= 0
    ) {
      noId++;
      continue;
    }
    const names = targets.get(mod.nexusId) ?? [];
    if (!names.includes(mod.name)) names.push(mod.name);
    targets.set(mod.nexusId, names);
  }
  let skippedComplete = 0;
  for (const id of targets.keys()) {
    const components = nexusSourceComponents(mods, id);
    if (
      !includeComplete &&
      !retainIds.includes(id) &&
      nexusSourceDiskCoverage(mods, id, skippedComponents)?.complete
    ) {
      targets.delete(id);
      skippedComplete++;
    } else {
      targets.set(id, [...new Set(components.map((mod) => mod.name))]);
    }
  }
  return { targets, noId, skippedComplete };
}

export function useNexusSearch(workspaceKey: string) {
  const [state, setState] = useState<NexusSearchState>(emptyState);
  const generation = useRef(0);
  const context = useRef(workspaceKey);
  context.current = workspaceKey;
  useEffect(() => {
    generation.current++;
    setState(emptyState());
    return () => {
      generation.current++;
    };
  }, [workspaceKey]);

  function cancel() {
    generation.current++;
    setState((s) => ({ ...s, running: false, cancelled: true }));
  }

  function reset() {
    generation.current++;
    setState(emptyState());
  }

  async function start(
    mods: ScannedMod[],
    targetLang: string,
    options: {
      includeComplete?: boolean;
      forceRefresh?: boolean;
      retainIds?: number[];
      skippedComponents?: SkippedComponent[];
    } = {},
  ) {
    const run = ++generation.current;
    const key = context.current;
    const current = () => generation.current === run && context.current === key;
    const { targets, noId, skippedComplete } = nexusSearchTargets(
      mods,
      options.includeComplete,
      options.retainIds,
      options.skippedComponents,
    );
    setState({
      ...emptyState(),
      running: true,
      total: targets.size,
      noId,
      skippedComplete,
    });
    for (const [modId, localNames] of targets) {
      if (!current()) return;
      const entry: NexusSearchEntry = { modId, localNames };
      try {
        entry.result = await nexusFindTranslations(
          modId,
          targetLang,
          options.forceRefresh ?? false,
        );
        if (!current()) return;
      } catch (cause) {
        if (!current()) return;
        entry.error = String(cause);
      }
      setState((s) => ({
        ...s,
        completed: s.completed + 1,
        entries: [...s.entries, entry],
      }));
      if (
        entry.error &&
        /HTTP (401|429)\b|Configure NEXUS_API_KEY|Invalid Nexus API key format|Nexus API key validation failed/i.test(
          entry.error,
        )
      ) {
        setState((s) => ({
          ...s,
          running: false,
          stoppedReason:
            "Search stopped because Nexus access or the request limit needs attention. Partial results are retained. Check Nexus setup or retry later.",
        }));
        return;
      }
    }
    if (current()) setState((s) => ({ ...s, running: false }));
  }
  return { ...state, start, cancel, reset };
}
