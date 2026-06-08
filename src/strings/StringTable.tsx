/**
 * String table — M2 / Issue 7 (SPEC §7.4).
 *
 * Loads the selected mod's i18n strings and shows them in a virtualized table
 * (Key | Original | Translation | Validation). Built for very large files
 * (Ridgeside [CP] ≈ 17.5k keys) via row virtualization. Read-only for now —
 * the editor dialog, validation, and status come in later M2 issues.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { type ScannedMod, type StringRow, loadStrings } from "../tauri/commands";

interface Row extends StringRow {
  /** Originating i18n file (shown when a mod has more than one). */
  file: string;
}

export function StringTable({ mod }: { mod: ScannedMod }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const parentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    setRows(null);
    setError(null);
    (async () => {
      const all: Row[] = [];
      for (const file of mod.i18nFiles) {
        const fileRows = await loadStrings(file.defaultPath, file.targetPath);
        for (const row of fileRows) all.push({ ...row, file: file.relativeDir });
      }
      if (active) setRows(all);
    })().catch((cause) => {
      if (active) {
        setRows([]);
        setError(String(cause));
      }
    });
    return () => {
      active = false;
    };
  }, [mod.i18nFiles]);

  const multiFile = mod.i18nFiles.length > 1;
  const data = rows ?? [];
  const virtualizer = useVirtualizer({
    count: data.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 30,
    overscan: 16,
  });

  if (rows === null) {
    return <div className="panel__empty">Loading strings…</div>;
  }
  if (error) {
    return <div className="panel__empty">{error}</div>;
  }
  if (data.length === 0) {
    return <div className="panel__empty">No translatable strings.</div>;
  }

  return (
    <div className={`stringtable${multiFile ? " stringtable--multifile" : ""}`}>
      <div className="stringrow stringrow--head">
        {multiFile && <span>File</span>}
        <span>Key</span>
        <span>Original</span>
        <span>Translation</span>
        <span title="Validation" aria-label="Validation" />
      </div>
      <div ref={parentRef} className="stringtable__body">
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = data[item.index];
            return (
              <div
                key={item.key}
                className="stringrow stringrow--data"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  height: item.size,
                  transform: `translateY(${item.start}px)`,
                }}
              >
                {multiFile && (
                  <span className="stringrow__file" title={row.file}>
                    {row.file}
                  </span>
                )}
                <span className="stringrow__key" title={row.key}>
                  {row.key}
                </span>
                <span className="stringrow__src" title={row.source}>
                  {row.source}
                </span>
                <span
                  className={`stringrow__tgt${row.target ? "" : " stringrow__tgt--empty"}`}
                  title={row.target}
                >
                  {row.target || "—"}
                </span>
                <span className="stringrow__val" />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Header strip above the table: counts + a hint. */
export function StringTableHeader({ mod }: { mod: ScannedMod }) {
  const summary = useMemo(
    () =>
      mod.totalKeys > 0
        ? `${mod.translatedKeys}/${mod.totalKeys} · ${Math.round(mod.progress * 100)}%`
        : "no strings",
    [mod],
  );
  return (
    <span className="panel__muted">
      {mod.name} · {summary}
    </span>
  );
}
