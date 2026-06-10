/**
 * String table — M2 / Issues 7-10 (SPEC §7.4).
 *
 * Loads the selected mod's i18n strings (with saved translation state merged in
 * by the backend) and shows them in a virtualized table. Double-click opens the
 * editor; saving persists the target + status to disk via `save_string`, and the
 * row updates in place. A left status bar reflects each string's status.
 */
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type SaveStringEntry,
  type ScannedMod,
  type StringRow,
  type StringStatus,
  type TranslationResult,
  loadStrings,
  saveString,
  saveStrings,
} from "../tauri/commands";
import { StringEditor } from "./StringEditor";
import { validate, worstSeverity } from "./validation";
import { STATUS_META } from "./status";

interface Row extends StringRow {
  /** Originating i18n file (shown when a mod has more than one). */
  file: string;
}

type SortCol = "file" | "key" | "source" | "target";

function sortField(row: Row, col: SortCol): string {
  if (col === "file") return row.file;
  if (col === "key") return row.key;
  if (col === "source") return row.source;
  return row.target;
}

/** Working translated count, matching the scanner's count_keys: an explicit
 * not-translatable counts as handled, otherwise a non-empty target counts. */
function countTranslated(rows: Row[]): number {
  return rows.filter(
    (row) => row.status === "not-translatable" || row.target.trim() !== "",
  ).length;
}

