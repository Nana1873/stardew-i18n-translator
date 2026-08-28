/**
 * String editor dialog (SPEC §§7-10).
 *
 * Opened by double-clicking a string row. Source on the left (read-only),
 * editable target on the right, with prev/next navigation, live validation, a
 * status badge, and keyboard shortcuts. Saving persists the target + status to
 * disk; the saved status follows the field (empty → untranslated, text →
 * translated).
 *
 * Shortcuts: Ctrl+Enter save · Ctrl+Shift+Enter save & next (review backlog
 * fast path) · Esc cancel · Alt+←/→ prev/next · F2/F3 keep original (copies
 * the source — an explicit identical translation, SPEC §9) · F4 reset (clears
 * the field) · Ctrl+F5 translate with the configured local AI.
 */
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  CopyCheck,
  Eraser,
  Equal,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import type {
  GlossaryEntry,
  StringStatus,
  TermKind,
  TranslationResult,
} from "../tauri/commands";

export interface EditorTranslationResult extends TranslationResult {
  engine?: string;
  model?: string;
  reasoning?: string;
  /** Live backend runs persist the suggestion to Review before returning. */
  persisted?: boolean;
}

export interface EditorSuggestionProvenance {
  /** Stable mod/file/key identity this metadata describes. */
  identity: string;
  engine: string;
  model: string;
  reasoning: string;
  persisted: boolean;
  /** Exact target value this metadata describes. */
  value: string;
}
import { validate } from "./validation";
import { describeToken, extractProtectedTokens } from "./protectedTokens";
import { STATUS_META, statusTint } from "./status";
import {
  DEFAULT_SHORTCUTS,
  type ResolvedShortcuts,
  displayShortcut,
  matchesShortcut,
} from "../shortcuts";
import { useModalIsolation } from "../dialogAccessibility";

export interface EditorRow {
  /** Stable package identity; file/key alone are not unique in All mods. */
  modUniqueId: string;
  key: string;
  source: string;
  /** Effective current target (saved edit or imported value). */
  target: string;
  file: string;
  targetPresent: boolean;
  status: StringStatus;
  /** This exact saved source/target pair was accepted despite token errors. */
  tokenMismatchAccepted: boolean;
  /** Nearest standalone `//` heading in default.json, if present. */
  section?: string | null;
}

interface StringEditorProps {
  row: EditorRow;
  index: number;
  total: number;
  modName: string;
  targetLanguageLabel?: string;
  /** Real configured engine metadata for this editor session. */
  aiEngineLabel?: string;
  aiModel?: string;
  aiReasoning?: string;
  /** Exact current-session metadata for an already persisted Review value. */
  suggestionProvenance?: EditorSuggestionProvenance;
  /** Live AI may only replace Open or Changed rows. */
  translationAllowed?: boolean;
  translationUnavailableReason?: string;
  reviewProgress?: { current: number; total: number };
  /** Official game glossary (typed entries), if built. */
  glossary?: GlossaryEntry[] | null;
  /** Translate the exact row through the configured live engine. */
  onTranslate?: (
    source: string,
    section?: string | null,
  ) => Promise<EditorTranslationResult>;
  /** Persist the edited target + status for this row. */
  onSave: (
    value: string,
    status: StringStatus,
    tokenMismatchAccepted: boolean,
  ) => Promise<void> | void;
  onClose: () => void;
  onNavigate: (delta: number) => void;
  onOpenEngineSettings?: () => void;
  onNotify?: (message: string, tone?: "info" | "success" | "error") => void;
  shortcuts?: ResolvedShortcuts;
}

/** Short label for a glossary term's category chip. */
const KIND_LABEL: Record<TermKind, string> = {
  item: "Item",
  bigCraftable: "Craftable",
  weapon: "Weapon",
  tool: "Tool",
  clothing: "Clothing",
  npc: "NPC",
  location: "Place",
  season: "Season",
};

/** Official glossary entries that occur as whole words in the source text.
 * Mirrors the Rust `match_entries`: case-sensitive (named entities are
 * capitalized, so a capitalized UI term like `Play` must not match the common
 * lowercase verb in prose), longest/most-specific terms claim their span first
 * (so `Iridium Ore` beats a bare `Ore`), capped at 15. A soft hint — precision
 * beats recall here. */
function matchGlossary(
  source: string,
  glossary: GlossaryEntry[] | null | undefined,
): GlossaryEntry[] {
  if (!glossary) return [];
  const isWord = (c: string | undefined) =>
    c !== undefined && /[\p{L}\p{N}]/u.test(c);
  // Longest source first; tie-break on source so output is deterministic.
  const sorted = [...glossary].sort(
    (a, b) =>
      b.source.length - a.source.length || a.source.localeCompare(b.source),
  );
  const occupied: Array<[number, number]> = [];
  const out: GlossaryEntry[] = [];
  for (const entry of sorted) {
    const term = entry.source;
    if (term.length < 3) continue;
    let searchFrom = 0;
    let match: [number, number] | null = null;
    while (searchFrom <= source.length - term.length) {
      const idx = source.indexOf(term, searchFrom);
      if (idx === -1) break;
      const end = idx + term.length;
      const wholeWord = !isWord(source[idx - 1]) && !isWord(source[end]);
      const overlaps = occupied.some(
        ([start, stop]) => idx < stop && start < end,
      );
      if (wholeWord && !overlaps) {
        match = [idx, end];
        break;
      }
      searchFrom = idx + 1;
    }
    if (!match) continue;
    occupied.push(match);
    out.push(entry);
    if (out.length >= 15) break;
  }
  return out;
}

