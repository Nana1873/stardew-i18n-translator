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
  type LlmBatchItem,
  type LlmExportOutcome,
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
import { type BatchItem, BatchTranslateDialog } from "./BatchTranslateDialog";
import { LlmExportDialog } from "../llm-batch/LlmBatchDialog";
import { validate, worstSeverity } from "./validation";
import { STATUS_META, statusTint } from "./status";

interface Row extends StringRow {
  /** Originating i18n file (shown when a mod has more than one). */
  file: string;
}

type SortCol = "status" | "file" | "key" | "source" | "target";

/** One virtualized table line: a string row, or a section divider above a run
 * of rows that share a `// comment` section (SPEC §7.4). */
type DisplayItem =
  | { kind: "row"; row: Row; index: number; pos: number }
  | { kind: "section"; title: string; count: number };

function sortField(row: Row, col: SortCol): string {
  if (col === "status") return row.status;
  if (col === "file") return row.file;
  if (col === "key") return row.key;
  if (col === "source") return row.source;
  return row.target;
}

/** Working translated count, matching the scanner's count_keys: a non-empty
 * target counts (kept-original strings carry the source text, so they count). */
function countTranslated(rows: Row[]): number {
  return rows.filter((row) => row.target.trim() !== "").length;
}

/** Per-status row counts — drives the status-filter dropdown labels and the
 * needs-review tail in the header. */
function countByStatus(rows: Row[]): Record<StringStatus, number> {
  const counts: Record<StringStatus, number> = {
    untranslated: 0,
    translated: 0,
    outdated: 0,
    "review-needed": 0,
  };
  for (const row of rows) counts[row.status] += 1;
  return counts;
}

