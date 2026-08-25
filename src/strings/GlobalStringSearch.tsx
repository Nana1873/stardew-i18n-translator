/**
 * Backwards-compatible all-mod search entrypoint.
 *
 * V3 deliberately has one string workbench rather than a second search-only
 * table. The shell can migrate to StringTable directly; this wrapper keeps the
 * existing call site and tests on the same real, virtualized implementation.
 */
import type { ScannedMod } from "../tauri/commands";
import { StringTable } from "./StringTable";

export function GlobalStringSearch({
  mods,
  query,
  onOpenMod,
}: {
  mods: ScannedMod[];
  query: string;
  onOpenMod: (uniqueId: string) => void;
}) {
  return (
    <StringTable
      mod={null}
      mods={mods}
      scope="all"
      search={query}
      onOpenMod={onOpenMod}
    />
  );
}