export function StringTable({
  mod,
  search = "",
  statusFilter = "all",
  glossary = null,
  onTranslate,
  onCountsChange,
}: {
  mod: ScannedMod;
  search?: string;
  statusFilter?: StringStatus | "all";
  glossary?: Record<string, string> | null;
  onTranslate?: (source: string) => Promise<TranslationResult>;
  /** Reports the working translated-key count after edits, so the mod list
   * and header stay fresh without a rescan. */
  onCountsChange?: (translatedKeys: number) => void;
}) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [selection, setSelection] = useState<Set<number>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [sort, setSort] = useState<{
    col: SortCol;
    dir: "asc" | "desc";
  } | null>(null);
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
        for (const row of fileRows)
          all.push({ ...row, file: file.relativeDir });
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

  // The displayed (search + status filtered) subset, keeping each row's index
  // into `data` so selection/menu/editor keep operating on stable data indices.
  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    const out: Array<{ row: Row; index: number }> = [];
    data.forEach((row, index) => {
      if (statusFilter !== "all" && row.status !== statusFilter) return;
      if (query) {
        const hay = `${row.key}\n${row.source}\n${row.target}`.toLowerCase();
        if (!hay.includes(query)) return;
      }
      out.push({ row, index });
    });
    if (sort) {
      const dir = sort.dir === "asc" ? 1 : -1;
      out.sort(
        (a, b) =>
          sortField(a.row, sort.col).localeCompare(
            sortField(b.row, sort.col),
            undefined,
            {
              sensitivity: "base",
              numeric: true,
            },
          ) * dir,
      );
    }
    return out;
  }, [data, search, statusFilter, sort]);

  function toggleSort(col: SortCol) {
    setSort((prev) => {
      if (!prev || prev.col !== col) return { col, dir: "asc" };
      return prev.dir === "asc" ? { col, dir: "desc" } : null; // 3rd click clears
    });
    anchor.current = null;
  }

  // Changing the filter clears the (now possibly hidden) selection so bulk
  // actions never touch rows the user can't see.
  useEffect(() => {
    setSelection(new Set());
    setMenu(null);
    anchor.current = null;
  }, [search, statusFilter]);

  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 30,
    overscan: 16,
  });

  /** Ctrl+A / Cmd+A selects every currently visible row. */
  function onBodyKeyDown(event: ReactKeyboardEvent) {
    if (
      (event.ctrlKey || event.metaKey) &&
      (event.key === "a" || event.key === "A")
    ) {
      event.preventDefault();
      setSelection(new Set(visible.map((entry) => entry.index)));
    }
  }

  async function saveRow(index: number, target: string, status: StringStatus) {
    const row = data[index];
    if (!row) return;
    await saveString(
      mod.uniqueId,
      row.file,
      row.key,
      target,
      status,
      row.source,
    );
    const next = data.map((r, i) =>
      i === index ? { ...r, target, status, targetPresent: true } : r,
    );
    setRows(next);
    onCountsChange?.(countTranslated(next));
  }

  // `dataIndex` is the row's index into `data`; `pos` is its position in the
  // visible list (so Shift-range follows what the user sees, not hidden rows).
  function selectRow(dataIndex: number, pos: number, event: ReactMouseEvent) {
    if (event.shiftKey && anchor.current !== null) {
      const lo = Math.min(anchor.current, pos);
      const hi = Math.max(anchor.current, pos);
      const next = new Set<number>();
      for (let p = lo; p <= hi; p += 1) {
        const entry = visible[p];
        if (entry) next.add(entry.index);
      }
      setSelection(next);
    } else if (event.ctrlKey || event.metaKey) {
      setSelection((prev) => {
        const next = new Set(prev);
        if (next.has(dataIndex)) next.delete(dataIndex);
        else next.add(dataIndex);
        return next;
      });
      anchor.current = pos;
    } else {
      setSelection(new Set([dataIndex]));
      anchor.current = pos;
    }
  }

  function openMenu(dataIndex: number, pos: number, event: ReactMouseEvent) {
    event.preventDefault();
    setSelection((prev) => (prev.has(dataIndex) ? prev : new Set([dataIndex])));
    if (!selection.has(dataIndex)) anchor.current = pos;
    setMenu({ x: event.clientX, y: event.clientY });
  }

  /** Apply a status to all selected rows (optionally clearing the target).
   * One bulk backend write — parallel per-string saves would race the per-mod
   * state file and lose updates. */
  async function applyStatus(status: StringStatus, clearTarget: boolean) {
    const indices = [...selection];
    const entries: SaveStringEntry[] = [];
    for (const i of indices) {
      const r = data[i];
      if (!r) continue;
      entries.push({
        relativeDir: r.file,
        key: r.key,
        target: clearTarget ? "" : r.target,
        status,
        source: r.source,
      });
    }
    await saveStrings(mod.uniqueId, entries);
    const touched = new Set(indices);
    const next = data.map((r, i) =>
      touched.has(i)
        ? { ...r, status, target: clearTarget ? "" : r.target }
        : r,
    );
    setRows(next);
    onCountsChange?.(countTranslated(next));
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

  const editingRow =
    editingIndex === null ? null : (data[editingIndex] ?? null);

  return (
    <div className={`stringtable${multiFile ? " stringtable--multifile" : ""}`}>
      <div className="stringrow stringrow--head">
        {multiFile && (
          <SortHeader label="File" col="file" sort={sort} onSort={toggleSort} />
        )}
        <SortHeader label="Key" col="key" sort={sort} onSort={toggleSort} />
        <SortHeader
          label="Original"
          col="source"
          sort={sort}
          onSort={toggleSort}
        />
        <SortHeader
          label="Translation"
          col="target"
          sort={sort}
          onSort={toggleSort}
        />
        <span title="Validation" aria-label="Validation" />
      </div>
      <div
        ref={parentRef}
        className="stringtable__body"
        tabIndex={0}
        onKeyDown={onBodyKeyDown}
      >
        {visible.length === 0 ? (
          <div className="panel__empty">
            No strings match the current filter.
          </div>
        ) : (
          <div
            style={{ height: virtualizer.getTotalSize(), position: "relative" }}
          >
            {virtualizer.getVirtualItems().map((item) => {
              const entry = visible[item.index];
              if (!entry) return null;
              const dataIndex = entry.index;
              return (
                <RowView
                  key={`${entry.row.file} ${entry.row.key}`}
                  row={entry.row}
                  multiFile={multiFile}
                  selected={selection.has(dataIndex)}
                  top={item.start}
                  height={item.size}
                  onSelect={(event) => selectRow(dataIndex, item.index, event)}
                  onContextMenu={(event) =>
                    openMenu(dataIndex, item.index, event)
                  }
                  onOpen={() => setEditingIndex(dataIndex)}
                />
              );
            })}
          </div>
        )}
      </div>
      {editingRow && editingIndex !== null && (
        <StringEditor
          row={editingRow}
          index={editingIndex}
          total={data.length}
          modName={mod.name}
          glossary={glossary}
          onTranslate={onTranslate}
          onSave={(value, status) => void saveRow(editingIndex, value, status)}
          onClose={() => setEditingIndex(null)}
          onNavigate={(delta) =>
            setEditingIndex((current) => {
              if (current === null) return current;
              const pos = visible.findIndex((entry) => entry.index === current);
              if (pos === -1) return current;
              const next = pos + delta;
              return next >= 0 && next < visible.length
                ? visible[next].index
                : current;
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
          <ul
            className="ctxmenu"
            style={{ left: menu.x, top: menu.y }}
            role="menu"
          >
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
              <button
                type="button"
                role="menuitem"
                onClick={() => copySelection("source")}
              >
                Copy original
              </button>
            </li>
            <li>
              <button
                type="button"
                role="menuitem"
                onClick={() => copySelection("target")}
              >
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

function SortHeader({
  label,
  col,
  sort,
  onSort,
}: {
  label: string;
  col: SortCol;
  sort: { col: SortCol; dir: "asc" | "desc" } | null;
  onSort: (col: SortCol) => void;
}) {
  const active = sort?.col === col;
  const arrow = active ? (sort.dir === "asc" ? " ▲" : " ▼") : "";
  return (
    <button
      type="button"
      className={`stringrow__sort${active ? " stringrow__sort--active" : ""}`}
      aria-sort={
        active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"
      }
      onClick={() => onSort(col)}
    >
      {label}
      {arrow}
    </button>
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
        backgroundColor: selected
          ? "rgba(106, 176, 255, 0.30)"
          : `${status.color}24`,
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