export function StringTable({
  mod,
  search = "",
  statusFilter = "all",
  glossary = null,
  onTranslate,
  onLlmBatchExport,
  onCountsChange,
  onClearFilters,
  reloadToken = 0,
}: {
  mod: ScannedMod;
  search?: string;
  statusFilter?: StringStatus | "all";
  glossary?: Record<string, string> | null;
  /** Reset search + status filter (the no-results escape hatch). */
  onClearFilters?: () => void;
  onTranslate?: (
    source: string,
    section?: string | null,
  ) => Promise<TranslationResult>;
  /** Export the given strings as an external LLM batch (M4); absent
   * when no target language is configured. Resolves null on picker cancel. */
  onLlmBatchExport?: (
    items: LlmBatchItem[],
  ) => Promise<LlmExportOutcome | null>;
  /** Reports the working translated-key count and per-status counts after
   * edits, so the mod list, header, and filter dropdown stay fresh without a
   * rescan. */
  onCountsChange?: (
    translatedKeys: number,
    byStatus: Record<StringStatus, number>,
  ) => void;
  /** Bump to force a reload from disk (e.g. after a batch import). */
  reloadToken?: number;
}) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editorSession, setEditorSession] = useState<{
    indices: number[];
    position: number;
    review: boolean;
  } | null>(null);
  const [selection, setSelection] = useState<Set<number>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [sort, setSort] = useState<{
    col: SortCol;
    dir: "asc" | "desc";
  } | null>(null);
  /** Items of a running batch AI translation (M6 Issue 17); null = no batch. */
  const [batch, setBatch] = useState<BatchItem[] | null>(null);
  /** Outcome (or failure) of an external LLM batch export (M4); null = closed. */
  const [llmBatchExport, setLlmBatchExport] = useState<{
    outcome: LlmExportOutcome | null;
    error: string | null;
  } | null>(null);
  const anchor = useRef<number | null>(null);
  const parentRef = useRef<HTMLDivElement>(null);
  // Current rows, readable from async batch callbacks without stale closures.
  const rowsRef = useRef<Row[] | null>(null);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  useEffect(() => {
    let active = true;
    setRows(null);
    setError(null);
    setSelection(new Set());
    setMenu(null);
    setEditorSession(null);
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
      if (active) {
        setRows(all);
        // Keep header/mod-list counts honest after a forced reload (a batch
        // import changes state on disk without going through saveRow).
        onCountsChange?.(countTranslated(all), countByStatus(all));
      }
    })().catch((cause) => {
      if (active) {
        setRows([]);
        setError(String(cause));
      }
    });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mod.uniqueId, mod.i18nFiles, reloadToken]);

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

  // Section dividers (SPEC §7.4): a non-selectable header above each run of
  // rows sharing a `// comment` section. Sorting scrambles the file order, so
  // dividers only show in the natural order; search/status filters keep them,
  // with live counts of the still-visible rows. `pos` is the row's position
  // in `visible`, which selection logic keeps using (dividers don't count).
  const display = useMemo<DisplayItem[]>(() => {
    const rows = visible.map((entry, pos) => ({
      kind: "row" as const,
      row: entry.row,
      index: entry.index,
      pos,
    }));
    if (sort) return rows;
    const out: DisplayItem[] = [];
    for (let i = 0; i < rows.length; i += 1) {
      const item = rows[i];
      const section = item.row.section ?? null;
      const prev = i > 0 ? rows[i - 1].row : null;
      const startsRun =
        section !== null &&
        (!prev ||
          (prev.section ?? null) !== section ||
          prev.file !== item.row.file);
      if (startsRun) {
        let count = 0;
        for (
          let j = i;
          j < rows.length &&
          (rows[j].row.section ?? null) === section &&
          rows[j].row.file === item.row.file;
          j += 1
        ) {
          count += 1;
        }
        out.push({ kind: "section", title: section!, count });
      }
      out.push(item);
    }
    return out;
  }, [visible, sort]);

  const virtualizer = useVirtualizer({
    count: display.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => (display[index]?.kind === "section" ? 26 : 30),
    overscan: 16,
  });

  // Size estimates are cached per position — re-measure when dividers
  // appear/disappear so 26px/30px rows stay aligned.
  useEffect(() => {
    virtualizer.measure();
  }, [display, virtualizer]);

  /** Ctrl+A / Cmd+A selects every currently visible row; Enter opens the
   * single selected row in the editor. */
  function onBodyKeyDown(event: ReactKeyboardEvent) {
    if (
      (event.ctrlKey || event.metaKey) &&
      (event.key === "a" || event.key === "A")
    ) {
      event.preventDefault();
      setSelection(new Set(visible.map((entry) => entry.index)));
    } else if (event.key === "Enter" && selection.size === 1) {
      event.preventDefault();
      openEditor([...selection][0] ?? null);
    }
  }

  function openEditor(dataIndex: number | null) {
    if (dataIndex === null) return;
    const indices = visible.map((entry) => entry.index);
    const position = indices.indexOf(dataIndex);
    if (position === -1) return;
    setEditorSession({
      indices,
      position,
      review: statusFilter === "review-needed",
    });
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
    onCountsChange?.(countTranslated(next), countByStatus(next));
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

  /** Apply a status to all selected rows. `write` picks the target text:
   * `keep` leaves it, `clear` empties it, `source` copies the original
   * ("Keep original" — an explicit identical translation, SPEC §9). One bulk
   * backend write — parallel per-string saves would race the per-mod state
   * file and lose updates. */
  async function applyStatus(
    status: StringStatus,
    write: "keep" | "clear" | "source",
  ) {
    const text = (r: Row) =>
      write === "clear" ? "" : write === "source" ? r.source : r.target;
    const indices = [...selection];
    const entries: SaveStringEntry[] = [];
    for (const i of indices) {
      const r = data[i];
      if (!r) continue;
      entries.push({
        relativeDir: r.file,
        key: r.key,
        target: text(r),
        status,
        source: r.source,
      });
    }
    await saveStrings(mod.uniqueId, entries);
    const touched = new Set(indices);
    const next = data.map((r, i) =>
      touched.has(i) ? { ...r, status, target: text(r) } : r,
    );
    setRows(next);
    onCountsChange?.(countTranslated(next), countByStatus(next));
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

  /** Selected rows the batch AI translation would process: only strings that
   * still need work (untranslated/outdated). Translated strings and unreviewed
   * AI suggestions are skipped — that also makes a re-run after a cancel
   * resume exactly where it stopped. */
  const batchEligible = [...selection]
    .sort((a, b) => a - b)
    .filter((i) => {
      const row = data[i];
      return (
        row && (row.status === "untranslated" || row.status === "outdated")
      );
    });

  function startBatch() {
    const items: BatchItem[] = batchEligible.map((i) => {
      const row = data[i]!;
      return {
        index: i,
        key: row.key,
        file: row.file,
        source: row.source,
        ...(row.section ? { section: row.section } : {}),
      };
    });
    setMenu(null);
    if (items.length > 0) setBatch(items);
  }

  /** Persist one batch result as an unreviewed AI suggestion. Functional row
   * update — the batch loop runs across many renders, so a captured `data`
   * snapshot would clobber earlier results. */
  async function applyBatchResult(item: BatchItem, text: string) {
    await saveString(
      mod.uniqueId,
      item.file,
      item.key,
      text,
      "review-needed",
      item.source,
    );
    setRows((current) =>
      current
        ? current.map((row, i) =>
            i === item.index
              ? {
                  ...row,
                  target: text,
                  status: "review-needed" as StringStatus,
                  targetPresent: true,
                }
              : row,
          )
        : current,
    );
  }

  function closeBatch() {
    setBatch(null);
    const current = rowsRef.current ?? [];
    onCountsChange?.(countTranslated(current), countByStatus(current));
  }

  /** Export the eligible selection as an external LLM batch (M4).
   * Same eligibility as the AI batch: only strings that still need work. */
  async function startLlmBatchExport() {
    const items: LlmBatchItem[] = batchEligible.map((i) => {
      const row = data[i]!;
      return {
        relativeDir: row.file,
        key: row.key,
        source: row.source,
        ...(row.section ? { section: row.section } : {}),
      };
    });
    setMenu(null);
    if (!onLlmBatchExport || items.length === 0) return;
    try {
      const outcome = await onLlmBatchExport(items);
      // null = the user cancelled the save dialog — nothing to report.
      if (outcome) setLlmBatchExport({ outcome, error: null });
    } catch (cause) {
      setLlmBatchExport({ outcome: null, error: String(cause) });
    }
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

  const editingIndex = editorSession
    ? editorSession.indices[editorSession.position]
    : null;
  const editingRow =
    editingIndex === null || editingIndex === undefined
      ? null
      : (data[editingIndex] ?? null);

  return (
    <div className={`stringtable${multiFile ? " stringtable--multifile" : ""}`}>
      <div className="stringrow stringrow--head">
        <SortHeader
          label="Status"
          col="status"
          sort={sort}
          onSort={toggleSort}
        />
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
          <div className="tableempty">
            <span className="tableempty__icon" aria-hidden>
              ⌕
            </span>
            <div className="tableempty__title">
              {search.trim() ? (
                <>
                  No strings match “<code>{search.trim()}</code>”
                </>
              ) : (
                "No strings match the current filter"
              )}
            </div>
            <div className="tableempty__sub">
              {statusFilter !== "all" && search.trim()
                ? `Try a different term, or clear the active ${STATUS_META[statusFilter].label.toLowerCase()} filter.`
                : statusFilter !== "all"
                  ? `No strings have the ${STATUS_META[statusFilter].label.toLowerCase()} status right now.`
                  : "Try a different search term."}
            </div>
            {onClearFilters && (
              <button
                type="button"
                className="tableempty__btn"
                onClick={onClearFilters}
              >
                Clear filters
              </button>
            )}
          </div>
        ) : (
          <div
            style={{ height: virtualizer.getTotalSize(), position: "relative" }}
          >
            {virtualizer.getVirtualItems().map((item) => {
              const entry = display[item.index];
              if (!entry) return null;
              if (entry.kind === "section") {
                return (
                  <div
                    key={`§ ${item.index} ${entry.title}`}
                    className="sectionrow"
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      right: 0,
                      height: item.size,
                      transform: `translateY(${item.start}px)`,
                    }}
                  >
                    <span className="sectionrow__title">// {entry.title}</span>
                    <span className="sectionrow__count">
                      Section · {entry.count}
                    </span>
                  </div>
                );
              }
              const dataIndex = entry.index;
              return (
                <RowView
                  key={`${entry.row.file} ${entry.row.key}`}
                  row={entry.row}
                  multiFile={multiFile}
                  selected={selection.has(dataIndex)}
                  top={item.start}
                  height={item.size}
                  onSelect={(event) => selectRow(dataIndex, entry.pos, event)}
                  onContextMenu={(event) =>
                    openMenu(dataIndex, entry.pos, event)
                  }
                  onOpen={() => openEditor(dataIndex)}
                />
              );
            })}
          </div>
        )}
      </div>
      <TableFooter byStatus={countByStatus(data)} />
      {editingRow && editingIndex !== null && editorSession && (
        <StringEditor
          row={editingRow}
          index={editorSession.position}
          total={editorSession.indices.length}
          modName={mod.name}
          reviewProgress={
            editorSession.review
              ? {
                  current: editorSession.position + 1,
                  total: editorSession.indices.length,
                }
              : undefined
          }
          glossary={glossary}
          onTranslate={onTranslate}
          onSave={(value, status) => void saveRow(editingIndex, value, status)}
          onClose={() => setEditorSession(null)}
          onNavigate={(delta) =>
            setEditorSession((current) => {
              if (!current) return current;
              const position = current.position + delta;
              return position >= 0 && position < current.indices.length
                ? { ...current, position }
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
                  openEditor([...selection][0] ?? null);
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
                onClick={() => void applyStatus("translated", "keep")}
              >
                Mark as translated
              </button>
            </li>
            <li>
              <button
                type="button"
                role="menuitem"
                title="Copy the original as the translation — names, commands, etc. stay English on purpose"
                onClick={() => void applyStatus("translated", "source")}
              >
                Keep original text
              </button>
            </li>
            <li>
              <button
                type="button"
                role="menuitem"
                onClick={() => void applyStatus("untranslated", "clear")}
              >
                Clear translation
              </button>
            </li>
            <li className="ctxmenu__sep" />
            <li>
              <button
                type="button"
                role="menuitem"
                disabled={!onTranslate || batchEligible.length === 0}
                title={
                  !onTranslate
                    ? "Configure a local AI in Settings"
                    : batchEligible.length === 0
                      ? "No untranslated or outdated strings selected"
                      : undefined
                }
                onClick={startBatch}
              >
                Translate missing with local AI
                {batchEligible.length > 0 ? ` (${batchEligible.length})` : ""}
              </button>
            </li>
            <li>
              <button
                type="button"
                role="menuitem"
                disabled={!onLlmBatchExport || batchEligible.length === 0}
                title={
                  !onLlmBatchExport
                    ? "Choose a target language first"
                    : batchEligible.length === 0
                      ? "No untranslated or outdated strings selected"
                      : "Write a translation batch for any external LLM"
                }
                onClick={() => void startLlmBatchExport()}
              >
                Export LLM batch
                {batchEligible.length > 0 ? ` (${batchEligible.length})` : ""}
              </button>
            </li>
          </ul>
        </>
      )}
      {llmBatchExport && (
        <LlmExportDialog
          outcome={llmBatchExport.outcome}
          error={llmBatchExport.error}
          modName={mod.name}
          onClose={() => setLlmBatchExport(null)}
        />
      )}
      {batch && onTranslate && (
        <BatchTranslateDialog
          items={batch}
          modName={mod.name}
          onTranslate={onTranslate}
          onResult={applyBatchResult}
          onClose={closeBatch}
        />
      )}
    </div>
  );
}

/** Footer status bar (SPEC §7.4): per-status counts + interaction hints.
 * Untranslated/translated always show; the exception statuses only when
 * present, so the bar stays calm on a finished mod. */
function TableFooter({ byStatus }: { byStatus: Record<StringStatus, number> }) {
  const order: StringStatus[] = [
    "untranslated",
    "translated",
    "review-needed",
    "outdated",
  ];
  return (
    <div className="stringtable__foot">
      {order.map((status) => {
        const count = byStatus[status];
        if (
          count === 0 &&
          status !== "untranslated" &&
          status !== "translated"
        ) {
          return null;
        }
        const meta = STATUS_META[status];
        return (
          <span key={status}>
            <b style={{ color: meta.color }}>{count}</b>{" "}
            {meta.label.toLowerCase()}
          </span>
        );
      })}
      <span className="stringtable__hint">
        Double-click or <kbd className="kbd">Enter</kbd> to edit ·{" "}
        <kbd className="kbd">Ctrl+A</kbd> select all
      </span>
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
  // Status = 3px left edge + glyph chip; selection adds a gold inset ring.
  // Both live in one inline box-shadow (inline would override CSS anyway).
  const edge = `inset 3px 0 0 ${status.edge}`;
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
        boxShadow: selected
          ? `${edge}, inset 0 0 0 1px rgba(227, 169, 78, 0.3)`
          : edge,
      }}
      title={status.label}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      onDoubleClick={onOpen}
    >
      <span className="stringrow__status">
        <span
          className="stringrow__glyph"
          aria-hidden
          style={{
            color: status.color,
            borderColor: statusTint(status.color, 0.45),
            backgroundColor: statusTint(status.color, 0.16),
          }}
        >
          {status.glyph}
        </span>
        <span className="stringrow__chip">{status.label}</span>
      </span>
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

/** Header strip above the table: counts + a hint. The coverage percentage
 * counts every working translation (it measures what export would write) —
 * the needs-review tail keeps it from hiding unreviewed AI suggestions, and
 * clicking it filters the table to exactly those strings. */
export function StringTableHeader({
  mod,
  onShowReview,
}: {
  mod: ScannedMod;
  /** Set the status filter to review-needed (clicking the amber tail). */
  onShowReview?: () => void;
}) {
  const summary = useMemo(
    () =>
      mod.totalKeys > 0
        ? `${mod.translatedKeys}/${mod.totalKeys} · ${Math.round(mod.progress * 100)}%`
        : "no strings",
    [mod],
  );
  const reviewNeeded = mod.statusCounts?.["review-needed"] ?? 0;
  return (
    <span className="panel__muted">
      {mod.name} · {summary}
      {reviewNeeded > 0 && (
        <>
          {" · "}
          <button
            type="button"
            className="panel__review"
            title="Show only strings that need review"
            onClick={onShowReview}
          >
            <span aria-hidden>⚑</span> {reviewNeeded} need review
          </button>
        </>
      )}
    </span>
  );
}
