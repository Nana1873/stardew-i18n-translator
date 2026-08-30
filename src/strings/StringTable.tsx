/**
 * Primary string workbench.
 *
 * One virtualized grid serves both the selected-mod and all-mod scopes. Every
 * row is backed by load_strings data; selection is keyed by mod/file/key so
 * sorting and virtual-window changes never retarget a command.
 */
import {
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDown,
  ArrowUp,
  CircleCheck,
  Copy,
  CopyCheck,
  ChevronsUpDown,
  Eraser,
  Equal,
  FileJson,
  ListChecks,
  MoreHorizontal,
  Pencil,
  SearchX,
  Sparkles,
} from "lucide-react";
import {
  type AiEngine,
  type AiRunResult,
  type AiTranslationRequest,
  type GlossaryEntry,
  type LlmBatchItem,
  type LlmExportOutcome,
  type OperationHistoryEntry,
  type SaveStringEntry,
  type ScanStringIdentity,
  type ScannedMod,
  type StringRow,
  type StringStatus,
  loadStrings,
  saveString,
  saveStringGroupsWithUndo,
} from "../tauri/commands";
import {
  type EditorSuggestionProvenance,
  type EditorTranslationResult,
  StringEditor,
} from "./StringEditor";
import {
  type BatchItem,
  BatchTranslateDialog,
  type LiveAiEngineOption,
} from "./BatchTranslateDialog";
import { validate, worstSeverity } from "./validation";
import {
  DEFAULT_SHORTCUTS,
  type ResolvedShortcuts,
  displayShortcut,
  matchesShortcut,
} from "../shortcuts";

export type StringTableScope = "mod" | "all";
export type StringTableFilter = StringStatus | "all" | "has-value";
export type StringTableNoticeTone = "info" | "success" | "error";

export interface StringTableSummary {
  visible: number;
  total: number;
  issues: number;
}

export interface AiBatchFinishedResult {
  runId?: string;
  outcome: "complete" | "cancelled" | "error";
  done: number;
  total: number;
  error?: string;
  engine: string;
  model?: string;
  reasoning?: string;
  modName: string;
  modUniqueIds: string[];
}

interface Row extends StringRow {
  modUniqueId: string;
  modName: string;
  packageId: string;
  file: string;
}

const MAX_LIVE_AI_SOURCE_BYTES = 64 * 1024;
const utf8Encoder = new TextEncoder();

function isLiveAiSourceEligible(source: string): boolean {
  return (
    source.length > 0 &&
    !source.includes("\0") &&
    utf8Encoder.encode(source).byteLength <= MAX_LIVE_AI_SOURCE_BYTES
  );
}

type SortCol = "mod" | "file" | "status" | "key" | "source" | "target";
type ColumnName = SortCol;

export interface StringTableSort {
  col: SortCol;
  dir: "asc" | "desc";
}

export type StringTableColumnWidths = Record<ColumnName, number>;

type DisplayItem =
  | { kind: "row"; row: Row; identity: string; index: number; pos: number }
  | { kind: "section"; title: string };

interface EditorSession {
  identities: string[];
  position: number;
  review: boolean;
}

interface ContextMenuState {
  x: number;
  y: number;
  returnIdentity: string;
  returnElement: HTMLElement | null;
}

interface BatchFinishedResult {
  runId?: string;
  done: number;
  total: number;
  outcome: "complete" | "cancelled" | "error";
  error?: string;
  engine?: string;
  model?: string;
  reasoning?: string;
}

interface StatusTooltipState {
  text: string;
  left: number;
  top: number;
  anchorCenter: number;
  anchorTop: number;
  anchorBottom: number;
}

export interface SavedStringSnapshot {
  modUniqueId: string;
  relativeDir: string;
  key: string;
  source: string;
  target: string;
  targetPresent: boolean;
  tokenMismatchAccepted: boolean;
}

export interface StringTableProps {
  mod: ScannedMod | null;
  mods?: ScannedMod[];
  scope?: StringTableScope;
  onScopeChange?: (scope: StringTableScope) => void;
  /** Optional exact, transient subset opened from the latest scan result. */
  identityFilter?: readonly ScanStringIdentity[];
  identityFilterLabel?: string;
  search?: string;
  onSearchChange?: (value: string) => void;
  statusFilter?: StringTableFilter;
  onStatusFilterChange?: (value: StringTableFilter) => void;
  issuesOnly?: boolean;
  onIssuesOnlyChange?: (value: boolean) => void;
  initialSort?: StringTableSort | null;
  onSortChange?: (sort: StringTableSort | null) => void;
  initialColumnWidths?: Partial<StringTableColumnWidths>;
  onColumnWidthsChange?: (widths: StringTableColumnWidths) => void;
  /** Real shell-provided heading text; defaults to the active ScannedMod. */
  headerTitle?: string;
  /** Real package/parent context shown before the heading. */
  headerContext?: string | null;
  /** Additional real metadata (for example scan age); omitted when unknown. */
  headerMeta?: string | readonly string[];
  targetLanguageLabel?: string;
  targetLanguageCode?: string;
  localAiModel?: string;
  glossary?: GlossaryEntry[] | null;
  onClearFilters?: () => void;
  liveAiEngines?: LiveAiEngineOption[];
  defaultAiEngine?: AiEngine;
  onRunAi?: (
    engine: AiEngine,
    request: AiTranslationRequest,
  ) => Promise<AiRunResult>;
  onCancelAi?: (runId: string) => Promise<boolean>;
  /** Scope-aware handoff for selected strings from one real mod. */
  onLlmBatchExportForMod?: (
    mod: ScannedMod,
    items: LlmBatchItem[],
  ) => Promise<LlmExportOutcome | null>;
  onCountsChange?: (
    translatedKeys: number,
    byStatus: Record<StringStatus, number>,
  ) => void;
  onModCountsChange?: (
    modId: string,
    translatedKeys: number,
    byStatus: Record<StringStatus, number>,
  ) => void;
  onVisibleSummaryChange?: (summary: StringTableSummary) => void;
  onBulkApplied?: (entry: OperationHistoryEntry) => void;
  onAiBatchFinished?: (result: AiBatchFinishedResult) => void;
  onNotify?: (message: string, tone?: StringTableNoticeTone) => void;
  onOpenEngineSettings?: () => void;
  onOpenMod?: (uniqueId: string) => void;
  onStringSaved?: (snapshot: SavedStringSnapshot) => void;
  onEditorOpen?: () => void;
  bottomClearance?: number;
  reloadToken?: number;
  shortcuts?: ResolvedShortcuts;
}

const DISPLAY_STATUS: Record<
  StringStatus,
  { label: string; className: string }
> = {
  untranslated: { label: "Open", className: "" },
  translated: { label: "Done", className: "is-ready" },
  outdated: { label: "Changed", className: "is-change" },
  "review-needed": { label: "Review", className: "is-review" },
};

const STATUS_HELP: Record<StringStatus | "all" | "issues", string> = {
  all: "Every string in the current scope.",
  untranslated: "No accepted target translation exists yet.",
  outdated:
    "The English source changed after this translation was saved. The existing translation may be outdated and should be reviewed.",
  "review-needed":
    "This imported or AI-generated suggestion still needs human approval.",
  issues:
    "Only strings with an unresolved validation problem, such as a missing protected token.",
  translated:
    "The translation was explicitly saved or accepted for the current English source.",
};

const FILTER_LABEL: Record<StringTableFilter, string> = {
  all: "All",
  "has-value": "Has target text",
  untranslated: DISPLAY_STATUS.untranslated.label,
  translated: DISPLAY_STATUS.translated.label,
  outdated: DISPLAY_STATUS.outdated.label,
  "review-needed": DISPLAY_STATUS["review-needed"].label,
};

const STATUS_SORT_RANK: Record<StringStatus, number> = {
  untranslated: 0,
  outdated: 1,
  "review-needed": 2,
  translated: 3,
};

const COLUMN_LIMITS: Record<
  ColumnName,
  { min: number; max: number; initial: number }
> = {
  mod: { min: 100, max: 420, initial: 130 },
  file: { min: 80, max: 320, initial: 105 },
  status: { min: 80, max: 240, initial: 102 },
  key: { min: 140, max: 480, initial: 250 },
  source: { min: 220, max: 720, initial: 360 },
  target: { min: 180, max: 1_600, initial: 180 },
};

/** Fixed trailing rail for validation and row-menu controls. It deliberately
 * stays outside the resizable translation column. */
const ROW_ACTIONS_WIDTH = 58;

function identityOf(row: Pick<Row, "modUniqueId" | "file" | "key">): string {
  return JSON.stringify([row.modUniqueId, row.file, row.key]);
}

function sortField(row: Row, col: SortCol): string {
  if (col === "mod") return row.modName;
  if (col === "file") return row.file;
  if (col === "status") return String(STATUS_SORT_RANK[row.status]);
  if (col === "key") return row.key;
  if (col === "source") return row.source;
  return row.target;
}

function countTranslated(rows: Row[]): number {
  return rows.filter((row) => row.target.trim() !== "").length;
}

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

function rowHasIssues(row: Row): boolean {
  return rowValidationIssues(row).length > 0;
}

function rowValidationIssues(row: Row) {
  const issues = validate(row.source, row.target, row.targetPresent);
  if (!row.tokenMismatchAccepted) return issues;
  return issues.filter(
    (issue) =>
      issue.ruleId !== "token-missing" && issue.ruleId !== "token-added",
  );
}

function searchForms(value: string, locale?: string): string[] {
  const forms = [value.toLowerCase()];
  if (locale) {
    try {
      forms.push(value.toLocaleLowerCase(locale));
    } catch {
      // A custom SMAPI language code must not break search. The Unicode
      // default form above remains a safe fallback.
    }
  }
  return [...new Set(forms)];
}

function searchMatches(value: string, query: string, locale?: string): boolean {
  if (!query) return false;
  const needles = searchForms(query, locale);
  return searchForms(value, locale).some((candidate) =>
    needles.some((needle) => candidate.includes(needle)),
  );
}

function preservesNativeTextSelection(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  )
    return true;
  if (!(target instanceof HTMLInputElement)) return false;
  return !["button", "checkbox", "radio", "range", "reset", "submit"].includes(
    target.type,
  );
}

function menuButtons(menu: HTMLElement | null): HTMLButtonElement[] {
  if (!menu) return [];
  return Array.from(
    menu.querySelectorAll<HTMLButtonElement>(
      'button[role="menuitem"]:not(:disabled)',
    ),
  );
}

function setMenuTabStop(
  menu: HTMLElement | null,
  active: HTMLButtonElement | null,
) {
  if (!menu) return;
  const buttons = Array.from(
    menu.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]'),
  );
  for (const button of buttons) button.tabIndex = button === active ? 0 : -1;
}

function focusMenuItem(
  menu: HTMLElement | null,
  button: HTMLButtonElement | undefined,
) {
  const next = button ?? null;
  setMenuTabStop(menu, next);
  next?.focus();
}

