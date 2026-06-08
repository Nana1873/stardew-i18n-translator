/**
 * String table — M2 / Issues 7-10 (SPEC §7.4).
 *
 * Loads the selected mod's i18n strings (with saved translation state merged in
 * by the backend) and shows them in a virtualized table. Double-click opens the
 * editor; saving persists the target + status to disk via `save_string`, and the
 * row updates in place. A left status bar reflects each string's status.
 */
import {
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type ScannedMod,
  type StringRow,
  type StringStatus,
  loadStrings,
  saveString,
} from "../tauri/commands";
import { StringEditor } from "./StringEditor";
import { validate, worstSeverity } from "./validation";
import { STATUS_META } from "./status";

interface Row extends StringRow {
  /** Originating i18n file (shown when a mod has more than one). */
  file: string;
}

export function StringTable({ mod }: { mod: ScannedMod }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [selection, setSelection] = useState<Set<number>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const anchor = useRef<number | null>(null);
  const parentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    setRows(null);
    setError(null);
    setSelection(new Set());
    setMenu(null);
    (async () => {
      const all: Row[] = [];
      for (const file of mod.i18nFiles) {
        const fileRows = await loadStrings(
          mod.uniqueId,
          file.relativeDir,
          file.defaultPath,
          file.targetPath,
        );
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
  }, [mod.uniqueId, mod.i18nFiles]);

  const multiFile = mod.i18nFiles.length > 1;
  const data = rows ?? [];
  const virtualizer = useVirtualizer({
    count: data.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 30,
    overscan: 16,
  });

  async function saveRow(index: number, target: string, status: StringStatus) {
    const row = data[index];
    if (!row) return;
    await saveString(mod.uniqueId, row.file, row.key, target, status, row.source);
    setRows((current) =>
      current
        ? current.map((r, i) => (i === index ? { ...r, target, status, targetPresent: true } : r))
        : current,
    );
  }

  function selectRow(index: number, event: ReactMouseEvent) {
    if (event.shiftKey && anchor.current !== null) {
      const lo = Math.min(anchor.current, index);
      const hi = Math.max(anchor.current, index);
      const next = new Set<number>();
      for (let i = lo; i <= hi; i += 1) next.add(i);
      setSelection(next);
    } else if (event.ctrlKey || event.metaKey) {
      setSelection((prev) => {
        const next = new Set(prev);
        if (next.has(index)) next.delete(index);
        else next.add(index);
        return next;
      });
      anchor.current = index;
    } else {
      setSelection(new Set([index]));
      anchor.current = index;
    }
  }

  function openMenu(index: number, event: ReactMouseEvent) {
    event.preventDefault();
    setSelection((prev) => (prev.has(index) ? prev : new Set([index])));
    if (!selection.has(index)) anchor.current = index;
    setMenu({ x: event.clientX, y: event.clientY });
  }

  /** Apply a status to all selected rows (optionally clearing the target). */
  async function applyStatus(status: StringStatus, clearTarget: boolean) {
    const indices = [...selection];
    await Promise.all(
      indices.map((i) => {
        const r = data[i];
        if (!r) return Promise.resolve();
        return saveString(
          mod.uniqueId,
          r.file,
          r.key,
          clearTarget ? "" : r.target,
          status,
          r.source,
        );
      }),
    );
    const touched = new Set(indices);
    setRows((current) =>
      current
        ? current.map((r, i) =>
            touched.has(i) ? { ...r, status, target: clearTarget ? "" : r.target } : r,
          )
        : current,
    );
    setMenu(null);
  }

  function copySelection(field: "source" | "target") {
    const text = [...selection]
      .sort((a, b) => a - b)
      .map((i) => data[i]?.[field] ?? "")
      .join("\n");
    void navigator.clipboard?.writeText(text);
    setMenu(null);
  }

  if (rows === null) {
    return <div className="panel__empty">Loading strings…</div>;
  }
  if (error) {
    return <div className="panel__empty">{error}</div>;
  }
  if (data.length === 0) {
    return <div className="panel__empty">No translatable strings.</div>;
  }

  const editingRow = editingIndex === null ? null : (data[editingIndex] ?? null);

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
          {virtualizer.getVirtualItems().map((item) => (
            <RowView
              key={item.key}
              row={data[item.index]}
              multiFile={multiFile}
              selected={selection.has(item.index)}
              top={item.start}
              height={item.size}
              onSelect={(event) => selectRow(item.index, event)}
              onContextMenu={(event) => openMenu(item.index, event)}
              onOpen={() => setEditingIndex(item.index)}
            />
          ))}
        </div>
      </div>
      {editingRow && editingIndex !== null && (
        <StringEditor
          row={editingRow}
          index={editingIndex}
          total={data.length}
          modName={mod.name}
          onSave={(value, status) => void saveRow(editingIndex, value, status)}
          onClose={() => setEditingIndex(null)}
          onNavigate={(delta) =>
            setEditingIndex((current) => {
              if (current === null) return current;
              const next = current + delta;
              return next >= 0 && next < data.length ? next : current;
            })
          }
        />
      )}
      {menu && (
        <>
          <div
            className="ctxmenu__scrim"
            onMouseDown={() => setMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu(null);
            }}
          />
          <ul className="ctxmenu" style={{ left: menu.x, top: menu.y }} role="menu">
            {selection.size > 1 && (
              <li className="ctxmenu__count">{selection.size} selected</li>
            )}
            <li>
              <button
                type="button"
                role="menuitem"
                disabled={selection.size !== 1}
                onClick={() => {
                  setEditingIndex([...selection][0] ?? null);
                  setMenu(null);
                }}
              >
                Edit string
              </button>
            </li>
            <li>
              <button type="button" role="menuitem" onClick={() => copySelection("source")}>
                Copy original
              </button>
            </li>
            <li>
              <button type="button" role="menuitem" onClick={() => copySelection("target")}>
                Copy translation
              </button>
            </li>
            <li className="ctxmenu__sep" />
            <li>
              <button
                type="button"
                role="menuitem"
                onClick={() => void applyStatus("translated", false)}
              >
                Mark as translated
              </button>
            </li>
            <li>
              <button
                type="button"
                role="menuitem"
                onClick={() => void applyStatus("not-translatable", false)}
              >
                Mark as not translatable
              </button>
            </li>
            <li>
              <button
                type="button"
                role="menuitem"
                onClick={() => void applyStatus("untranslated", true)}
              >
                Clear translation
              </button>
            </li>
          </ul>
        </>
      )}
    </div>
  );
}

interface RowViewProps {
  row: Row;
  multiFile: boolean;
  selected: boolean;
  top: number;
  height: number;
  onSelect: (event: ReactMouseEvent) => void;
  onContextMenu: (event: ReactMouseEvent) => void;
  onOpen: () => void;
}

function RowView({
  row,
  multiFile,
  selected,
  top,
  height,
  onSelect,
  onContextMenu,
  onOpen,
}: RowViewProps) {
  const issues = validate(row.source, row.target, row.targetPresent);
  const severity = worstSeverity(issues);
  const status = STATUS_META[row.status];
  return (
    <div
      className={`stringrow stringrow--data${selected ? " stringrow--selected" : ""}`}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        height,
        transform: `translateY(${top}px)`,
        boxShadow: `inset 3px 0 0 ${status.color}`,
        backgroundColor: selected ? "rgba(106, 176, 255, 0.30)" : `${status.color}24`,
      }}
      title={status.label}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      onDoubleClick={onOpen}
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
      <span className="stringrow__val">
        {severity && (
          <span
            className={`val val--${severity}`}
            title={issues.map((issue) => issue.message).join("\n")}
          >
            ●
          </span>
        )}
      </span>
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