/** Compact shortcut chip inside a button (docs/design/ §05); aria-hidden so
 * the accessible name stays clean. Full combos live in the button tooltips. */
function Kbd({ children }: { children: string }) {
  return (
    <kbd className="editor__kbd" aria-hidden>
      {children}
    </kbd>
  );
}

function countTokens(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of extractProtectedTokens(text)) {
    if (token === "\n" || token === "'") continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

function translationFieldLabel(label: string): string {
  if (/translation$/i.test(label)) return label;
  const language = label.replace(/\s+\([^)]*\)\s*$/, "").trim();
  return language === "Translation" ? language : `${language} translation`;
}

export function StringEditor({
  row,
  index,
  total,
  modName,
  targetLanguageLabel = "Translation",
  aiEngineLabel = "AI",
  aiModel,
  aiReasoning,
  suggestionProvenance,
  translationAllowed = true,
  translationUnavailableReason,
  reviewProgress,
  glossary,
  onTranslate,
  onSave,
  onClose,
  onNavigate,
  onOpenEngineSettings,
  onNotify,
  shortcuts = DEFAULT_SHORTCUTS,
}: StringEditorProps) {
  const suggestionIdentity = JSON.stringify([
    row.modUniqueId,
    row.file,
    row.key,
  ]);
  const [value, setValue] = useState(row.target);
  // A persisted review suggestion may be approved by saving it, or accepted
  // with edits. A fresh AI draft is tracked separately below because even an
  // edited AI draft must enter Review on its first successful persistence.
  const [reviewNeeded, setReviewNeeded] = useState(
    row.status === "review-needed",
  );
  const [aiDraftPending, setAiDraftPending] = useState(false);
  // True once the user changed anything (text, AI translate). Navigation
  // auto-saves on dirty.
  const [dirty, setDirty] = useState(false);
  const [mismatchAccepted, setMismatchAccepted] = useState(
    row.tokenMismatchAccepted,
  );
  const [pendingSave, setPendingSave] = useState<"close" | "next" | null>(null);
  const [pendingMove, setPendingMove] = useState<number | null>(null);
  const [translating, setTranslating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [translateMsg, setTranslateMsg] = useState<string | null>(null);
  const [translateMsgKind, setTranslateMsgKind] = useState<
    "note" | "ai-error" | "save-error"
  >("note");
  const [aiProvenance, setAiProvenance] =
    useState<EditorSuggestionProvenance | null>(
      suggestionProvenance?.identity === suggestionIdentity &&
        suggestionProvenance.value === row.target
        ? suggestionProvenance
        : null,
    );
  const [discardOpen, setDiscardOpen] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "source" | "target">(
    "idle",
  );
  const [statusTooltip, setStatusTooltip] = useState<{
    text: string;
    anchorLeft: number;
    anchorRight: number;
    anchorTop: number;
    anchorBottom: number;
    left: number;
    top: number;
  } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const statusTooltipRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const discardRef = useRef<HTMLElement>(null);
  const saveAnywayRef = useRef<HTMLElement>(null);
  const overlayStateRef = useRef({
    discardOpen: false,
    pendingSave: null as "close" | "next" | null,
    pendingMove: null as number | null,
  });
  overlayStateRef.current = { discardOpen, pendingSave, pendingMove };
  const aiRequest = useRef(0);
  const launcherRef = useRef<HTMLElement | null>(null);
  const rowIdentity = `${row.modUniqueId}\0${row.file}\0${row.key}\0${row.source}`;
  const rowIdentityRef = useRef(rowIdentity);
  rowIdentityRef.current = rowIdentity;
  useModalIsolation(dialogRef);

  useLayoutEffect(() => {
    if (!statusTooltip || !statusTooltipRef.current) return;
    const tip = statusTooltipRef.current.getBoundingClientRect();
    const anchorWidth = statusTooltip.anchorRight - statusTooltip.anchorLeft;
    const left = Math.min(
      window.innerWidth - tip.width - 8,
      Math.max(8, statusTooltip.anchorLeft + (anchorWidth - tip.width) / 2),
    );
    const below = statusTooltip.anchorBottom + 7;
    const top =
      below + tip.height <= window.innerHeight - 8
        ? below
        : Math.max(8, statusTooltip.anchorTop - tip.height - 7);
    if (left !== statusTooltip.left || top !== statusTooltip.top) {
      setStatusTooltip((current) =>
        current ? { ...current, left, top } : current,
      );
    }
  }, [statusTooltip]);

  useEffect(() => {
    if (!statusTooltip) return;
    const hide = () => setStatusTooltip(null);
    window.addEventListener("resize", hide);
    return () => window.removeEventListener("resize", hide);
  }, [statusTooltip]);

  useEffect(() => {
    launcherRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    return () => launcherRef.current?.focus();
  }, []);

  // Reset the field whenever the row changes (including via prev/next).
  useEffect(() => {
    aiRequest.current += 1;
    setTranslating(false);
    setValue(row.target);
    setReviewNeeded(row.status === "review-needed");
    setAiDraftPending(false);
    setMismatchAccepted(row.tokenMismatchAccepted);
    setPendingSave(null);
    setPendingMove(null);
    setDirty(false);
    setTranslateMsg(null);
    setTranslateMsgKind("note");
    setAiProvenance((current) => {
      if (
        suggestionProvenance?.identity === suggestionIdentity &&
        suggestionProvenance.value === row.target
      ) {
        return suggestionProvenance;
      }
      return current?.identity === suggestionIdentity &&
        current.persisted &&
        current.value === row.target
        ? current
        : null;
    });
    setDiscardOpen(false);
    setCopyState("idle");
    textareaRef.current?.focus();
  }, [
    rowIdentity,
    row.target,
    row.status,
    row.tokenMismatchAccepted,
    suggestionProvenance,
    suggestionIdentity,
  ]);

  useEffect(
    () => () => {
      aiRequest.current += 1;
    },
    [],
  );

  // The status to persist on auto-save (navigation): an unreviewed AI
  // suggestion stays review-needed; otherwise it follows the field
  // (empty → untranslated, text → translated).
  function effectiveStatus(): StringStatus {
    if (value.trim() === "") return "untranslated";
    if (aiDraftPending || reviewNeeded) return "review-needed";
    if (!dirty && row.status === "outdated") return "outdated";
    return "translated";
  }

  /** Explicit Save approves persisted Review rows, but a fresh AI draft must
   * first be persisted to Review even when the user edited the suggestion. */
  function confirmedStatus(): StringStatus {
    if (value.trim() === "") return "untranslated";
    return aiDraftPending ? "review-needed" : "translated";
  }

  /** Persist an explicit save after any required token-error confirmation. */
  async function persistConfirmed(
    destination: "close" | "next",
    acceptTokenMismatch: boolean,
  ) {
    if (saving) return;
    setSaving(true);
    setPendingSave(null);
    setTranslateMsg(null);
    try {
      await onSave(value, confirmedStatus(), acceptTokenMismatch);
      setAiDraftPending(false);
      if (destination === "next" && index < total - 1) onNavigate(1);
      else onClose();
    } catch (cause) {
      setTranslateMsg(String(cause));
      setTranslateMsgKind("save-error");
      textareaRef.current?.focus();
    } finally {
      setSaving(false);
    }
  }

  /** Save normally, or pause for a per-string token-error waiver. */
  function requestConfirmedSave(destination: "close" | "next") {
    if (saving || translating) return;
    if (blockingTokenIssues.length > 0 && !mismatchAccepted) {
      setPendingSave(destination);
      return;
    }
    void persistConfirmed(
      destination,
      blockingTokenIssues.length > 0 && mismatchAccepted,
    );
  }

  /** A manual edit approves an already-persisted Review row. A fresh AI draft
   * keeps its first-save Review gate until persistence succeeds. */
  function editValue(next: string) {
    if (translating) return;
    aiRequest.current += 1;
    setTranslating(false);
    setValue(next);
    setReviewNeeded(false);
    setMismatchAccepted(false);
    setPendingSave(null);
    setPendingMove(null);
    setDirty(next !== row.target);
    setAiProvenance(null);
  }

  async function handleTranslate() {
    if (translating) return;
    if (!translationAllowed || !onTranslate) {
      setTranslateMsg(
        translationUnavailableReason ??
          "Configure a translation engine in Settings to use AI translation.",
      );
      setTranslateMsgKind("ai-error");
      return;
    }
    const request = ++aiRequest.current;
    const identity = rowIdentity;
    setTranslating(true);
    setTranslateMsg(null);
    setTranslateMsgKind("note");
    try {
      const result = await onTranslate(row.source, row.section);
      if (request !== aiRequest.current || identity !== rowIdentityRef.current)
        return;
      setValue(result.text);
      setReviewNeeded(true); // an AI suggestion awaiting review
      setAiDraftPending(!result.persisted);
      setMismatchAccepted(false);
      setPendingSave(null);
      setPendingMove(null);
      setDirty(result.persisted ? false : result.text !== row.target);
      const engine = result.engine || aiEngineLabel;
      const model = result.model || aiModel;
      const reasoning = result.reasoning || aiReasoning;
      setAiProvenance(
        engine && model && reasoning
          ? {
              identity: suggestionIdentity,
              engine,
              model,
              reasoning,
              persisted: Boolean(result.persisted),
              value: result.text,
            }
          : null,
      );
      const notes: string[] = [];
      if (result.missingTokens.length > 0) {
        notes.push(
          `AI dropped token(s): ${result.missingTokens.join(", ")} — fix before saving.`,
        );
      }
      if (result.glossaryMisses.length > 0) {
        // Soft hint only — inflections make exact glossary matching too strict.
        notes.push(
          `Glossary terms possibly not used: ${result.glossaryMisses.join(", ")}.`,
        );
      }
      setTranslateMsg(notes.length > 0 ? notes.join(" ") : null);
      setTranslateMsgKind("note");
      textareaRef.current?.focus();
    } catch (cause) {
      if (request !== aiRequest.current) return;
      setTranslateMsg(String(cause));
      setTranslateMsgKind("ai-error");
    } finally {
      if (request === aiRequest.current) setTranslating(false);
    }
  }

  async function navigate(delta: number) {
    if (saving || translating) return;
    if (!(aiDraftPending || dirty || value !== row.target)) {
      aiRequest.current += 1;
      onNavigate(delta);
      return;
    }
    if (blockingTokenIssues.length > 0 && !mismatchAccepted) {
      setPendingMove(delta);
      return;
    }
    await persistNavigation(delta, mismatchAccepted);
  }

  async function persistNavigation(
    delta: number,
    acceptTokenMismatch: boolean,
  ) {
    setSaving(true);
    setPendingMove(null);
    try {
      await onSave(
        value,
        acceptTokenMismatch ? confirmedStatus() : effectiveStatus(),
        acceptTokenMismatch,
      );
      setAiDraftPending(false);
      aiRequest.current += 1;
      onNavigate(delta);
    } catch (cause) {
      setTranslateMsg(String(cause));
      setTranslateMsgKind("save-error");
      textareaRef.current?.focus();
    } finally {
      setSaving(false);
    }
  }

  /** Keep original (F2/F3): copy the source into the field — kept English is
   * an explicit identical translation, so outdated detection still applies. */
  function keepOriginal() {
    if (translating) return;
    editValue(row.source);
  }

  /** Reset (F4): clear the target field; the string becomes untranslated. */
  function reset() {
    if (translating) return;
    setValue("");
    setReviewNeeded(false);
    setMismatchAccepted(false);
    setPendingSave(null);
    setPendingMove(null);
    setDirty(row.target !== "");
    setAiProvenance(null);
    textareaRef.current?.focus();
  }

  function requestClose() {
    if (saving || translating) return;
    if (aiDraftPending || dirty || value !== row.target) {
      setDiscardOpen(true);
      return;
    }
    onClose();
  }

  async function copyText(kind: "source" | "target") {
    const text = kind === "source" ? row.source : value;
    try {
      await navigator.clipboard.writeText(text);
      setCopyState(kind);
      onNotify?.(
        kind === "source" ? "Source copied." : "Translation copied.",
        "success",
      );
      window.setTimeout(() => setCopyState("idle"), 1200);
    } catch {
      onNotify?.("Could not copy to the clipboard.", "error");
    }
  }

  /** Insert a protected token at the cursor (or replace the selection). */
  function insertToken(raw: string) {
    if (translating) return;
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? value.length;
    const end = textarea?.selectionEnd ?? value.length;
    const next = value.slice(0, start) + raw + value.slice(end);
    setValue(next);
    setReviewNeeded(false);
    setMismatchAccepted(false);
    setPendingSave(null);
    setPendingMove(null);
    setDirty(next !== row.target);
    setAiProvenance(null);
    requestAnimationFrame(() => {
      const caret = start + raw.length;
      textarea?.focus();
      textarea?.setSelectionRange(caret, caret);
    });
  }

  function onKeyDown(event: KeyboardEvent | ReactKeyboardEvent) {
    if (matchesShortcut(event, shortcuts["editor.saveNext"])) {
      event.preventDefault();
      requestConfirmedSave("next");
    } else if (matchesShortcut(event, shortcuts["editor.save"])) {
      event.preventDefault();
      requestConfirmedSave("close");
    } else if (matchesShortcut(event, shortcuts["editor.previous"])) {
      event.preventDefault();
      void navigate(-1);
    } else if (matchesShortcut(event, shortcuts["editor.next"])) {
      event.preventDefault();
      void navigate(1);
    } else if (matchesShortcut(event, shortcuts["editor.keepOriginal"])) {
      event.preventDefault();
      keepOriginal();
    } else if (matchesShortcut(event, shortcuts["editor.reset"])) {
      event.preventDefault();
      reset();
    } else if (matchesShortcut(event, shortcuts["editor.translate"])) {
      event.preventDefault();
      void handleTranslate();
    } else if (matchesShortcut(event, shortcuts["editor.close"])) {
      event.preventDefault();
      requestClose();
    }
  }

  const onKeyDownRef = useRef(onKeyDown);
  onKeyDownRef.current = onKeyDown;

  useEffect(() => {
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const modalDialogs = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[role="dialog"][aria-modal="true"]',
        ),
      ).filter((dialog) => !dialog.hidden);
      const topmostDialog = modalDialogs.at(-1);
      if (
        topmostDialog &&
        topmostDialog !== dialogRef.current &&
        !dialogRef.current?.contains(topmostDialog)
      ) {
        return;
      }
      const overlay = overlayStateRef.current;
      const overlayOpen = Boolean(
        overlay.discardOpen ||
        overlay.pendingSave ||
        overlay.pendingMove !== null,
      );
      if (event.key === "Escape" && overlay.discardOpen) {
        event.preventDefault();
        setDiscardOpen(false);
        requestAnimationFrame(() => textareaRef.current?.focus());
        return;
      }
      if (
        event.key === "Escape" &&
        (overlay.pendingSave || overlay.pendingMove !== null)
      ) {
        event.preventDefault();
        setPendingSave(null);
        setPendingMove(null);
        requestAnimationFrame(() => textareaRef.current?.focus());
        return;
      }
      if (event.key === "Tab") {
        const container =
          saveAnywayRef.current ?? discardRef.current ?? dialogRef.current;
        const focusable = container
          ? Array.from(
              container.querySelectorAll<HTMLElement>(
                'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
              ),
            ).filter((node) => !node.hasAttribute("hidden"))
          : [];
        if (focusable.length > 0) {
          const first = focusable[0];
          const last = focusable.at(-1)!;
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
            return;
          }
          if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
            return;
          }
        }
      }
      if (overlayOpen) return;
      onKeyDownRef.current(event);
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => {
      window.removeEventListener("keydown", handleGlobalKeyDown);
    };
  }, []);

  useEffect(() => {
    if (!(discardOpen || pendingSave || pendingMove !== null)) return;
    const nestedDialog = saveAnywayRef.current ?? discardRef.current;
    nestedDialog
      ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus();
  }, [discardOpen, pendingSave, pendingMove]);

  const sourceTokenCounts = countTokens(row.source);
  const valueTokenCounts = countTokens(value);
  const addedTokenCounts = [...valueTokenCounts].filter(
    ([token, found]) => found > (sourceTokenCounts.get(token) ?? 0),
  );
  const hasMissingTokens = [...sourceTokenCounts].some(
    ([token, required]) => (valueTokenCounts.get(token) ?? 0) < required,
  );
  const issues = validate(row.source, value, row.targetPresent);
  const blockingTokenIssues = issues.filter(
    (issue) =>
      issue.severity === "error" &&
      (issue.ruleId === "token-missing" || issue.ruleId === "token-added"),
  );
  const acceptedTokenMismatch =
    mismatchAccepted && blockingTokenIssues.length > 0;
  const unacceptedErrors = issues.filter(
    (issue) =>
      issue.severity === "error" &&
      !(
        acceptedTokenMismatch &&
        (issue.ruleId === "token-missing" || issue.ruleId === "token-added")
      ),
  );
  const visibleIssues = acceptedTokenMismatch
    ? issues.filter(
        (issue) =>
          issue.ruleId !== "token-missing" && issue.ruleId !== "token-added",
      )
    : issues;
  const shownStatus = row.status;
  const shownStatusLabel: Record<StringStatus, string>[StringStatus] = {
    untranslated: "Open",
    outdated: "Changed",
    "review-needed": "Review",
    translated: "Done",
  }[shownStatus];
  const glossaryMatches = matchGlossary(row.source, glossary);
  const targetFieldLabel = translationFieldLabel(targetLanguageLabel);
  const targetLanguageName = targetFieldLabel.replace(/\s+translation$/i, "");
  const targetHelpName =
    targetLanguageName === "Translation" ? "target" : targetLanguageName;
  const statusHelp: Record<StringStatus, string> = {
    untranslated: `No accepted ${targetHelpName} translation exists yet.`,
    outdated: `The English source changed after this ${targetHelpName} translation was saved. The existing translation may be outdated and should be reviewed.`,
    "review-needed":
      "This imported or AI-generated suggestion still needs human approval.",
    translated: `The ${targetHelpName} translation was explicitly saved or accepted for the current English source.`,
  };
  const atQueueEnd = index >= total - 1;
  const textEdited = value !== row.target;
  const nestedConfirmationOpen =
    discardOpen || pendingSave !== null || pendingMove !== null;
  const nestedContentIsolation = nestedConfirmationOpen
    ? { "aria-hidden": true as const, inert: true }
    : {};
  let saveLabel = "Save";
  let saveNextLabel = atQueueEnd ? "Save & close" : "Save & next";
  if (row.status === "review-needed") {
    saveLabel = textEdited ? "Save edited suggestion" : "Approve suggestion";
    saveNextLabel = textEdited
      ? atQueueEnd
        ? "Save edit & close"
        : "Save edit & next"
      : atQueueEnd
        ? "Approve & close"
        : "Approve & next";
  } else if (row.status === "outdated") {
    saveLabel = textEdited ? "Save update" : "Keep translation";
    saveNextLabel = textEdited
      ? atQueueEnd
        ? "Save update & close"
        : "Save update & next"
      : atQueueEnd
        ? "Keep & close"
        : "Keep & next";
  }
  const discardSuggestion = row.status === "review-needed";

  return (
    <div className="editor__backdrop translator-editor-overlay">
      <section
        ref={dialogRef}
        className="editor translator-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby="translator-editor-title"
        aria-describedby="translator-editor-context-description"
      >
        <header
          className="editor__meta translator-editor-head"
          {...nestedContentIsolation}
        >
          <span className="editor__title translator-editor-title">
            <span className="translator-kicker">Edit string</span>
            <h2 className="translator-heading" id="translator-editor-title">
              {row.key}
            </h2>
          </span>
          <span className="editor__meta-right translator-editor-meta">
            <span className="editor__crumbs">
              <span id="translator-editor-context-description">
                {modName} · {row.file}
              </span>{" "}
              <span className="translator-editor-meta-separator" aria-hidden>
                ·
              </span>{" "}
              {reviewProgress
                ? `${reviewProgress.current} / ${reviewProgress.total}`
                : `${index + 1} / ${total}`}
            </span>
            <span
              className={`editor__status translator-state${
                shownStatus === "translated"
                  ? " is-ready"
                  : shownStatus === "review-needed"
                    ? " is-review"
                    : shownStatus === "outdated"
                      ? " is-change"
                      : ""
              }`}
              style={{
                color: STATUS_META[shownStatus].color,
                borderColor: statusTint(STATUS_META[shownStatus].color, 0.5),
                background: statusTint(STATUS_META[shownStatus].color, 0.14),
              }}
              data-status-help={statusHelp[shownStatus]}
              aria-description={statusHelp[shownStatus]}
              onPointerEnter={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setStatusTooltip({
                  text: statusHelp[shownStatus],
                  anchorLeft: rect.left,
                  anchorRight: rect.right,
                  anchorTop: rect.top,
                  anchorBottom: rect.bottom,
                  left: rect.left,
                  top: rect.bottom + 7,
                });
              }}
              onPointerLeave={() => setStatusTooltip(null)}
              onFocus={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setStatusTooltip({
                  text: statusHelp[shownStatus],
                  anchorLeft: rect.left,
                  anchorRight: rect.right,
                  anchorTop: rect.top,
                  anchorBottom: rect.bottom,
                  left: rect.left,
                  top: rect.bottom + 7,
                });
              }}
              onBlur={() => setStatusTooltip(null)}
            >
              <span aria-hidden>{STATUS_META[shownStatus].glyph}</span>{" "}
              {shownStatusLabel}
            </span>
            <button
              className="translator-icon-button"
              type="button"
              aria-label="Close editor"
              onClick={requestClose}
              disabled={saving || translating}
            >
              <X aria-hidden />
            </button>
          </span>
        </header>

        <div className="translator-editor-body" {...nestedContentIsolation}>
          {/* Reserved slots (SPEC §§5, 7 and 10): tokens + glossary rows exist on every
            string — empty-state text when N/A — so the panes and the action
            bar never move during a Save & next run. */}
          <div className="translator-editor-support">
            <div className="editor__slot translator-editor-support-row">
              <span className="editor__slot-label translator-editor-support-label">
                Protected tokens
              </span>
              <span className="editor__slot-body translator-glossary-hints">
                {sourceTokenCounts.size > 0 || addedTokenCounts.length > 0 ? (
                  <>
                    {[...sourceTokenCounts].map(([token, required], i) => {
                      const satisfied =
                        (valueTokenCounts.get(token) ?? 0) >= required;
                      const contents = (
                        <>
                          {describeToken(token)}
                          {required > 1 ? ` ×${required}` : ""}
                          {satisfied ? " ✓" : ""}
                        </>
                      );
                      return satisfied ? (
                        <span
                          key={`source-${i}-${token}`}
                          className="editor__token translator-token editor__token--done is-valid"
                          title={`${token} — all present`}
                          aria-label={`Token ${token} is present in full`}
                        >
                          {contents}
                        </span>
                      ) : (
                        <button
                          key={`source-${i}-${token}`}
                          type="button"
                          className={`editor__token translator-token${acceptedTokenMismatch ? " is-missing is-accepted" : " is-missing"}`}
                          title={
                            acceptedTokenMismatch
                              ? `${token} — mismatch explicitly accepted for this exact translation`
                              : `Insert ${token} at the cursor`
                          }
                          aria-label={`Insert missing token ${token}`}
                          onClick={() => insertToken(token)}
                        >
                          {contents}
                        </button>
                      );
                    })}
                    {addedTokenCounts.map(([token, found], i) => (
                      <span
                        key={`added-${i}-${token}`}
                        className={`editor__token translator-token is-missing${acceptedTokenMismatch ? " is-accepted" : ""}`}
                        aria-label={`Extra token ${token}`}
                        title={`Extra token ${token}`}
                      >
                        {describeToken(token)}
                        {found > 1 ? ` ×${found}` : ""}
                      </span>
                    ))}
                    {hasMissingTokens && (
                      <span className="translator-kicker">
                        Click a missing token to insert it
                      </span>
                    )}
                  </>
                ) : (
                  <span className="editor__slot-empty translator-kicker">
                    None
                  </span>
                )}
              </span>
            </div>

            <div className="editor__slot translator-editor-support-row">
              <span className="editor__slot-label translator-editor-support-label">
                Glossary hints
              </span>
              <span className="editor__slot-body translator-glossary-hints">
                {glossaryMatches.length > 0 ? (
                  glossaryMatches.map((match, i) => (
                    <span
                      key={i}
                      className="editor__gloss translator-glossary-term"
                      title={KIND_LABEL[match.kind]}
                    >
                      <span className="editor__gloss-kind" aria-hidden>
                        {KIND_LABEL[match.kind]}
                      </span>
                      {match.source} → {match.target}
                    </span>
                  ))
                ) : (
                  <span className="editor__slot-empty translator-kicker">
                    No matching hints
                  </span>
                )}
              </span>
            </div>
            {aiProvenance &&
              (row.status === "review-needed" || aiDraftPending) && (
                <div className="translator-editor-support-row">
                  <span className="translator-editor-support-label">
                    Generated by
                  </span>
                  <span className="translator-provenance-copy">
                    <strong>{aiProvenance.engine}</strong> ·{" "}
                    {aiProvenance.persisted
                      ? "Saved to Review"
                      : aiDraftPending
                        ? "Draft in editor"
                        : "Awaiting review"}{" "}
                    · {aiProvenance.model} · {aiProvenance.reasoning}
                  </span>
                </div>
              )}
          </div>

          <div className="editor__panes translator-editor-columns">
            <div className="editor__pane translator-field translator-editor-field">
              <div className="translator-editor-field-head">
                <span>
                  {row.status === "outdated"
                    ? "English source update"
                    : "English source"}
                </span>
                <button
                  className="translator-icon-button translator-editor-copy"
                  type="button"
                  aria-label="Copy current English source"
                  onClick={() => void copyText("source")}
                >
                  {copyState === "source" ? (
                    <CopyCheck aria-hidden />
                  ) : (
                    <Copy aria-hidden />
                  )}
                </button>
              </div>
              {row.status === "outdated" ? (
                <div className="translator-update-source">
                  <div className="translator-update-source-row is-previous">
                    <span>Previous English</span>
                    <div>Unavailable</div>
                  </div>
                  <div className="translator-update-source-row is-current">
                    <span>Current English</span>
                    <div>{row.source}</div>
                  </div>
                </div>
              ) : (
                <div className="translator-editor-source">{row.source}</div>
              )}
            </div>
            <div className="editor__pane translator-field translator-editor-field">
              <span className="translator-editor-field-head">
                <label htmlFor="translator-editor-translation">
                  {targetFieldLabel}
                </label>
                <button
                  className="translator-icon-button translator-editor-copy"
                  type="button"
                  aria-label="Copy translation"
                  onClick={(event) => {
                    event.preventDefault();
                    void copyText("target");
                  }}
                >
                  {copyState === "target" ? (
                    <CopyCheck aria-hidden />
                  ) : (
                    <Copy aria-hidden />
                  )}
                </button>
              </span>
              <textarea
                id="translator-editor-translation"
                className="translator-textarea"
                ref={textareaRef}
                value={value}
                onChange={(event) => editValue(event.target.value)}
                readOnly={saving || translating}
              />
            </div>
          </div>

          {/* Reserved validation line (fixed min-height — see editor__slot note). */}
          <div
            className={`editor__validation translator-validation${unacceptedErrors.length > 0 ? " is-error" : acceptedTokenMismatch || visibleIssues.length > 0 ? " is-warning" : ""}`}
            role="status"
            aria-live="polite"
          >
            {issues.length === 0 ? (
              <>
                <ShieldCheck aria-hidden />
                <span className="editor__valid-ok">No issues found</span>
              </>
            ) : (
              <>
                <ShieldAlert aria-hidden />
                {acceptedTokenMismatch && (
                  <span className="editor__issue editor__issue--warning">
                    Protected-token mismatch explicitly accepted for this exact
                    translation. Export is allowed; editing requires
                    confirmation again.
                  </span>
                )}
                {visibleIssues.map((issue, i) => (
                  <span
                    key={i}
                    className={`editor__issue editor__issue--${issue.severity}`}
                  >
                    {issue.message}
                  </span>
                ))}
              </>
            )}
            {translateMsg && translateMsgKind === "note" && (
              <span className="editor__ai-msg">{translateMsg}</span>
            )}
          </div>

          {translateMsg && translateMsgKind !== "note" && (
            <div
              className="translator-flow-callout is-error translator-editor-ai-error"
              role="alert"
            >
              <span>{translateMsg}</span>
              {translateMsgKind === "ai-error" && onOpenEngineSettings && (
                <button
                  className="translator-button translator-button-quiet"
                  type="button"
                  onClick={onOpenEngineSettings}
                >
                  Open Translation engines
                </button>
              )}
            </div>
          )}
        </div>

        {(pendingSave || pendingMove !== null) && (
          <div className="translator-flow-overlay">
            <section
              ref={saveAnywayRef}
              className="translator-flow-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="translator-save-anyway-title"
              aria-describedby="translator-save-anyway-description"
            >
              <div className="translator-flow-head">
                <div>
                  <h2
                    className="translator-heading"
                    id="translator-save-anyway-title"
                  >
                    Protected token missing
                  </h2>
                  <div
                    className="translator-kicker"
                    id="translator-save-anyway-description"
                  >
                    This translation may appear incomplete or broken in game.
                  </div>
                </div>
                <button
                  className="translator-icon-button"
                  type="button"
                  aria-label="Return to editor"
                  onClick={() => {
                    setPendingSave(null);
                    setPendingMove(null);
                    requestAnimationFrame(() => textareaRef.current?.focus());
                  }}
                >
                  <X aria-hidden />
                </button>
              </div>
              <div className="translator-flow-body">
                {blockingTokenIssues.map((issue) => (
                  <p key={issue.message}>{issue.message}</p>
                ))}
                <div className="translator-flow-callout is-warning">
                  “Save anyway” applies only to this source revision and this
                  exact translation. Any later edit requires confirmation again.
                </div>
              </div>
              <div className="translator-flow-foot">
                <button
                  className="translator-button translator-button-quiet"
                  type="button"
                  onClick={() => {
                    setPendingSave(null);
                    setPendingMove(null);
                    requestAnimationFrame(() => textareaRef.current?.focus());
                  }}
                >
                  Return to editor
                </button>
                <button
                  type="button"
                  className="editor__save-anyway translator-button translator-button-primary"
                  onClick={() => {
                    if (pendingSave) void persistConfirmed(pendingSave, true);
                    else if (pendingMove !== null)
                      void persistNavigation(pendingMove, true);
                  }}
                >
                  Save anyway
                </button>
              </div>
            </section>
          </div>
        )}

        <footer
          className="editor__footer translator-editor-actions"
          {...nestedContentIsolation}
        >
          <div className="translator-command-actions">
            <button
              type="button"
              className="editor__iconbtn translator-icon-button"
              onClick={() => void navigate(-1)}
              disabled={saving || translating || index === 0}
              aria-label="Previous string"
              title={`Previous string — saves changes (${displayShortcut(shortcuts["editor.previous"])})`}
            >
              <ChevronLeft aria-hidden />
            </button>
            <button
              type="button"
              className="editor__iconbtn translator-icon-button"
              onClick={() => void navigate(1)}
              disabled={saving || translating || index >= total - 1}
              aria-label="Next string"
              title={`Next string — saves changes (${displayShortcut(shortcuts["editor.next"])})`}
            >
              <ChevronRight aria-hidden />
            </button>
            <button
              type="button"
              className="translator-button translator-button-quiet"
              onClick={keepOriginal}
              disabled={saving || translating}
              title={`Keep the original text (${displayShortcut(shortcuts["editor.keepOriginal"])})`}
            >
              <Equal aria-hidden /> Keep original
            </button>
            <button
              type="button"
              className="translator-button translator-button-quiet"
              onClick={reset}
              disabled={saving || translating}
              aria-label={
                discardSuggestion
                  ? "Discard this review suggestion; save to return the string to Open"
                  : undefined
              }
              title={`${discardSuggestion ? "Discard this review suggestion" : "Clear the translation"} (${displayShortcut(shortcuts["editor.reset"])})`}
            >
              <Eraser aria-hidden />
              {discardSuggestion ? "Discard suggestion" : "Clear"}
            </button>
            <button
              type="button"
              className="editor__ai-btn translator-button translator-button-quiet"
              onClick={() => void handleTranslate()}
              disabled={translating || saving || !translationAllowed}
              title={
                translationAllowed && onTranslate
                  ? `Translate with ${aiEngineLabel} — result lands in Review (${displayShortcut(shortcuts["editor.translate"])})`
                  : (translationUnavailableReason ??
                    "This translation engine is unavailable. Open Translation engines in Settings.")
              }
            >
              <Sparkles aria-hidden />
              {translating ? "Translating…" : "Translate with AI"}{" "}
              <span className="translator-context-shortcut">
                {aiEngineLabel}
              </span>
            </button>
          </div>
          <div className="translator-command-actions">
            <button
              type="button"
              className="translator-button translator-button-quiet"
              onClick={() => requestConfirmedSave("close")}
              disabled={saving || translating}
              title={`${saveLabel} (${displayShortcut(shortcuts["editor.save"])})`}
            >
              {saveLabel} <Kbd>{displayShortcut(shortcuts["editor.save"])}</Kbd>
            </button>
            <button
              type="button"
              className="editor__save translator-button translator-button-primary"
              onClick={() => requestConfirmedSave("next")}
              disabled={saving || translating}
              title={`${saveNextLabel} (${displayShortcut(shortcuts["editor.saveNext"])})`}
            >
              {saveNextLabel}{" "}
              <Kbd>{displayShortcut(shortcuts["editor.saveNext"])}</Kbd>
            </button>
          </div>
        </footer>

        {statusTooltip && (
          <div
            ref={statusTooltipRef}
            className="translator-status-tooltip"
            role="tooltip"
            style={{ left: statusTooltip.left, top: statusTooltip.top }}
            {...nestedContentIsolation}
          >
            {statusTooltip.text}
          </div>
        )}

        {discardOpen && (
          <div className="translator-flow-overlay">
            <section
              ref={discardRef}
              className="translator-flow-dialog translator-flow-dialog-compact"
              role="dialog"
              aria-modal="true"
              aria-labelledby="translator-discard-title"
              aria-describedby="translator-discard-description"
            >
              <div className="translator-flow-head">
                <div>
                  <h2
                    className="translator-heading"
                    id="translator-discard-title"
                  >
                    Discard changes?
                  </h2>
                  <div
                    className="translator-kicker"
                    id="translator-discard-description"
                  >
                    The current translation has not been saved yet.
                  </div>
                </div>
              </div>
              <div className="translator-flow-foot">
                <button
                  className="translator-button translator-button-quiet"
                  type="button"
                  onClick={() => {
                    setDiscardOpen(false);
                    requestAnimationFrame(() => textareaRef.current?.focus());
                  }}
                >
                  Continue editing
                </button>
                <button
                  className="translator-button translator-button-danger"
                  type="button"
                  onClick={onClose}
                >
                  Close without saving
                </button>
              </div>
            </section>
          </div>
        )}
      </section>
    </div>
  );
}