function moveMenuFocus(
  event: ReactKeyboardEvent,
  menu: HTMLElement | null,
  onEscape: () => void,
) {
  const buttons = menuButtons(menu);
  if (event.key === "Escape") {
    event.preventDefault();
    onEscape();
    return;
  }
  if (
    event.key !== "ArrowDown" &&
    event.key !== "ArrowUp" &&
    event.key !== "Home" &&
    event.key !== "End"
  ) {
    return;
  }
  event.preventDefault();
  if (buttons.length === 0) return;
  const active = document.activeElement;
  const current = buttons.findIndex((button) => button === active);
  let next = current;
  if (event.key === "Home") next = 0;
  else if (event.key === "End") next = buttons.length - 1;
  else if (event.key === "ArrowDown")
    next = current < 0 ? 0 : (current + 1) % buttons.length;
  else next = current <= 0 ? buttons.length - 1 : current - 1;
  focusMenuItem(menu, buttons[next]);
}

function useOverflowTitle<T extends HTMLElement>(
  text: string,
  layoutKey: string,
) {
  const ref = useRef<T>(null);
  const [overflowing, setOverflowing] = useState(false);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () =>
      setOverflowing(node.scrollWidth > node.clientWidth + 1);
    measure();
    window.addEventListener("resize", measure);
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(node);
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [text, layoutKey]);

  return { ref, title: overflowing && text ? text : undefined };
}

function scopedPlan(
  scope: StringTableScope,
  mod: ScannedMod | null,
  mods: ScannedMod[] | undefined,
): ScannedMod[] {
  if (scope === "mod") return mod ? [mod] : [];
  if (mods && mods.length > 0) return mods;
  return mod ? [mod] : [];
}

