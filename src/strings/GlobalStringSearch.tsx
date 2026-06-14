import { useEffect, useMemo, useState } from "react";
import {
  loadStrings,
  type ScannedMod,
  type StringRow,
} from "../tauri/commands";

interface GlobalStringRow extends StringRow {
  modUniqueId: string;
  modName: string;
  file: string;
}

const RESULT_LIMIT = 200;

export function GlobalStringSearch({
  mods,
  query,
  onOpenMod,
}: {
  mods: ScannedMod[];
  query: string;
  onOpenMod: (uniqueId: string) => void;
}) {
  const [rows, setRows] = useState<GlobalStringRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setRows(null);
    setError(null);

    (async () => {
      const loaded: GlobalStringRow[] = [];
      for (const mod of mods) {
        for (const file of mod.i18nFiles) {
          const fileRows = await loadStrings(
            mod.uniqueId,
            file.relativeDir,
            file.defaultPath,
            file.targetPath,
          );
          for (const row of fileRows) {
            loaded.push({
              ...row,
              modUniqueId: mod.uniqueId,
              modName: mod.name,
              file: file.relativeDir,
            });
          }
        }
      }
      if (active) setRows(loaded);
    })().catch((cause) => {
      if (active) {
        setRows([]);
        setError(String(cause));
      }
    });

    return () => {
      active = false;
    };
  }, [mods]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle || !rows) return [];
    return rows.filter((row) =>
      `${row.key}\n${row.source}\n${row.target}`.toLowerCase().includes(needle),
    );
  }, [query, rows]);

  if (rows === null) {
    return <div className="panel__empty">Searching all scanned mods...</div>;
  }
  if (error) {
    return <div className="panel__empty">{error}</div>;
  }
  if (matches.length === 0) {
    return (
      <div className="tableempty">
        <span className="tableempty__icon" aria-hidden>
          ⌕
        </span>
        <div className="tableempty__title">
          No strings match "<code>{query.trim()}</code>"
        </div>
        <div className="tableempty__sub">
          Searched keys, originals, and translations across {mods.length} mods.
        </div>
      </div>
    );
  }

  const visible = matches.slice(0, RESULT_LIMIT);
  return (
    <div className="global-search">
      <div className="global-search__summary">
        {matches.length} {matches.length === 1 ? "match" : "matches"} across{" "}
        {mods.length} mods
        {matches.length > RESULT_LIMIT
          ? ` · showing first ${RESULT_LIMIT}`
          : ""}
      </div>
      <div className="global-search__results">
        {visible.map((row) => (
          <button
            type="button"
            className="global-search__result"
            key={`${row.modUniqueId}\n${row.file}\n${row.key}`}
            onClick={() => onOpenMod(row.modUniqueId)}
          >
            <span className="global-search__context">
              <strong>{row.modName}</strong>
              <span>{row.file}</span>
            </span>
            <code>{row.key}</code>
            <span title={row.source}>{row.source}</span>
            <span
              className={row.target ? "" : "global-search__empty"}
              title={row.target}
            >
              {row.target || "—"}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
