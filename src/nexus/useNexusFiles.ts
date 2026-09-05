import { useEffect, useRef, useState } from "react";
import { nexusListFiles, type NexusFile } from "../tauri/commands";
import {
  selectTranslationFile,
  translationFileOptions,
} from "./resolveTranslation";

export interface NexusFiles {
  files?: NexusFile[];
  error?: string;
}

/** Keep eligible versions available; recommendations use the existing metadata rules. */
export function fileChoices(
  files: NexusFile[],
  language: string,
  vortex: boolean,
) {
  const purpose = vortex ? "vortex" : "review";
  const eligible = translationFileOptions(files, language, purpose);
  const recommendation = selectTranslationFile(files, language, purpose);
  return {
    files: eligible,
    recommended:
      recommendation.kind === "selected" ? recommendation.file.fileId : null,
  };
}

/** Metadata only. Outstanding native calls count toward the limit even after cancellation. */
export function useNexusFiles(ids: number[], open: boolean, context: string) {
  const [entries, setEntries] = useState<Record<number, NexusFiles>>({});
  const cache = useRef<Record<number, NexusFiles>>({});
  const desired = useRef<number[]>([]);
  const scope = useRef({ context, open, epoch: 0 });
  const running = useRef(new Map<number, symbol>());
  const alive = useRef(true);
  const signature = [...new Set(ids)].join(",");

  function pump() {
    if (!alive.current || !scope.current.open) return;
    for (const id of desired.current) {
      if (running.current.size >= 2) break;
      if (cache.current[id] || running.current.has(id)) continue;
      const token = Symbol();
      const epoch = scope.current.epoch;
      running.current.set(id, token);
      void nexusListFiles(id)
        .then(
          (files) => ({ files }),
          (cause) => ({ error: String(cause) }),
        )
        .then((result) => {
          if (
            alive.current &&
            scope.current.open &&
            scope.current.epoch === epoch &&
            desired.current.includes(id)
          ) {
            cache.current[id] = result;
            setEntries({ ...cache.current });
          }
        })
        .finally(() => {
          if (running.current.get(id) === token) running.current.delete(id);
          pump();
        });
    }
  }

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      scope.current.epoch++;
    };
  }, []);
  useEffect(() => {
    if (scope.current.context !== context) cache.current = {};
    if (scope.current.context !== context || scope.current.open !== open)
      scope.current.epoch++;
    scope.current.context = context;
    scope.current.open = open;
    desired.current = signature ? signature.split(",").map(Number) : [];
    setEntries({ ...cache.current });
    pump();
  }, [signature, open, context]);

  function refresh() {
    scope.current.epoch++;
    cache.current = {};
    setEntries({});
    pump();
  }
  return { entries, refresh };
}