export function StringTable({
  mod,
  mods,
  scope,
  onScopeChange,
  identityFilter,
  identityFilterLabel,
  search,
  onSearchChange,
  statusFilter,
  onStatusFilterChange,
  issuesOnly,
  onIssuesOnlyChange,
  initialSort = null,
  onSortChange,
  initialColumnWidths,
  onColumnWidthsChange,
  headerTitle,
  headerContext,
  headerMeta,
  targetLanguageLabel,
  targetLanguageCode,
  localAiModel,
  glossary = null,
  liveAiEngines,
  defaultAiEngine = "local",
  onRunAi,
  onCancelAi,
  onLlmBatchExportForMod,
  onCountsChange,
  onModCountsChange,
  onVisibleSummaryChange,
  onBulkApplied,
  onAiBatchFinished,
  onNotify,
  onOpenEngineSettings,
  onClearFilters,
  onStringSaved,
  onEditorOpen,
  bottomClearance = 0,
  reloadToken = 0,
  shortcuts = DEFAULT_SHORTCUTS,
}: StringTableProps) {
  const [localScope, setLocalScope] = useState<StringTableScope>("mod");
  const [localSearch, setLocalSearch] = useState("");
  const [localStatus, setLocalStatus] = useState<StringTableFilter>("all");
  const [localIssuesOnly, setLocalIssuesOnly] = useState(false);

  const effectiveScope = scope ?? localScope;
  const effectiveSearch = search ?? localSearch;
  const effectiveStatus = statusFilter ?? localStatus;
  const effectiveIssuesOnly = issuesOnly ?? localIssuesOnly;

  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editorSession, setEditorSession] = useState<EditorSession | null>(
    null,
  );
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [activeIdentity, setActiveIdentity] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [bulkMenuOpen, setBulkMenuOpen] = useState(false);
  const [bulkSaving, setBulkSaving] = useState(false);
  const [postSaveReloadToken, setPostSaveReloadToken] = useState(0);
  const [sort, setSort] = useState<StringTableSort | null>(initialSort);
  const [batch, setBatch] = useState<BatchItem[] | null>(null);
  const [batchModLabel, setBatchModLabel] = useState("");
  const [statusTooltip, setStatusTooltip] = useState<StatusTooltipState | null>(
    null,
  );
  const aiProvenanceByIdentity = useRef<
    Map<string, EditorSuggestionProvenance>
  >(new Map());
  const statusTooltipRef = useRef<HTMLDivElement>(null);
  const [columnWidths, setColumnWidths] = useState<StringTableColumnWidths>(
    () =>
      Object.fromEntries(
        (Object.keys(COLUMN_LIMITS) as ColumnName[]).map((column) => {
          const limits = COLUMN_LIMITS[column];
          const supplied = initialColumnWidths?.[column];
          return [
            column,
            supplied == null
              ? limits.initial
              : Math.min(limits.max, Math.max(limits.min, supplied)),
          ];
        }),
      ) as unknown as StringTableColumnWidths,
  );
  const [targetColumnSized, setTargetColumnSized] = useState(
    initialColumnWidths?.target != null,
  );

  const anchor = useRef<number | null>(null);
  const parentRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const previousLoadedIssueCount = useRef<number | null>(null);

  useEffect(() => {
    aiProvenanceByIdentity.current.clear();
  }, [targetLanguageCode]);
  const rowFocusActive = useRef(false);
  const rowsRef = useRef<Row[] | null>(null);
  const bulkSavingRef = useRef(false);
  const contextMenuRef = useRef<HTMLUListElement>(null);
  const bulkMenuRef = useRef<HTMLDivElement>(null);
  const bulkTriggerRef = useRef<HTMLButtonElement>(null);

  const plan = useMemo(
    () => scopedPlan(effectiveScope, mod, mods),
    [effectiveScope, mod, mods],
  );
  const planSignature = JSON.stringify(
    plan.map((candidate) => [
      candidate.uniqueId,
      candidate.name,
      candidate.packageId,
      candidate.i18nFiles.map((file) => [
        file.relativeDir,
        file.defaultPath,
        file.targetPath,
      ]),
    ]),
  );

  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  function reportCounts(next: Row[], changedModIds?: Set<string>) {
    const ids = changedModIds ?? new Set(next.map((row) => row.modUniqueId));
    for (const modId of ids) {
      const modRows = next.filter((row) => row.modUniqueId === modId);
      const translated = countTranslated(modRows);
      const byStatus = countByStatus(modRows);
      onModCountsChange?.(modId, translated, byStatus);
      if (mod?.uniqueId === modId) onCountsChange?.(translated, byStatus);
    }
  }

  useEffect(() => {
    let active = true;
    aiProvenanceByIdentity.current.clear();
    rowsRef.current = null;
    setRows(null);
    setError(null);
    setSelection(new Set());
    setActiveIdentity(null);
    setContextMenu(null);
    setBulkMenuOpen(false);
    setEditorSession(null);
    anchor.current = null;

    (async () => {
      const loaded: Row[] = [];
      for (const candidate of plan) {
        if (!active) return;
        for (const file of candidate.i18nFiles) {
          if (!active) return;
          const fileRows = await loadStrings(
            candidate.uniqueId,
            file.relativeDir,
            file.defaultPath,
            file.targetPath,
          );
          if (!active) return;
          for (const row of fileRows) {
            loaded.push({
              ...row,
              modUniqueId: candidate.uniqueId,
              modName: candidate.name,
              packageId: candidate.packageId,
              file: file.relativeDir,
            });
          }
        }
      }
      if (!active) return;
      rowsRef.current = loaded;
      setRows(loaded);
      reportCounts(loaded);
    })().catch((cause) => {
      if (!active) return;
      rowsRef.current = [];
      setRows([]);
      setError(String(cause));
    });

    return () => {
      active = false;
    };
    // planSignature is the complete immutable load contract.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planSignature, reloadToken, postSaveReloadToken]);

  const data = rows ?? [];
  const rowIndex = useMemo(() => {
    const byIdentity = new Map<string, number>();
    data.forEach((row, index) => byIdentity.set(identityOf(row), index));
    return byIdentity;
  }, [data]);

  const statusCounts = useMemo(() => countByStatus(data), [data]);
  const issueCount = useMemo(
    () => data.filter((row) => rowHasIssues(row)).length,
    [data],
  );
  const identityFilterSet = useMemo(
    () =>
      identityFilter?.length
        ? new Set(
            identityFilter.map((identity) =>
              JSON.stringify([
                identity.modUniqueId,
                identity.relativeDir,
                identity.key,
              ]),
            ),
          )
        : null,
    [identityFilter],
  );
  const visible = useMemo(() => {
    const query = effectiveSearch.trim();
    const filtered: Array<{ row: Row; identity: string; index: number }> = [];
    data.forEach((row, index) => {
      const identity = identityOf(row);
      if (identityFilterSet && !identityFilterSet.has(identity)) return;
      if (
        effectiveStatus === "has-value"
          ? row.target.trim().length === 0
          : effectiveStatus !== "all" && row.status !== effectiveStatus
      ) {
        return;
      }
      if (effectiveIssuesOnly && !rowHasIssues(row)) return;
      if (query) {
        const fields = [row.key, row.source, row.target];
        if (effectiveScope === "all") fields.push(row.modName, row.file);
        if (
          !fields.some((field) =>
            searchMatches(field, query, targetLanguageCode),
          )
        )
          return;
      }
      filtered.push({ row, identity, index });
    });
    if (sort) {
      const direction = sort.dir === "asc" ? 1 : -1;
      filtered.sort((a, b) => {
        const compared =
          sortField(a.row, sort.col).localeCompare(
            sortField(b.row, sort.col),
            undefined,
            { sensitivity: "base", numeric: true },
          ) * direction;
        return compared || a.index - b.index;
      });
    }
    return filtered.map((entry, pos) => ({ ...entry, pos }));
  }, [
    data,
    effectiveSearch,
    effectiveStatus,
    effectiveIssuesOnly,
    effectiveScope,
    identityFilterSet,
    sort,
  ]);

  const filterSummary = [
    identityFilterSet
      ? identityFilterLabel?.trim() || "Latest scan subset"
      : null,
    effectiveIssuesOnly
      ? "Validation issues"
      : effectiveStatus !== "all" || !identityFilterSet
        ? FILTER_LABEL[effectiveStatus]
        : null,
  ]
    .filter(Boolean)
    .join(" · ");

  useEffect(() => {
    onVisibleSummaryChange?.({
      visible: visible.length,
      total: data.length,
      issues: issueCount,
    });
  }, [visible.length, data.length, issueCount, onVisibleSummaryChange]);

  useEffect(() => {
    if (rows == null) {
      previousLoadedIssueCount.current = null;
      return;
    }
    const previous = previousLoadedIssueCount.current;
    previousLoadedIssueCount.current = issueCount;
    if (
      previous != null &&
      previous > 0 &&
      issueCount === 0 &&
      effectiveIssuesOnly
    ) {
      setIssuesValue(false);
    }
    // Only clear after the final real issue was resolved. A routed empty queue
    // remains visible as `Validation issues 0` instead of silently becoming
    // `All`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, issueCount, effectiveIssuesOnly]);

  const visibleIdentitySignature = visible
    .map((entry) => entry.identity)
    .join("\u0001");
  useEffect(() => {
    const allowed = new Set(visible.map((entry) => entry.identity));
    setSelection((current) => {
      const next = new Set(
        [...current].filter((identity) => allowed.has(identity)),
      );
      return next.size === current.size ? current : next;
    });
    setContextMenu((current) =>
      current && allowed.has(current.returnIdentity) ? current : null,
    );
    setBulkMenuOpen(false);
    anchor.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleIdentitySignature]);

  const display = useMemo<DisplayItem[]>(() => {
    if (sort || effectiveScope === "all") {
      return visible.map((entry) => ({ kind: "row", ...entry }));
    }
    const out: DisplayItem[] = [];
    let previousSectionKey: string | null | undefined = undefined;
    for (let position = 0; position < visible.length; position += 1) {
      const item = visible[position];
      const section = item.row.section?.trim() || null;
      const sectionKey = section ? item.row.file + "\u0000" + section : null;
      if (section && sectionKey !== previousSectionKey) {
        out.push({ kind: "section", title: section });
      }
      out.push({ kind: "row", ...item });
      previousSectionKey = sectionKey;
    }
    return out;
  }, [visible, sort, effectiveScope]);

  const virtualizer = useVirtualizer({
    count: display.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => (display[index]?.kind === "section" ? 26 : 38),
    overscan: 16,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [display, virtualizer]);

  const effectiveActiveIdentity = visible.some(
    (entry) => entry.identity === activeIdentity,
  )
    ? activeIdentity
    : (visible[0]?.identity ?? null);

  useEffect(() => {
    if (activeIdentity === effectiveActiveIdentity) return;
    setActiveIdentity(effectiveActiveIdentity);
    if (rowFocusActive.current && effectiveActiveIdentity) {
      focusRow(effectiveActiveIdentity);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIdentity, effectiveActiveIdentity]);

  const selectedRows = useMemo(
    () =>
      visible
        .filter((entry) => selection.has(entry.identity))
        .map((entry) => entry.row),
    [visible, selection],
  );
  const batchEligibleRows = selectedRows.filter(
    (row) => row.status === "untranslated" || row.status === "outdated",
  );
  const liveAiEligibleRows = batchEligibleRows.filter((row) =>
    isLiveAiSourceEligible(row.source),
  );
  const liveAiExcludedCount =
    batchEligibleRows.length - liveAiEligibleRows.length;
  const configuredLiveEngine = liveAiEngines?.find(
    (engine) => engine.id === defaultAiEngine,
  );
  const activeLiveEngine = configuredLiveEngine?.ready
    ? configuredLiveEngine
    : liveAiEngines?.find((engine) => engine.ready);
  const batchEligibleModIds = new Set(
    batchEligibleRows.map((row) => row.modUniqueId),
  );
  const singleModSelection = batchEligibleModIds.size === 1;
  const batchMod =
    plan.find(
      (candidate) =>
        singleModSelection &&
        candidate.uniqueId === batchEligibleRows[0]?.modUniqueId,
    ) ?? null;
  const canRunAi =
    liveAiEligibleRows.length > 0 && Boolean(onRunAi && activeLiveEngine);
  const llmExportHandlerAvailable = Boolean(onLlmBatchExportForMod);
  const canExportLlm =
    singleModSelection &&
    batchEligibleRows.length > 0 &&
    llmExportHandlerAvailable;
  const llmActionEnabled = canExportLlm;
  const allVisibleSelected =
    visible.length > 0 &&
    visible.every((entry) => selection.has(entry.identity));
  const someVisibleSelected = visible.some((entry) =>
    selection.has(entry.identity),
  );

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate =
        someVisibleSelected && !allVisibleSelected;
    }
  }, [someVisibleSelected, allVisibleSelected]);

  useEffect(() => {
    if (!contextMenu) return;
    requestAnimationFrame(() => {
      const menu = contextMenuRef.current;
      focusMenuItem(menu, menuButtons(menu)[0]);
    });
  }, [contextMenu]);

  useLayoutEffect(() => {
    const menu = contextMenuRef.current;
    if (!contextMenu || !menu) return;
    const appWindow = document.getElementById("stardew-i18n-translator");
    const width = appWindow?.clientWidth ?? window.innerWidth;
    const height = appWindow?.clientHeight ?? window.innerHeight;
    const left = Math.min(
      Math.max(6, contextMenu.x),
      Math.max(6, width - menu.offsetWidth - 6),
    );
    const top = Math.min(
      Math.max(6, contextMenu.y),
      Math.max(6, height - menu.offsetHeight - 6),
    );
    if (left === contextMenu.x && top === contextMenu.y) return;
    setContextMenu((current) =>
      current ? { ...current, x: left, y: top } : current,
    );
  }, [contextMenu]);

  useEffect(() => {
    if (!bulkMenuOpen) return;
    requestAnimationFrame(() => {
      const menu = bulkMenuRef.current;
      focusMenuItem(menu, menuButtons(menu)[0]);
    });
  }, [bulkMenuOpen]);

  useEffect(() => {
    const hideTooltip = () => setStatusTooltip(null);
    window.addEventListener("resize", hideTooltip);
    return () => window.removeEventListener("resize", hideTooltip);
  }, []);

  useLayoutEffect(() => {
    if (!statusTooltip || !statusTooltipRef.current) return;
    const tip = statusTooltipRef.current.getBoundingClientRect();
    const left = Math.min(
      window.innerWidth - tip.width - 8,
      Math.max(8, statusTooltip.anchorCenter - tip.width / 2),
    );
    const below = statusTooltip.anchorBottom + 7;
    const top =
      below + tip.height <= window.innerHeight - 8
        ? below
        : Math.max(8, statusTooltip.anchorTop - tip.height - 7);
    const roundedLeft = Math.round(left);
    const roundedTop = Math.round(top);
    setStatusTooltip((current) => {
      if (
        !current ||
        (current.left === roundedLeft && current.top === roundedTop)
      ) {
        return current;
      }
      return { ...current, left: roundedLeft, top: roundedTop };
    });
  }, [
    statusTooltip?.text,
    statusTooltip?.anchorCenter,
    statusTooltip?.anchorTop,
    statusTooltip?.anchorBottom,
  ]);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        editorSession ||
        batch ||
        document.querySelector('[role="dialog"][aria-modal="true"]')
      )
        return;
      const searchShortcut =
        (
          shortcuts as ResolvedShortcuts &
            Partial<Record<"table.search", string>>
        )["table.search"] ?? "Ctrl+F";
      if (!matchesShortcut(event, searchShortcut)) return;
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, [editorSession, batch, shortcuts]);

  function resetSelectionForViewChange() {
    setSelection(new Set());
    anchor.current = null;
    setBulkMenuOpen(false);
    setContextMenu(null);
  }

  function setScopeValue(next: StringTableScope) {
    resetSelectionForViewChange();
    if (scope === undefined) setLocalScope(next);
    onScopeChange?.(next);
  }

  function setSearchValue(next: string) {
    resetSelectionForViewChange();
    if (search === undefined) setLocalSearch(next);
    onSearchChange?.(next);
  }

  function setStatusValue(next: StringTableFilter) {
    resetSelectionForViewChange();
    if (statusFilter === undefined) setLocalStatus(next);
    onStatusFilterChange?.(next);
  }

  function setIssuesValue(next: boolean) {
    resetSelectionForViewChange();
    if (issuesOnly === undefined) setLocalIssuesOnly(next);
    onIssuesOnlyChange?.(next);
  }

  function clearFilters() {
    setSearchValue("");
    setStatusValue("all");
    setIssuesValue(false);
    onClearFilters?.();
    requestAnimationFrame(() => searchRef.current?.focus());
  }

  function toggleSort(col: SortCol) {
    resetSelectionForViewChange();
    setSort((current) => {
      const next: StringTableSort | null =
        !current || current.col !== col
          ? { col, dir: "asc" }
          : current.dir === "asc"
            ? { col, dir: "desc" }
            : null;
      onSortChange?.(next);
      return next;
    });
  }

  function focusRow(identity: string) {
    const displayIndex = display.findIndex(
      (entry) => entry.kind === "row" && entry.identity === identity,
    );
    if (displayIndex < 0) return;
    virtualizer.scrollToIndex(displayIndex, { align: "auto" });
    requestAnimationFrame(() => {
      const element = Array.from(
        parentRef.current?.querySelectorAll<HTMLElement>("[data-row-id]") ?? [],
      ).find((candidate) => candidate.dataset.rowId === identity);
      element?.focus();
    });
  }

  function selectOnly(identity: string, pos: number) {
    setActiveIdentity(identity);
    setSelection(new Set([identity]));
    anchor.current = pos;
  }

  function selectRow(identity: string, pos: number, event: ReactMouseEvent) {
    setActiveIdentity(identity);
    if (event.shiftKey && anchor.current !== null) {
      const low = Math.min(anchor.current, pos);
      const high = Math.max(anchor.current, pos);
      const next = new Set<string>();
      for (let index = low; index <= high; index += 1) {
        const entry = visible[index];
        if (entry) next.add(entry.identity);
      }
      setSelection(next);
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      setSelection((current) => {
        const next = new Set(current);
        if (next.has(identity)) next.delete(identity);
        else next.add(identity);
        return next;
      });
      anchor.current = pos;
      return;
    }
    selectOnly(identity, pos);
  }

  function toggleRow(identity: string, pos: number) {
    setActiveIdentity(identity);
    setSelection((current) => {
      const next = new Set(current);
      if (next.has(identity)) next.delete(identity);
      else next.add(identity);
      return next;
    });
    anchor.current = pos;
  }

  function toggleAllVisible() {
    setSelection((current) => {
      const next = new Set(current);
      if (allVisibleSelected) {
        for (const entry of visible) next.delete(entry.identity);
      } else {
        for (const entry of visible) next.add(entry.identity);
      }
      return next;
    });
  }

  useEffect(() => {
    function selectAllFromWorkspace(event: KeyboardEvent) {
      if (!matchesShortcut(event, shortcuts["table.selectAll"])) return;
      if (preservesNativeTextSelection(event.target)) return;
      if (event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      if (
        editorSession ||
        batch ||
        contextMenu ||
        bulkMenuOpen ||
        document.querySelector('[role="dialog"][aria-modal="true"]')
      )
        return;
      setSelection(new Set(visible.map((entry) => entry.identity)));
    }

    window.addEventListener("keydown", selectAllFromWorkspace);
    return () => window.removeEventListener("keydown", selectAllFromWorkspace);
  }, [batch, bulkMenuOpen, contextMenu, editorSession, shortcuts, visible]);

  function onBodyKeyDown(event: ReactKeyboardEvent) {
    const searchShortcut =
      (
        shortcuts as ResolvedShortcuts & Partial<Record<"table.search", string>>
      )["table.search"] ?? "Ctrl+F";
    if (matchesShortcut(event, searchShortcut)) {
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
      return;
    }
  }

  function openContextMenu(
    identity: string,
    pos: number,
    x: number,
    y: number,
    returnElement: HTMLElement | null = null,
  ) {
    const appBox = document
      .getElementById("stardew-i18n-translator")
      ?.getBoundingClientRect();
    setActiveIdentity(identity);
    setSelection((current) =>
      current.has(identity) ? current : new Set([identity]),
    );
    if (!selection.has(identity)) anchor.current = pos;
    setBulkMenuOpen(false);
    setContextMenu({
      x: x - (appBox?.left ?? 0),
      y: y - (appBox?.top ?? 0),
      returnIdentity: identity,
      returnElement,
    });
  }

  function closeContextMenu(restoreFocus = true) {
    const returnIdentity = contextMenu?.returnIdentity ?? null;
    const returnElement = contextMenu?.returnElement ?? null;
    setContextMenu(null);
    if (restoreFocus) {
      requestAnimationFrame(() => {
        if (returnElement?.isConnected) returnElement.focus();
        else if (returnIdentity) focusRow(returnIdentity);
      });
    }
  }

  function closeBulkMenu(restoreFocus = true) {
    setBulkMenuOpen(false);
    if (restoreFocus)
      requestAnimationFrame(() => bulkTriggerRef.current?.focus());
  }

  function showStatusHelp(target: HTMLElement, text: string) {
    const rect = target.getBoundingClientRect();
    setStatusTooltip({
      text,
      left: 8,
      top: 8,
      anchorCenter: rect.left + rect.width / 2,
      anchorTop: rect.top,
      anchorBottom: rect.bottom,
    });
  }

  function hideStatusHelp() {
    setStatusTooltip(null);
  }

  function onRowKeyDown(
    event: ReactKeyboardEvent<HTMLDivElement>,
    identity: string,
    pos: number,
  ) {
    const rowHasFocus = event.target === event.currentTarget;
    if (
      rowHasFocus &&
      (event.key === "ArrowDown" ||
        event.key === "ArrowUp" ||
        event.key === "Home" ||
        event.key === "End")
    ) {
      event.preventDefault();
      const nextPos =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? visible.length - 1
            : Math.max(
                0,
                Math.min(
                  visible.length - 1,
                  pos + (event.key === "ArrowDown" ? 1 : -1),
                ),
              );
      const next = visible[nextPos];
      if (next) {
        setActiveIdentity(next.identity);
        focusRow(next.identity);
      }
      return;
    }
    if (
      rowHasFocus &&
      (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
    ) {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      openContextMenu(identity, pos, rect.left + 24, rect.top + 24);
      return;
    }
    if (rowHasFocus && matchesShortcut(event, shortcuts["table.edit"])) {
      event.preventDefault();
      openEditor(identity);
      return;
    }
    if (rowHasFocus && event.key === " ") {
      event.preventDefault();
      if (event.shiftKey && anchor.current !== null) {
        const low = Math.min(anchor.current, pos);
        const high = Math.max(anchor.current, pos);
        setActiveIdentity(identity);
        setSelection(
          new Set(visible.slice(low, high + 1).map((entry) => entry.identity)),
        );
      } else {
        toggleRow(identity, pos);
      }
    }
  }

  function openEditor(identity: string | null) {
    if (!identity) return;
    const identities = visible.map((entry) => entry.identity);
    const position = identities.indexOf(identity);
    if (position < 0) return;
    onEditorOpen?.();
    setContextMenu(null);
    setBulkMenuOpen(false);
    setEditorSession({
      identities,
      position,
      review: effectiveStatus === "review-needed",
    });
  }

  async function saveRow(
    identity: string,
    target: string,
    nextStatus: StringStatus,
    tokenMismatchAccepted: boolean,
  ) {
    const index = rowIndex.get(identity);
    const row = index === undefined ? undefined : data[index];
    if (!row) return;
    await saveString(
      row.modUniqueId,
      row.file,
      row.key,
      target,
      nextStatus,
      row.source,
      tokenMismatchAccepted,
    );
    aiProvenanceByIdentity.current.delete(identity);
    const next = data.map((candidate) =>
      identityOf(candidate) === identity
        ? {
            ...candidate,
            target,
            status: nextStatus,
            tokenMismatchAccepted,
          }
        : candidate,
    );
    rowsRef.current = next;
    setRows(next);
    reportCounts(next, new Set([row.modUniqueId]));
    onStringSaved?.({
      modUniqueId: row.modUniqueId,
      relativeDir: row.file,
      key: row.key,
      source: row.source,
      target,
      targetPresent: row.targetPresent,
      tokenMismatchAccepted,
    });
  }

  async function applyStatus(
    nextStatus: StringStatus,
    write: "keep" | "clear" | "source",
    label: string,
  ) {
    if (bulkSavingRef.current) return;

    const planned = selectedRows
      .map((row) => {
        const target =
          write === "clear" ? "" : write === "source" ? row.source : row.target;
        const status: StringStatus =
          nextStatus === "translated" && target.trim() === ""
            ? "untranslated"
            : nextStatus;
        const tokenMismatchAccepted =
          write === "keep" ? row.tokenMismatchAccepted : false;
        return { row, target, status, tokenMismatchAccepted };
      })
      .filter(
        ({ row, target, status, tokenMismatchAccepted }) =>
          row.target !== target ||
          row.status !== status ||
          row.tokenMismatchAccepted !== tokenMismatchAccepted,
      );
    if (planned.length === 0) {
      setContextMenu(null);
      setBulkMenuOpen(false);
      setSelection(new Set());
      onNotify?.("No selected strings needed a change.", "info");
      return;
    }

    const selectedIdentities = new Set(
      planned.map(({ row }) => identityOf(row)),
    );
    const plannedByIdentity = new Map(
      planned.map((change) => [identityOf(change.row), change]),
    );
    const operationRows = rowsRef.current ?? data;

    const byMod = new Map<string, SaveStringEntry[]>();
    for (const { row, target, status, tokenMismatchAccepted } of planned) {
      const entries = byMod.get(row.modUniqueId) ?? [];
      entries.push({
        relativeDir: row.file,
        key: row.key,
        target,
        status:
          tokenMismatchAccepted && status === "translated"
            ? "translated-token-mismatch-accepted"
            : status,
        source: row.source,
      });
      byMod.set(row.modUniqueId, entries);
    }

    bulkSavingRef.current = true;
    setBulkSaving(true);

    try {
      const historyEntry = await saveStringGroupsWithUndo(
        label,
        [...byMod].map(([modUniqueId, entries]) => ({
          modUniqueId,
          entries,
        })),
      );
      const completedMods = new Set(byMod.keys());
      for (const identity of selectedIdentities) {
        aiProvenanceByIdentity.current.delete(identity);
      }
      const completedRows = operationRows.map((row) => {
        if (
          !selectedIdentities.has(identityOf(row)) ||
          !completedMods.has(row.modUniqueId)
        ) {
          return row;
        }
        const change = plannedByIdentity.get(identityOf(row));
        if (!change) return row;
        return {
          ...row,
          target: change.target,
          status: change.status,
          tokenMismatchAccepted: change.tokenMismatchAccepted,
        };
      });
      const currentRows = rowsRef.current;
      if (currentRows) {
        const presentCompletedMods = new Set<string>();
        const next = currentRows.map((row) => {
          if (
            !selectedIdentities.has(identityOf(row)) ||
            !completedMods.has(row.modUniqueId)
          ) {
            return row;
          }
          const change = plannedByIdentity.get(identityOf(row));
          if (!change) return row;
          presentCompletedMods.add(row.modUniqueId);
          return {
            ...row,
            target: change.target,
            status: change.status,
            tokenMismatchAccepted: change.tokenMismatchAccepted,
          };
        });
        if (presentCompletedMods.size > 0) {
          rowsRef.current = next;
          setRows(next);
          reportCounts(next, presentCompletedMods);
        }
        const missingCompletedMods = new Set(
          [...completedMods].filter(
            (modUniqueId) => !presentCompletedMods.has(modUniqueId),
          ),
        );
        if (missingCompletedMods.size > 0) {
          reportCounts(completedRows, missingCompletedMods);
        }
      } else {
        reportCounts(completedRows, completedMods);
        setPostSaveReloadToken((current) => current + 1);
      }
      onBulkApplied?.(historyEntry);
      for (const { row, target, tokenMismatchAccepted } of planned) {
        if (!completedMods.has(row.modUniqueId)) continue;
        onStringSaved?.({
          modUniqueId: row.modUniqueId,
          relativeDir: row.file,
          key: row.key,
          source: row.source,
          target,
          targetPresent: row.targetPresent,
          tokenMismatchAccepted,
        });
      }
      onNotify?.(
        String(planned.length) +
          (planned.length === 1 ? " string updated." : " strings updated."),
        "success",
      );
    } catch (cause) {
      onNotify?.(`The batch edit was not saved. ${String(cause)}`, "error");
    } finally {
      bulkSavingRef.current = false;
      setBulkSaving(false);
      setContextMenu(null);
      setBulkMenuOpen(false);
      setSelection((current) => {
        const next = new Set(current);
        for (const identity of selectedIdentities) next.delete(identity);
        return next;
      });
    }
  }

  async function copySelection(field: "source" | "target") {
    const text = selectedRows.map((row) => row[field]).join("\n");
    try {
      if (!navigator.clipboard?.writeText)
        throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(text);
      onNotify?.(
        field === "source" ? "Source text copied." : "Translations copied.",
        "success",
      );
    } catch {
      onNotify?.("Could not access the clipboard.", "error");
    }
    setContextMenu(null);
    setBulkMenuOpen(false);
  }

  function startBatch() {
    if (bulkSavingRef.current || !canRunAi) return;
    onEditorOpen?.();
    const items: BatchItem[] = liveAiEligibleRows.map((row) => ({
      modUniqueId: row.modUniqueId,
      key: row.key,
      file: row.file,
      source: row.source,
      status: row.status as "untranslated" | "outdated",
      ...(row.section ? { section: row.section } : {}),
    }));
    const eligibleModIds = new Set(
      liveAiEligibleRows.map((row) => row.modUniqueId),
    );
    setBatchModLabel(
      eligibleModIds.size === 1
        ? (liveAiEligibleRows[0]?.modName ?? "Selected mod")
        : String(eligibleModIds.size) + " mods",
    );
    setContextMenu(null);
    setBulkMenuOpen(false);
    setBatch(items);
  }

  function applyLiveSuggestions(result: AiRunResult, showReview = true) {
    if (result.suggestions.length === 0) return;
    const suggestions = new Map(
      result.suggestions.map((suggestion) => [
        JSON.stringify([
          suggestion.identity.modUniqueId,
          suggestion.identity.relativeDir,
          suggestion.identity.key,
        ]),
        suggestion,
      ]),
    );
    const changedMods = new Set<string>();
    const engineLabel =
      activeLiveEngine?.id === result.engine
        ? activeLiveEngine.label
        : result.engine === "codex"
          ? "Codex CLI"
          : "Local AI";
    const reasoningLabel = result.reasoning
      ? result.reasoning.charAt(0).toUpperCase() + result.reasoning.slice(1)
      : "";
    if (result.model && reasoningLabel) {
      for (const suggestion of result.suggestions) {
        const identity = JSON.stringify([
          suggestion.identity.modUniqueId,
          suggestion.identity.relativeDir,
          suggestion.identity.key,
        ]);
        aiProvenanceByIdentity.current.set(identity, {
          identity,
          engine: engineLabel,
          model: result.model,
          reasoning: reasoningLabel,
          persisted: true,
          value: suggestion.text,
        });
      }
    }
    const current = rowsRef.current ?? [];
    const next = current.map((row) => {
      const suggestion = suggestions.get(identityOf(row));
      if (!suggestion) return row;
      changedMods.add(row.modUniqueId);
      return {
        ...row,
        target: suggestion.text,
        status: "review-needed" as StringStatus,
        tokenMismatchAccepted: false,
      };
    });
    rowsRef.current = next;
    setRows(next);
    reportCounts(next, changedMods);
    for (const suggestion of result.suggestions) {
      const suggestionIdentity = JSON.stringify([
        suggestion.identity.modUniqueId,
        suggestion.identity.relativeDir,
        suggestion.identity.key,
      ]);
      const updated = next.find(
        (row) => identityOf(row) === suggestionIdentity,
      );
      if (!updated) continue;
      onStringSaved?.({
        modUniqueId: updated.modUniqueId,
        relativeDir: updated.file,
        key: updated.key,
        source: updated.source,
        target: updated.target,
        targetPresent: updated.targetPresent,
        tokenMismatchAccepted: false,
      });
    }
    if (showReview) {
      setStatusValue("review-needed");
      setIssuesValue(false);
    }
  }

  async function runLiveBatch(runId: string): Promise<AiRunResult> {
    if (!onRunAi || !activeLiveEngine)
      throw new Error("The selected translation engine is unavailable.");
    const request: AiTranslationRequest = {
      runId,
      scope: "selected",
      includeOpen: true,
      includeChanged: true,
      identities: (batch ?? []).map((item) => ({
        modUniqueId: item.modUniqueId ?? "",
        relativeDir: item.file,
        key: item.key,
      })),
    };
    const result = await onRunAi(activeLiveEngine.id, request);
    // A partial/cancelled live run keeps the current filter and selection so
    // the remaining Open/Changed rows can be started again immediately.
    applyLiveSuggestions(result, false);
    return result;
  }

  async function runSingleLiveAi(row: Row): Promise<EditorTranslationResult> {
    if (!onRunAi || !activeLiveEngine)
      throw new Error("The selected translation engine is unavailable.");
    const result = await onRunAi(activeLiveEngine.id, {
      runId:
        globalThis.crypto?.randomUUID?.() ??
        `ai-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      scope: "string",
      includeOpen: true,
      includeChanged: true,
      identities: [
        {
          modUniqueId: row.modUniqueId,
          relativeDir: row.file,
          key: row.key,
        },
      ],
    });
    applyLiveSuggestions(result);
    const suggestion = result.suggestions.find(
      (candidate) =>
        candidate.identity.modUniqueId === row.modUniqueId &&
        candidate.identity.relativeDir === row.file &&
        candidate.identity.key === row.key,
    );
    if (!suggestion) {
      throw new Error(
        result.error ||
          "The AI run completed without a suggestion for this string.",
      );
    }
    return {
      text: suggestion.text,
      missingTokens: suggestion.tokenDifferences
        .filter((difference) => difference.targetCount < difference.sourceCount)
        .flatMap((difference) =>
          Array.from(
            { length: difference.sourceCount - difference.targetCount },
            () => difference.token,
          ),
        ),
      glossaryMisses: suggestion.glossaryMisses,
      engine: result.engine,
      model: result.model,
      reasoning: result.reasoning,
      persisted: true,
    };
  }

  function closeBatch() {
    setBatch(null);
    setBatchModLabel("");
    const current = rowsRef.current ?? [];
    reportCounts(current);
  }

  function finishBatch(result: BatchFinishedResult) {
    const current = rowsRef.current ?? [];
    reportCounts(current);
    if (result.outcome === "complete" && result.done > 0) {
      setStatusValue("review-needed");
      setIssuesValue(false);
    }
    if (result.outcome === "complete") {
      onNotify?.(
        String(result.done) +
          (result.done === 1
            ? " AI suggestion saved to Review."
            : " AI suggestions saved to Review."),
        "success",
      );
    }
    onAiBatchFinished?.({
      ...(result.runId ? { runId: result.runId } : {}),
      outcome: result.outcome,
      done: result.done,
      total: result.total,
      ...(result.error ? { error: result.error } : {}),
      engine: result.engine ?? "Local AI",
      ...(result.model ? { model: result.model } : {}),
      ...(result.reasoning ? { reasoning: result.reasoning } : {}),
      modName: batchModLabel,
      modUniqueIds: [
        ...new Set(
          (batch ?? [])
            .map((item) => item.modUniqueId)
            .filter((id): id is string => Boolean(id)),
        ),
      ],
    });
    setBatch(null);
    setBatchModLabel("");
  }

  async function startLlmBatchExport() {
    if (bulkSavingRef.current) return;
    if (!onLlmBatchExportForMod) return;
    if (!canExportLlm || !batchMod) {
      setContextMenu(null);
      setBulkMenuOpen(false);
      onNotify?.(
        llmUnavailableReason ??
          "Select exportable Open or Changed strings from one mod.",
        "info",
      );
      return;
    }
    const items: LlmBatchItem[] = batchEligibleRows.map((row) => ({
      relativeDir: row.file,
      key: row.key,
      source: row.source,
    }));
    setContextMenu(null);
    setBulkMenuOpen(false);
    try {
      await onLlmBatchExportForMod(batchMod, items);
    } catch {
      // The shell owns persistent operation reporting.
    }
  }

  function adjustColumn(column: ColumnName, value: number) {
    const limits = COLUMN_LIMITS[column];
    setColumnWidths((current) => {
      const next = {
        ...current,
        [column]: Math.min(limits.max, Math.max(limits.min, value)),
      };
      onColumnWidthsChange?.(next);
      return next;
    });
  }

  function startColumnResize(
    column: ColumnName,
    event: ReactPointerEvent<HTMLSpanElement>,
  ) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    hideStatusHelp();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const measuredWidth = handle.parentElement?.getBoundingClientRect().width;
    const startWidth =
      column === "target" && measuredWidth && measuredWidth > 0
        ? Math.round(measuredWidth)
        : columnWidths[column];
    if (column === "target" && !targetColumnSized) {
      adjustColumn(column, startWidth);
      setTargetColumnSized(true);
    }
    handle.classList.add("is-dragging");
    handle.setPointerCapture?.(pointerId);
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      adjustColumn(column, startWidth + moveEvent.clientX - startX);
    };
    const finish = (finishEvent: PointerEvent) => {
      if (finishEvent.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      handle.classList.remove("is-dragging");
      if (handle.hasPointerCapture?.(pointerId)) {
        handle.releasePointerCapture(pointerId);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  }

  function onColumnResizeKeyDown(
    column: ColumnName,
    event: ReactKeyboardEvent<HTMLSpanElement>,
  ) {
    hideStatusHelp();
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const measuredWidth =
      event.currentTarget.parentElement?.getBoundingClientRect().width;
    const startWidth =
      column === "target" && measuredWidth && measuredWidth > 0
        ? Math.round(measuredWidth)
        : columnWidths[column];
    if (column === "target") setTargetColumnSized(true);
    adjustColumn(column, startWidth + (event.key === "ArrowRight" ? 16 : -16));
  }

  const showModColumn = effectiveScope === "all";
  const showFileColumn =
    effectiveScope === "all"
      ? plan.some((candidate) => candidate.i18nFiles.length > 1)
      : (mod?.i18nFiles.length ?? 0) > 1;
  const gridTemplateColumns = [
    "34px",
    ...(showModColumn ? [String(columnWidths.mod) + "px"] : []),
    ...(showFileColumn ? [String(columnWidths.file) + "px"] : []),
    String(columnWidths.status) + "px",
    String(columnWidths.key) + "px",
    String(columnWidths.source) + "px",
    ...(targetColumnSized
      ? [String(columnWidths.target) + "px", "minmax(0, 1fr)"]
      : ["minmax(" + String(columnWidths.target) + "px, 1fr)"]),
    String(ROW_ACTIONS_WIDTH) + "px",
  ].join(" ");
  const tableMinWidth =
    34 +
    (showModColumn ? columnWidths.mod : 0) +
    (showFileColumn ? columnWidths.file : 0) +
    columnWidths.status +
    columnWidths.key +
    columnWidths.source +
    columnWidths.target +
    ROW_ACTIONS_WIDTH;
  const effectiveHeaderTitle =
    headerTitle ??
    (effectiveScope === "all"
      ? "All mods"
      : (mod?.name ?? "Translation strings"));
  const effectiveHeaderContext =
    headerContext === undefined
      ? effectiveScope === "mod" &&
        mod &&
        mod.packageId &&
        mod.packageId !== mod.name
        ? mod.packageId
        : null
      : headerContext;
  const workingTranslated = countTranslated(data);
  const workingProgress =
    data.length > 0 ? Math.round((workingTranslated / data.length) * 100) : 0;
  const suppliedHeaderMeta =
    typeof headerMeta === "string"
      ? [headerMeta]
      : headerMeta
        ? [...headerMeta]
        : [];
  const headerMetaItems = [
    ...(targetLanguageLabel ? [targetLanguageLabel] : []),
    data.length > 0
      ? String(workingTranslated) +
        " / " +
        String(data.length) +
        " translated · " +
        String(workingProgress) +
        "%"
      : "No translatable strings",
    ...suppliedHeaderMeta.filter((item) => item.trim().length > 0),
  ];
  const gridStyle = {
    "--translator-key-column": String(columnWidths.key) + "px",
    "--translator-source-column": String(columnWidths.source) + "px",
  } as CSSProperties;
  const translationColumnLabel = targetLanguageLabel
    ? targetLanguageLabel.split(" (")[0] + " translation"
    : "Translation";
  const resizerFor = (column: ColumnName, ariaLabel: string) => (
    <ColumnResizer
      column={column}
      value={columnWidths[column]}
      ariaLabel={ariaLabel}
      measureRenderedWidth={column === "target" && !targetColumnSized}
      onPointerDown={(event) => startColumnResize(column, event)}
      onKeyDown={(event) => onColumnResizeKeyDown(column, event)}
    />
  );

  if (rows === null) {
    return (
      <div className="panel__empty translator-empty-state" role="status">
        Loading strings…
      </div>
    );
  }
  if (error) {
    return (
      <div className="panel__empty translator-empty-state" role="alert">
        {error}
      </div>
    );
  }

  const editingIdentity = editorSession
    ? editorSession.identities[editorSession.position]
    : null;
  const editingIndex =
    editingIdentity === null || editingIdentity === undefined
      ? undefined
      : rowIndex.get(editingIdentity);
  const editingRow =
    editingIndex === undefined ? null : (data[editingIndex] ?? null);
  const editingAiAllowed = Boolean(
    editingRow &&
    (editingRow.status === "untranslated" ||
      editingRow.status === "outdated") &&
    isLiveAiSourceEligible(editingRow.source),
  );
  const editorTranslate =
    editingRow && onRunAi && activeLiveEngine
      ? () => runSingleLiveAi(editingRow)
      : undefined;
  const editorAiUnavailableReason =
    editingRow &&
    (editingRow.status === "untranslated" ||
      editingRow.status === "outdated") &&
    !isLiveAiSourceEligible(editingRow.source)
      ? "This source text cannot be sent to live AI because it is empty, contains an invalid NUL character, or exceeds 64 KiB."
      : !editingAiAllowed
        ? "AI can only translate Open or Changed strings. Done and Review text must be handled manually."
        : onRunAi && !activeLiveEngine?.ready
          ? (configuredLiveEngine?.unavailableReason ??
            "The default translation engine is not ready. Check it in Settings.")
          : !editorTranslate
            ? "Configure a translation engine in Settings to use AI translation."
            : undefined;

  const statusButtons: Array<{
    value: StringTableFilter;
    label: string;
    count: number;
  }> = [
    { value: "all", label: "All", count: data.length },
    {
      value: "untranslated",
      label: "Open",
      count: statusCounts.untranslated,
    },
    { value: "outdated", label: "Changed", count: statusCounts.outdated },
    {
      value: "review-needed",
      label: "Review",
      count: statusCounts["review-needed"],
    },
    { value: "translated", label: "Done", count: statusCounts.translated },
  ];

  const aiUnavailableReason = !onRunAi
    ? "Configure a translation engine in Settings."
    : !activeLiveEngine
      ? "No translation engine is currently available. Check Settings."
      : liveAiEligibleRows.length === 0
        ? batchEligibleRows.length > 0
          ? "The selected Open or Changed strings have empty, invalid, or oversized source text."
          : "No open or changed strings are selected."
        : null;
  const llmUnavailableReason =
    batchEligibleRows.length === 0
      ? "No selected Open or Changed strings are exportable. Done and Review text would be preserved on import."
      : !singleModSelection
        ? "Select Open or Changed strings from one mod; each LLM batch is bound to exactly one mod."
        : !llmExportHandlerAvailable
          ? "Choose a target language first."
          : null;

  return (
    <div
      className={
        "stringtable translator-string-workbench" +
        (showFileColumn ? " stringtable--multifile" : "") +
        (showModColumn ? " translator-string-workbench--global" : "")
      }
      style={gridStyle}
      data-scope={effectiveScope}
    >
      <div className="translator-string-head">
        <div className="translator-string-title">
          <h1 tabIndex={-1}>
            {effectiveHeaderContext && (
              <span className="translator-string-parent-context">
                <span>{effectiveHeaderContext}</span>
                <span aria-hidden="true">›</span>
              </span>
            )}
            <span>{effectiveHeaderTitle}</span>
          </h1>
          <div className="translator-string-meta">
            {headerMetaItems.map((item, index) => (
              <span key={String(index) + "-" + item}>{item}</span>
            ))}
            {data.length > 0 && (
              <span className="translator-progress-inline" aria-hidden="true">
                <span style={{ width: String(workingProgress) + "%" }} />
              </span>
            )}
          </div>
        </div>
        <div className="translator-string-scope">
          <span
            className="translator-string-scope-label"
            id="translator-string-scope-label"
          >
            Show strings from:
          </span>
          <div
            className="translator-scope-toggle"
            role="group"
            aria-labelledby="translator-string-scope-label"
          >
            <button
              type="button"
              aria-pressed={effectiveScope === "mod"}
              disabled={!mod}
              onClick={() => setScopeValue("mod")}
            >
              This mod
            </button>
            <button
              type="button"
              aria-pressed={effectiveScope === "all"}
              disabled={plan.length === 0 && effectiveScope !== "all"}
              onClick={() => setScopeValue("all")}
            >
              All mods
            </button>
          </div>
        </div>
      </div>

      <div
        className={
          "translator-string-toolbar" +
          (selection.size > 0 ? " is-selection-active" : "")
        }
      >
        <div className="translator-string-search-line">
          <input
            ref={searchRef}
            className="translator-search"
            type="search"
            aria-label="Search strings"
            placeholder={
              effectiveScope === "all"
                ? "Key, source, or translation across all mods …"
                : "Key, source, or translation …"
            }
            value={effectiveSearch}
            onChange={(event) => setSearchValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape" || !effectiveSearch) return;
              event.preventDefault();
              event.stopPropagation();
              setSearchValue("");
              event.currentTarget.focus();
            }}
          />
          <div
            className="translator-query-summary"
            aria-live="polite"
            aria-atomic="true"
          >
            <span>
              {effectiveSearch.trim()
                ? identityFilterSet
                  ? `Search preview: ${visible.length} matching ${visible.length === 1 ? "row" : "rows"} · ${filterSummary} · ${effectiveScope === "all" ? "All mods" : "This mod"}`
                  : `Search preview: ${visible.length} matching ${visible.length === 1 ? "row" : "rows"} · ${data.length} ${data.length === 1 ? "string" : "strings"} in ${effectiveScope === "all" ? "All mods" : "This mod"}`
                : `${visible.length} of ${data.length} ${data.length === 1 ? "string" : "strings"} · ${filterSummary} · ${effectiveScope === "all" ? "All mods" : "This mod"}`}
            </span>
            {(effectiveSearch.trim() ||
              effectiveStatus !== "all" ||
              effectiveIssuesOnly ||
              identityFilterSet) && (
              <button
                className="translator-query-clear"
                type="button"
                onClick={clearFilters}
              >
                Clear
              </button>
            )}
          </div>
        </div>

        <div
          className="translator-filters"
          aria-label="Filter by string status"
        >
          <span
            className="translator-status-filter-set"
            role="group"
            aria-label="Status"
          >
            {statusButtons.map((item) => (
              <button
                key={item.value}
                className="translator-filter"
                type="button"
                aria-pressed={effectiveStatus === item.value}
                aria-description={
                  STATUS_HELP[item.value === "has-value" ? "all" : item.value]
                }
                data-status-help={
                  STATUS_HELP[item.value === "has-value" ? "all" : item.value]
                }
                onPointerEnter={(event) =>
                  showStatusHelp(
                    event.currentTarget,
                    STATUS_HELP[
                      item.value === "has-value" ? "all" : item.value
                    ],
                  )
                }
                onPointerLeave={hideStatusHelp}
                onFocus={(event) =>
                  showStatusHelp(
                    event.currentTarget,
                    STATUS_HELP[
                      item.value === "has-value" ? "all" : item.value
                    ],
                  )
                }
                onBlur={hideStatusHelp}
                onClick={() => setStatusValue(item.value)}
              >
                {item.label}{" "}
                <span className="translator-filter-count">{item.count}</span>
              </button>
            ))}
          </span>
          {(issueCount > 0 || effectiveIssuesOnly) && (
            <>
              <span
                className="translator-filter-separator"
                role="separator"
                aria-orientation="vertical"
              />
              <button
                className="translator-filter translator-issue-filter"
                type="button"
                aria-pressed={effectiveIssuesOnly}
                aria-description={STATUS_HELP.issues}
                data-status-help={STATUS_HELP.issues}
                onPointerEnter={(event) =>
                  showStatusHelp(event.currentTarget, STATUS_HELP.issues)
                }
                onPointerLeave={hideStatusHelp}
                onFocus={(event) =>
                  showStatusHelp(event.currentTarget, STATUS_HELP.issues)
                }
                onBlur={hideStatusHelp}
                onClick={() => setIssuesValue(!effectiveIssuesOnly)}
              >
                Validation issues{" "}
                <span className="translator-filter-count">{issueCount}</span>
              </button>
            </>
          )}
        </div>

        <div className="translator-bulk-wrap">
          {selection.size > 0 && (
            <span className="translator-selection-hint">
              Ctrl+click adds more
            </span>
          )}
          {selection.size > 0 && (
            <>
              <button
                ref={bulkTriggerRef}
                className="translator-button translator-button-quiet translator-bulk-button"
                type="button"
                aria-haspopup="menu"
                aria-expanded={bulkMenuOpen}
                data-has-selection="true"
                onClick={() => setBulkMenuOpen((current) => !current)}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowDown") return;
                  event.preventDefault();
                  if (!bulkMenuOpen) setBulkMenuOpen(true);
                  else {
                    requestAnimationFrame(() => {
                      const menu = bulkMenuRef.current;
                      focusMenuItem(menu, menuButtons(menu)[0]);
                    });
                  }
                }}
              >
                <ListChecks aria-hidden="true" />
                <span>{selection.size} selected</span>
              </button>
              <button
                className="translator-query-clear"
                type="button"
                aria-label="Clear selected strings"
                onClick={() => {
                  setSelection(new Set());
                  setBulkMenuOpen(false);
                  anchor.current = null;
                  onNotify?.("Selection cleared.", "info");
                }}
              >
                Clear selection
              </button>
            </>
          )}
          {bulkMenuOpen && (
            <div
              ref={bulkMenuRef}
              className="translator-popover"
              role="menu"
              aria-label="Batch actions"
              onKeyDown={(event) =>
                moveMenuFocus(event, bulkMenuRef.current, () => closeBulkMenu())
              }
              onBlur={(event) => {
                const next = event.relatedTarget as Node | null;
                if (!next || !event.currentTarget.contains(next)) {
                  closeBulkMenu(false);
                }
              }}
            >
              <span className="translator-popover-note" role="presentation">
                <strong>{selection.size} selected</strong> ·{" "}
                <span>
                  {batchEligibleRows.length} Open/Changed
                  {batchEligibleRows.length > 0 &&
                    (singleModSelection
                      ? " exportable"
                      : ` · ${batchEligibleModIds.size} mods`)}
                  {liveAiExcludedCount > 0
                    ? ` · ${liveAiEligibleRows.length} AI-ready`
                    : ""}
                </span>
              </span>
              <ActionButtons
                mutationPending={bulkSaving}
                canRunAi={canRunAi}
                llmActionEnabled={llmActionEnabled}
                aiUnavailableReason={aiUnavailableReason}
                llmUnavailableReason={llmUnavailableReason}
                llmCount={
                  batchEligibleRows.length > 0 && !singleModSelection
                    ? "select one mod"
                    : undefined
                }
                onCopySource={() => void copySelection("source")}
                onCopyTarget={() => void copySelection("target")}
                onMarkDone={() =>
                  void applyStatus("translated", "keep", "Updated status")
                }
                onKeepOriginal={() =>
                  void applyStatus("translated", "source", "Kept original text")
                }
                onClear={() =>
                  void applyStatus(
                    "untranslated",
                    "clear",
                    "Cleared translations",
                  )
                }
                onAi={startBatch}
                onLlmExport={() => void startLlmBatchExport()}
              />
            </div>
          )}
        </div>
      </div>

      <div className="translator-table-wrap">
        <span className="translator-sr-only" id="translator-table-help">
          Use Up and Down Arrow to move between rows, Enter to edit, Space to
          select, and Shift plus F10 for row actions.
        </span>
        {visible.length === 0 ? (
          <div className="tableempty translator-empty-state">
            <SearchX aria-hidden="true" />
            <strong>No matching strings</strong>
            <span>Change the filter, scope, or search text.</span>
            <button
              className="translator-button translator-button-quiet"
              type="button"
              onClick={clearFilters}
            >
              Clear filter
            </button>
          </div>
        ) : (
          <div
            className="translator-string-table"
            role="table"
            aria-label="Translation strings"
            aria-describedby="translator-table-help"
            style={{ minWidth: tableMinWidth }}
          >
            <div
              className="stringrow stringrow--head translator-string-table-head"
              role="row"
              style={{
                gridTemplateColumns,
                columnGap: 0,
                padding: 0,
                minWidth: tableMinWidth,
              }}
            >
              <span
                className="translator-select-col"
                role="columnheader"
                style={{
                  height: "27px",
                  display: "flex",
                  alignItems: "center",
                  padding: "0 8px",
                }}
              >
                <input
                  ref={selectAllRef}
                  className="translator-selection-box"
                  type="checkbox"
                  aria-label="Select all visible strings"
                  checked={allVisibleSelected}
                  onChange={toggleAllVisible}
                />
              </span>
              {showModColumn && (
                <SortHeader
                  label="Mod"
                  col="mod"
                  sort={sort}
                  onSort={toggleSort}
                  resizer={resizerFor("mod", "Resize mod column")}
                />
              )}
              {showFileColumn && (
                <SortHeader
                  label="File"
                  col="file"
                  sort={sort}
                  onSort={toggleSort}
                  resizer={resizerFor("file", "Resize file column")}
                />
              )}
              <SortHeader
                label="Status"
                col="status"
                sort={sort}
                onSort={toggleSort}
                resizer={resizerFor("status", "Resize status column")}
              />
              <SortHeader
                label="Key"
                col="key"
                sort={sort}
                onSort={toggleSort}
                resizer={resizerFor("key", "Resize key column")}
              />
              <SortHeader
                label="English source"
                col="source"
                sort={sort}
                onSort={toggleSort}
                resizer={resizerFor("source", "Resize English source column")}
              />
              <SortHeader
                label={translationColumnLabel}
                col="target"
                sort={sort}
                onSort={toggleSort}
                resizer={resizerFor(
                  "target",
                  translationColumnLabel === "Translation"
                    ? "Resize translation column"
                    : `Resize ${translationColumnLabel} column`,
                )}
              />
              <span
                className="translator-row-actions-col"
                role="columnheader"
                aria-label="Row actions"
                style={{ gridColumn: "-2 / -1" }}
              />
            </div>

            <div
              ref={parentRef}
              className="stringtable__body translator-string-table-body"
              role="rowgroup"
              onKeyDown={onBodyKeyDown}
            >
              <div
                data-testid="stringtable-scroll-content"
                style={{
                  height: virtualizer.getTotalSize() + bottomClearance,
                  position: "relative",
                }}
              >
                {virtualizer.getVirtualItems().map((item) => {
                  const entry = display[item.index];
                  if (!entry) return null;
                  if (entry.kind === "section") {
                    return (
                      <div
                        key={"section-" + item.index + "-" + entry.title}
                        className="sectionrow translator-section-row"
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          right: 0,
                          height: item.size,
                          transform: "translateY(" + item.start + "px)",
                        }}
                      >
                        <span className="sectionrow__title">
                          // {entry.title}
                        </span>
                      </div>
                    );
                  }
                  return (
                    <RowView
                      key={entry.identity}
                      row={entry.row}
                      identity={entry.identity}
                      dataIndex={entry.index}
                      showMod={showModColumn}
                      showFile={showFileColumn}
                      searchQuery={effectiveSearch.trim()}
                      searchLocale={targetLanguageCode}
                      searchAllMetadata={effectiveScope === "all"}
                      translationColumnLabel={translationColumnLabel}
                      selected={selection.has(entry.identity)}
                      tabStop={entry.identity === effectiveActiveIdentity}
                      top={item.start}
                      height={item.size}
                      gridTemplateColumns={gridTemplateColumns}
                      tableMinWidth={tableMinWidth}
                      menuOpen={contextMenu?.returnIdentity === entry.identity}
                      onToggle={() => toggleRow(entry.identity, entry.pos)}
                      onSelect={(event) =>
                        selectRow(entry.identity, entry.pos, event)
                      }
                      onContextMenu={(event) => {
                        event.preventDefault();
                        openContextMenu(
                          entry.identity,
                          entry.pos,
                          event.clientX,
                          event.clientY,
                        );
                      }}
                      onOpen={() => openEditor(entry.identity)}
                      onMoreActions={(event) => {
                        event.stopPropagation();
                        const rect =
                          event.currentTarget.getBoundingClientRect();
                        openContextMenu(
                          entry.identity,
                          entry.pos,
                          rect.left,
                          rect.bottom,
                          event.currentTarget,
                        );
                      }}
                      onKeyDown={(event) =>
                        onRowKeyDown(event, entry.identity, entry.pos)
                      }
                      onFocus={() => {
                        rowFocusActive.current = true;
                        setActiveIdentity(entry.identity);
                      }}
                      onBlur={(event) => {
                        const next = event.relatedTarget as HTMLElement | null;
                        if (
                          next &&
                          !next.matches(".stringrow--data") &&
                          !next.closest(".translator-context-menu")
                        ) {
                          rowFocusActive.current = false;
                        }
                      }}
                      onShowStatusHelp={showStatusHelp}
                      onHideStatusHelp={hideStatusHelp}
                    />
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      {statusTooltip && (
        <div
          ref={statusTooltipRef}
          className="translator-status-tooltip"
          role="tooltip"
          style={{ left: statusTooltip.left, top: statusTooltip.top }}
        >
          {statusTooltip.text}
        </div>
      )}

      {editingRow && editingIdentity && editorSession && (
        <StringEditor
          row={editingRow}
          index={editorSession.position}
          total={editorSession.identities.length}
          modName={editingRow.modName}
          targetLanguageLabel={targetLanguageLabel}
          aiEngineLabel={activeLiveEngine?.label ?? "Local AI"}
          aiModel={activeLiveEngine?.model ?? localAiModel}
          aiReasoning={activeLiveEngine?.reasoning}
          suggestionProvenance={
            aiProvenanceByIdentity.current.get(editingIdentity) ?? undefined
          }
          translationAllowed={editingAiAllowed}
          translationUnavailableReason={editorAiUnavailableReason}
          reviewProgress={
            editorSession.review
              ? {
                  current: editorSession.position + 1,
                  total: editorSession.identities.length,
                }
              : undefined
          }
          glossary={glossary}
          onTranslate={editorTranslate}
          onSave={(value, nextStatus, tokenMismatchAccepted) =>
            saveRow(editingIdentity, value, nextStatus, tokenMismatchAccepted)
          }
          onClose={() => setEditorSession(null)}
          onNavigate={(delta) =>
            setEditorSession((current) => {
              if (!current) return current;
              const position = current.position + delta;
              return position >= 0 && position < current.identities.length
                ? { ...current, position }
                : current;
            })
          }
          onOpenEngineSettings={onOpenEngineSettings}
          onNotify={onNotify}
          shortcuts={shortcuts}
        />
      )}

      {contextMenu && (
        <>
          <div
            className="ctxmenu__scrim translator-context-scrim"
            onMouseDown={() => closeContextMenu(false)}
            onContextMenu={(event) => {
              event.preventDefault();
              closeContextMenu(false);
            }}
          />
          <ul
            ref={contextMenuRef}
            className="ctxmenu translator-context-menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            role="menu"
            aria-label="String actions"
            onKeyDown={(event) =>
              moveMenuFocus(event, contextMenuRef.current, () =>
                closeContextMenu(),
              )
            }
            onBlur={(event) => {
              const next = event.relatedTarget as Node | null;
              if (!next || !event.currentTarget.contains(next)) {
                closeContextMenu(false);
              }
            }}
          >
            {selection.size > 1 && (
              <li className="ctxmenu__count translator-popover-note">
                {selection.size} selected
              </li>
            )}
            <li role="none">
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                disabled={selection.size !== 1}
                onFocus={(event) =>
                  setMenuTabStop(contextMenuRef.current, event.currentTarget)
                }
                onClick={() =>
                  openEditor(
                    selectedRows[0] ? identityOf(selectedRows[0]) : null,
                  )
                }
              >
                <span className="translator-menu-label">
                  <Pencil aria-hidden="true" /> Edit string
                </span>
                <span className="translator-context-shortcut">
                  {displayShortcut(shortcuts["table.edit"])}
                </span>
              </button>
            </li>
            <ActionButtons
              listItems
              mutationPending={bulkSaving}
              canRunAi={canRunAi}
              llmActionEnabled={llmActionEnabled}
              aiUnavailableReason={aiUnavailableReason}
              llmUnavailableReason={llmUnavailableReason}
              localAiCount={liveAiEligibleRows.length}
              llmCount={
                batchEligibleRows.length > 0 && !singleModSelection
                  ? "select one mod"
                  : batchEligibleRows.length
              }
              onCopySource={() => void copySelection("source")}
              onCopyTarget={() => void copySelection("target")}
              onMarkDone={() =>
                void applyStatus("translated", "keep", "Updated status")
              }
              onKeepOriginal={() =>
                void applyStatus("translated", "source", "Kept original text")
              }
              onClear={() =>
                void applyStatus(
                  "untranslated",
                  "clear",
                  "Cleared translations",
                )
              }
              onAi={startBatch}
              onLlmExport={() => void startLlmBatchExport()}
            />
          </ul>
        </>
      )}

      {batch && (
        <BatchTranslateDialog
          items={batch}
          modName={batchModLabel}
          engine={activeLiveEngine}
          onLiveRun={runLiveBatch}
          onCancelLiveRun={onCancelAi}
          onFinished={finishBatch}
          onClose={closeBatch}
        />
      )}
    </div>
  );
}
function ActionButtons({
  listItems = false,
  mutationPending,
  canRunAi,
  llmActionEnabled,
  aiUnavailableReason,
  llmUnavailableReason,
  localAiCount,
  llmCount,
  onCopySource,
  onCopyTarget,
  onMarkDone,
  onKeepOriginal,
  onClear,
  onAi,
  onLlmExport,
}: {
  listItems?: boolean;
  mutationPending: boolean;
  canRunAi: boolean;
  llmActionEnabled: boolean;
  aiUnavailableReason: string | null;
  llmUnavailableReason: string | null;
  localAiCount?: number | string;
  llmCount?: number | string;
  onCopySource: () => void;
  onCopyTarget: () => void;
  onMarkDone: () => void;
  onKeepOriginal: () => void;
  onClear: () => void;
  onAi: () => void;
  onLlmExport: () => void;
}) {
  const buttons = (
    <>
      <MenuAction listItem={listItems} onClick={onCopySource}>
        <Copy aria-hidden="true" /> Copy source text
      </MenuAction>
      <MenuAction listItem={listItems} onClick={onCopyTarget}>
        <CopyCheck aria-hidden="true" />{" "}
        {listItems ? "Copy translation" : "Copy translations"}
      </MenuAction>
      <MenuSeparator listItem={listItems} />
      <MenuAction
        listItem={listItems}
        disabled={mutationPending}
        title={mutationPending ? "A batch edit is being saved." : undefined}
        onClick={onMarkDone}
      >
        <CircleCheck aria-hidden="true" /> Mark as done
      </MenuAction>
      <MenuAction
        listItem={listItems}
        disabled={mutationPending}
        title={mutationPending ? "A batch edit is being saved." : undefined}
        onClick={onKeepOriginal}
      >
        <Equal aria-hidden="true" /> Keep original
      </MenuAction>
      <MenuAction
        listItem={listItems}
        disabled={mutationPending}
        title={mutationPending ? "A batch edit is being saved." : undefined}
        onClick={onClear}
      >
        <Eraser aria-hidden="true" />{" "}
        {listItems ? "Clear translation" : "Clear translations"}
      </MenuAction>
      <MenuSeparator listItem={listItems} />
      <MenuAction
        listItem={listItems}
        disabled={mutationPending || !canRunAi}
        title={
          mutationPending
            ? "A batch edit is being saved."
            : canRunAi
              ? "AI output is saved to Review."
              : (aiUnavailableReason ?? "Configure AI in Settings.")
        }
        onClick={onAi}
      >
        <span className="translator-menu-label">
          <Sparkles aria-hidden="true" /> Translate selected with AI
        </span>
        {localAiCount !== undefined && (
          <span className="translator-context-shortcut">({localAiCount})</span>
        )}
      </MenuAction>
      <MenuAction
        listItem={listItems}
        disabled={mutationPending || !llmActionEnabled}
        title={
          mutationPending
            ? "A batch edit is being saved."
            : (llmUnavailableReason ??
              "Export selected Open or Changed strings.")
        }
        onClick={onLlmExport}
      >
        <span className="translator-menu-label">
          <FileJson aria-hidden="true" />{" "}
          {listItems ? "Export LLM batch" : "Export selection as LLM batch"}
        </span>{" "}
        {llmCount !== undefined &&
          (typeof llmCount === "string" ? (
            <span className="translator-context-shortcut">· {llmCount}</span>
          ) : (
            <span className="translator-context-shortcut">({llmCount})</span>
          ))}
      </MenuAction>
    </>
  );
  return buttons;
}

function MenuAction({
  listItem,
  children,
  disabled = false,
  title,
  onClick,
}: {
  listItem: boolean;
  children: React.ReactNode;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
}) {
  const button = (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      disabled={disabled}
      title={title}
      onFocus={(event) => {
        const menu = event.currentTarget.closest<HTMLElement>('[role="menu"]');
        setMenuTabStop(menu, event.currentTarget);
      }}
      onClick={onClick}
    >
      {children}
    </button>
  );
  return listItem ? <li role="none">{button}</li> : button;
}

function MenuSeparator({ listItem }: { listItem: boolean }) {
  const separator = (
    <div className="translator-popover-divider" role="separator" />
  );
  return listItem ? <li role="none">{separator}</li> : separator;
}

function ColumnResizer({
  column,
  value,
  ariaLabel,
  measureRenderedWidth,
  onPointerDown,
  onKeyDown,
}: {
  column: ColumnName;
  value: number;
  ariaLabel: string;
  measureRenderedWidth: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLSpanElement>) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLSpanElement>) => void;
}) {
  const limits = COLUMN_LIMITS[column];
  const handleRef = useRef<HTMLSpanElement>(null);
  const [renderedValue, setRenderedValue] = useState(value);

  useLayoutEffect(() => {
    if (!measureRenderedWidth) {
      setRenderedValue(value);
      return;
    }
    const header = handleRef.current?.parentElement;
    if (!header) return;
    const measure = () => {
      const width = Math.round(header.getBoundingClientRect().width);
      setRenderedValue(
        width > 0 ? Math.min(limits.max, Math.max(limits.min, width)) : value,
      );
    };
    measure();
    window.addEventListener("resize", measure);
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(header);
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [limits.max, limits.min, measureRenderedWidth, value]);

  return (
    <span
      ref={handleRef}
      className={
        "translator-column-resizer" +
        (column === "target" ? " translator-column-resizer--target" : "")
      }
      role="separator"
      aria-label={ariaLabel}
      aria-orientation="vertical"
      aria-valuemin={limits.min}
      aria-valuemax={limits.max}
      aria-valuenow={renderedValue}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={(event) => event.preventDefault()}
    />
  );
}

function SortHeader({
  label,
  col,
  sort,
  onSort,
  resizer,
}: {
  label: string;
  col: SortCol;
  sort: { col: SortCol; dir: "asc" | "desc" } | null;
  onSort: (col: SortCol) => void;
  resizer?: React.ReactNode;
}) {
  const active = sort?.col === col;
  const SortIcon = !active
    ? ChevronsUpDown
    : sort.dir === "asc"
      ? ArrowUp
      : ArrowDown;
  return (
    <span
      className={
        "translator-" +
        (col === "target" ? "translation" : col) +
        "-col" +
        (resizer ? " translator-resizable-col" : "")
      }
      role="columnheader"
      style={{
        position: resizer ? "relative" : undefined,
        height: "27px",
        display: "flex",
        alignItems: "center",
        minWidth: 0,
        padding: "0 8px",
      }}
      aria-sort={
        active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"
      }
    >
      <button
        type="button"
        className={
          "stringrow__sort translator-sort-button" +
          (active ? " stringrow__sort--active" : "")
        }
        onClick={() => onSort(col)}
      >
        {label}
        <SortIcon aria-hidden="true" />
      </button>
      {resizer}
    </span>
  );
}

interface RowViewProps {
  row: Row;
  identity: string;
  dataIndex: number;
  showMod: boolean;
  showFile: boolean;
  searchQuery: string;
  searchLocale?: string;
  searchAllMetadata: boolean;
  translationColumnLabel: string;
  selected: boolean;
  tabStop: boolean;
  top: number;
  height: number;
  gridTemplateColumns: string;
  tableMinWidth: number;
  menuOpen: boolean;
  onToggle: () => void;
  onSelect: (event: ReactMouseEvent) => void;
  onContextMenu: (event: ReactMouseEvent) => void;
  onOpen: () => void;
  onMoreActions: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  onFocus: () => void;
  onBlur: (event: ReactFocusEvent<HTMLDivElement>) => void;
  onShowStatusHelp: (target: HTMLElement, text: string) => void;
  onHideStatusHelp: () => void;
}

function RowView({
  row,
  identity,
  dataIndex,
  showMod,
  showFile,
  searchQuery,
  searchLocale,
  searchAllMetadata,
  translationColumnLabel,
  selected,
  tabStop,
  top,
  height,
  gridTemplateColumns,
  tableMinWidth,
  menuOpen,
  onToggle,
  onSelect,
  onContextMenu,
  onOpen,
  onMoreActions,
  onKeyDown,
  onFocus,
  onBlur,
  onShowStatusHelp,
  onHideStatusHelp,
}: RowViewProps) {
  const issues = rowValidationIssues(row);
  const severity = worstSeverity(issues);
  const displayStatus = DISPLAY_STATUS[row.status];
  const statusHelp = STATUS_HELP[row.status];
  const issueHelp = issues.map((issue) => issue.message).join(" ");
  const matchesSearch = (value: string, metadata = false) =>
    Boolean(
      searchQuery &&
      (!metadata || searchAllMetadata) &&
      searchMatches(value, searchQuery, searchLocale),
    );
  const modMatches = matchesSearch(row.modName, true);
  const fileMatches = matchesSearch(row.file, true);
  const keyMatches = matchesSearch(row.key);
  const sourceMatches = matchesSearch(row.source);
  const targetMatches = matchesSearch(row.target);
  const modOverflow = useOverflowTitle<HTMLSpanElement>(
    row.modName,
    gridTemplateColumns,
  );
  const fileOverflow = useOverflowTitle<HTMLSpanElement>(
    row.file,
    gridTemplateColumns,
  );
  const keyOverflow = useOverflowTitle<HTMLButtonElement>(
    row.key,
    gridTemplateColumns,
  );
  const sourceOverflow = useOverflowTitle<HTMLSpanElement>(
    row.source,
    gridTemplateColumns,
  );
  const targetOverflow = useOverflowTitle<HTMLSpanElement>(
    row.target,
    gridTemplateColumns,
  );
  return (
    <div
      className={
        "stringrow stringrow--data translator-string-row" +
        (selected ? " stringrow--selected is-selected" : "")
      }
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        height,
        transform: "translateY(" + top + "px)",
        gridTemplateColumns,
        columnGap: 0,
        padding: 0,
        minWidth: tableMinWidth,
      }}
      role="row"
      aria-selected={selected}
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      aria-description={statusHelp}
      tabIndex={tabStop ? 0 : -1}
      data-string-row=""
      data-row-index={dataIndex}
      data-row-id={identity}
      data-status={row.status}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      onDoubleClick={(event) => {
        if (
          event.ctrlKey ||
          event.metaKey ||
          event.target instanceof HTMLInputElement
        ) {
          return;
        }
        onOpen();
      }}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null;
        if (!next || !event.currentTarget.contains(next)) onHideStatusHelp();
        onBlur(event);
      }}
    >
      <span
        className="translator-select-col"
        role="cell"
        style={{ padding: "4px 8px" }}
      >
        <input
          className="translator-selection-box"
          type="checkbox"
          aria-label={"Select " + row.key}
          checked={selected}
          tabIndex={-1}
          onClick={(event) => event.stopPropagation()}
          onChange={onToggle}
        />
      </span>
      {showMod && (
        <span
          className={
            "translator-global-mod-col" + (modMatches ? " is-search-match" : "")
          }
          role="cell"
          data-search-field="mod"
          aria-description={modMatches ? "Search match in Mod." : undefined}
          style={{ minWidth: 0, padding: "4px 8px" }}
        >
          <span
            ref={modOverflow.ref}
            className="translator-cell-clip translator-global-mod-text"
            title={modOverflow.title}
          >
            {row.modName}
          </span>
        </span>
      )}
      {showFile && (
        <span
          className={
            "stringrow__file translator-file-col" +
            (fileMatches ? " is-search-match" : "")
          }
          role="cell"
          data-search-field="file"
          aria-description={fileMatches ? "Search match in File." : undefined}
          style={{ minWidth: 0, padding: "4px 8px" }}
        >
          <span
            ref={fileOverflow.ref}
            className="translator-cell-clip"
            title={fileOverflow.title}
          >
            {row.file}
          </span>
        </span>
      )}
      <span
        className="stringrow__status translator-status-col"
        role="cell"
        style={{ minWidth: 0, padding: "4px 8px" }}
      >
        <span
          className={
            "translator-state" +
            (displayStatus.className ? " " + displayStatus.className : "")
          }
          data-status-help={statusHelp}
          aria-description={statusHelp}
          onPointerEnter={(event) =>
            onShowStatusHelp(event.currentTarget, statusHelp)
          }
          onPointerLeave={onHideStatusHelp}
        >
          {displayStatus.label}
        </span>
      </span>
      <span
        className={
          "stringrow__key translator-key-col" +
          (keyMatches ? " is-search-match" : "")
        }
        role="cell"
        data-search-field="key"
        aria-description={keyMatches ? "Search match in Key." : undefined}
        style={{ minWidth: 0, padding: "4px 8px" }}
      >
        <button
          ref={keyOverflow.ref}
          type="button"
          className="translator-key-button"
          title={keyOverflow.title}
          tabIndex={-1}
          onClick={(event) => {
            if (event.ctrlKey || event.metaKey) return;
            event.stopPropagation();
            onOpen();
          }}
        >
          {row.key}
        </button>
      </span>
      <span
        className={
          "stringrow__src translator-source-col" +
          (sourceMatches ? " is-search-match" : "")
        }
        role="cell"
        data-search-field="source"
        aria-description={
          sourceMatches ? "Search match in English source." : undefined
        }
        style={{ minWidth: 0, padding: "4px 8px" }}
      >
        <span
          ref={sourceOverflow.ref}
          className="translator-cell-clip"
          title={sourceOverflow.title}
        >
          {row.source}
        </span>
      </span>
      <span
        className={
          "stringrow__tgt translator-translation-col" +
          " translator-translation-cell" +
          (targetMatches ? " is-search-match" : "") +
          (row.target ? "" : " stringrow__tgt--empty") +
          (severity ? " has-validation-issue" : "")
        }
        role="cell"
        data-search-field="translation"
        aria-description={
          targetMatches
            ? `Search match in ${translationColumnLabel}.`
            : undefined
        }
        data-translation-cell=""
        style={{ minWidth: 0, paddingTop: 4, paddingBottom: 4, paddingLeft: 8 }}
      >
        <span
          ref={targetOverflow.ref}
          className="translator-cell-clip"
          title={targetOverflow.title}
        >
          {row.target || "—"}
        </span>
      </span>
      <span
        className="translator-row-actions-col"
        role="cell"
        aria-label={`Actions for ${row.key}`}
        style={{ gridColumn: "-2 / -1" }}
      >
        {severity && (
          <button
            className="translator-inline-validation"
            type="button"
            aria-label={issueHelp}
            data-status-help={issueHelp}
            onPointerEnter={(event) =>
              onShowStatusHelp(event.currentTarget, issueHelp)
            }
            onPointerLeave={onHideStatusHelp}
            onFocus={(event) =>
              onShowStatusHelp(event.currentTarget, issueHelp)
            }
            onBlur={onHideStatusHelp}
            onClick={(event) => {
              if (event.ctrlKey || event.metaKey) return;
              event.stopPropagation();
              onOpen();
            }}
          >
            !
          </button>
        )}
        <button
          className="translator-row-more"
          type="button"
          aria-label={"More actions for " + row.key}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          tabIndex={-1}
          onClick={onMoreActions}
        >
          <MoreHorizontal aria-hidden="true" />
        </button>
      </span>
    </div>
  );
}
