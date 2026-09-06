import { useEffect, useRef, useState } from "react";
import type { VortexInstalledFile } from "../tauri/commands";

/** Refresh only manager identities on return; deployed texts still require a scan. */
export function useVortexInventoryRefresh({
  enabled,
  blocked,
  workspaceKey,
  refresh,
  apply,
}: {
  enabled: boolean;
  blocked: boolean;
  workspaceKey: string;
  refresh: () => Promise<VortexInstalledFile[] | null>;
  apply: (files: VortexInstalledFile[]) => void;
}) {
  const callbacks = useRef({ refresh, apply });
  callbacks.current = { refresh, apply };
  const [warning, setWarning] = useState<string>();

  useEffect(() => {
    setWarning(undefined);
  }, [workspaceKey]);

  useEffect(() => {
    if (!enabled || blocked) return;
    let current = true;
    let inFlight = false;
    const check = async () => {
      if (inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        const files = await callbacks.current.refresh();
        if (!current) return;
        if (files == null) {
          setWarning(
            "Vortex's installation list could not be refreshed. Last verified installations are retained.",
          );
        } else {
          callbacks.current.apply(files);
          setWarning(undefined);
        }
      } catch {
        if (current)
          setWarning(
            "Vortex's installation list could not be refreshed. Last verified installations are retained.",
          );
      } finally {
        inFlight = false;
      }
    };
    const onReturn = () => void check();
    onReturn();
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      current = false;
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [enabled, blocked, workspaceKey]);

  return warning;
}
