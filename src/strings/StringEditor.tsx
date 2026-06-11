/**
 * String editor dialog — M2 / Issue 8 (SPEC §7.5).
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
 * the field) · Ctrl+F5 translate with the local AI (M6).
 */
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import type { StringStatus, TranslationResult } from "../tauri/commands";
import { validate } from "./validation";
import { describeToken, extractProtectedTokens } from "./protectedTokens";
import { STATUS_META, statusTint } from "./status";

export interface EditorRow {
  key: string;
  source: string;
  /** Effective current target (saved edit or imported value). */
  target: string;
  file: string;
  targetPresent: boolean;
  status: StringStatus;
}

interface StringEditorProps {
  row: EditorRow;
  index: number;
  total: number;
  modName: string;
  /** Official game glossary (english -> target), if built. */
  glossary?: Record<string, string> | null;
  /** Translate the source via the local AI (M6); absent when no AI is configured. */
  onTranslate?: (source: string) => Promise<TranslationResult>;
  /** Persist the edited target + status for this row. */
  onSave: (value: string, status: StringStatus) => void;
  onClose: () => void;
  onNavigate: (delta: number) => void;
}

/** Official glossary terms that occur as whole words in the source text. */
function matchGlossary(
  source: string,
  glossary: Record<string, string> | null | undefined,
): Array<{ term: string; translation: string }> {
  if (!glossary) return [];
  const lower = source.toLowerCase();
  const out: Array<{ term: string; translation: string }> = [];
  const isWord = (c: string | undefined) =>
    c !== undefined && /[\p{L}\p{N}]/u.test(c);
  for (const [term, translation] of Object.entries(glossary)) {
    if (term.length < 3) continue;
    const idx = lower.indexOf(term.toLowerCase());
    if (idx === -1) continue;
    if (isWord(lower[idx - 1]) || isWord(lower[idx + term.length])) continue;
    out.push({ term, translation });
    if (out.length >= 15) break;
  }
  return out;
}

/** Small shortcut hint on a button; aria-hidden so the accessible name stays clean. */
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
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

export function StringEditor({
  row,
  index,
  total,
  modName,
  glossary,
  onTranslate,
  onSave,
  onClose,
  onNavigate,
}: StringEditorProps) {
  const [value, setValue] = useState(row.target);
  // True while the current target is an unreviewed AI suggestion (M6). Cleared
  // when the user edits the field; confirmed away by Save → translated.
  const [reviewNeeded, setReviewNeeded] = useState(
    row.status === "review-needed",
  );
  // True once the user changed anything (text, AI translate). Navigation
  // auto-saves on dirty.
  const [dirty, setDirty] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [translateMsg, setTranslateMsg] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Reset the field whenever the row changes (including via prev/next).
  useEffect(() => {
    setValue(row.target);
    setReviewNeeded(row.status === "review-needed");
    setDirty(false);
    setTranslateMsg(null);
    textareaRef.current?.focus();
  }, [row.key, row.file, row.target, row.status]);

  // The status to persist on auto-save (navigation): an unreviewed AI
  // suggestion stays review-needed; otherwise it follows the field
  // (empty → untranslated, text → translated).
  function effectiveStatus(): StringStatus {
    if (value.trim() === "") return "untranslated";
    if (reviewNeeded) return "review-needed";
    return "translated";
  }

  /** The status an explicit Save confirms to (the user has reviewed it). */
  function confirmedStatus(): StringStatus {
    return value.trim() === "" ? "untranslated" : "translated";
  }

  /** Explicit Save (Ctrl+Enter): the user has reviewed it → confirm to translated. */
  function save() {
    onSave(value, confirmedStatus());
    onClose();
  }

  /** Save & next (Ctrl+Shift+Enter): confirm like Save, then jump to the next
   * string instead of closing — the fast path for working through a long
   * review-needed backlog. Closes on the last string. */
  function saveAndNext() {
    onSave(value, confirmedStatus());
    if (index < total - 1) onNavigate(1);
    else onClose();
  }

  /** Edit the target by hand: it is now the user's own text, no longer a pending AI suggestion. */
  function editValue(next: string) {
    setValue(next);
    setReviewNeeded(false);
    setDirty(true);
  }

  async function handleTranslate() {
    if (!onTranslate) {
      setTranslateMsg("Configure a local AI in Settings to use translation.");
      return;
    }
    setTranslating(true);
    setTranslateMsg(null);
    try {
      const result = await onTranslate(row.source);
      setValue(result.text);
      setReviewNeeded(true); // an AI suggestion awaiting review
      setDirty(true);
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
      textareaRef.current?.focus();
    } catch (cause) {
      setTranslateMsg(String(cause));
    } finally {
      setTranslating(false);
    }
  }

  function navigate(delta: number) {
    if (dirty || value !== row.target) onSave(value, effectiveStatus());
    onNavigate(delta);
  }

  /** Keep original (F2/F3): copy the source into the field — kept English is
   * an explicit identical translation, so outdated detection still applies. */
  function keepOriginal() {
    editValue(row.source);
  }

  /** Reset (F4): clear the target field; the string becomes untranslated. */
  function reset() {
    setValue("");
    setReviewNeeded(false);
    setDirty(true);
    textareaRef.current?.focus();
  }

  /** Insert a protected token at the cursor (or replace the selection). */
  function insertToken(raw: string) {
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? value.length;
    const end = textarea?.selectionEnd ?? value.length;
    const next = value.slice(0, start) + raw + value.slice(end);
    setValue(next);
    requestAnimationFrame(() => {
      const caret = start + raw.length;
      textarea?.focus();
      textarea?.setSelectionRange(caret, caret);
    });
  }

  function onKeyDown(event: KeyboardEvent | ReactKeyboardEvent) {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (event.shiftKey) saveAndNext();
      else save();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.altKey && event.key === "ArrowLeft") {
      event.preventDefault();
      navigate(-1);
    } else if (event.altKey && event.key === "ArrowRight") {
      event.preventDefault();
      navigate(1);
    } else if (event.key === "F2" || event.key === "F3") {
      event.preventDefault();
      keepOriginal();
    } else if (event.key === "F4") {
      event.preventDefault();
      reset();
    } else if ((event.ctrlKey || event.metaKey) && event.key === "F5") {
      event.preventDefault();
      void handleTranslate();
    }
  }

  const onKeyDownRef = useRef(onKeyDown);
  onKeyDownRef.current = onKeyDown;

  useEffect(() => {
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      onKeyDownRef.current(event);
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => {
      window.removeEventListener("keydown", handleGlobalKeyDown);
    };
  }, []);

  const sourceTokenCounts = countTokens(row.source);
  const valueTokenCounts = countTokens(value);
  const issues = validate(row.source, value, row.targetPresent);
  const shownStatus = effectiveStatus();
  const glossaryMatches = matchGlossary(row.source, glossary);

  return (
    <div
      className="editor__backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Edit string"
    >
      <div className="editor">
        <header className="editor__meta">
          <span className="editor__title">
            <code>{row.key}</code>
          </span>
          <span className="editor__meta-right">
            <span className="editor__crumbs">
              {modName} · {row.file} · {index + 1}/{total}
            </span>
            <span
              className="editor__status"
              style={{
                color: STATUS_META[shownStatus].color,
                borderColor: statusTint(STATUS_META[shownStatus].color, 0.5),
                background: statusTint(STATUS_META[shownStatus].color, 0.14),
              }}
              title="Status this string will be saved with"
            >
              <span aria-hidden>{STATUS_META[shownStatus].glyph}</span>{" "}
              {STATUS_META[shownStatus].label}
            </span>
          </span>
        </header>

        {/* Reserved slots (SPEC §7.5): tokens + glossary rows exist on every
            string — empty-state text when N/A — so the panes and the action
            bar never move during a Save & next run. */}
        <div className="editor__slot">
          <span className="editor__slot-label">Tokens</span>
          <span className="editor__slot-body">
            {sourceTokenCounts.size > 0 ? (
              [...sourceTokenCounts].map(([token, required], i) => {
                const satisfied =
                  (valueTokenCounts.get(token) ?? 0) >= required;
                return (
                  <button
                    key={i}
                    type="button"
                    className={`editor__token${satisfied ? " editor__token--done" : ""}`}
                    title={
                      satisfied
                        ? `${token} — all present`
                        : `Insert ${token} at the cursor`
                    }
                    onClick={() => insertToken(token)}
                  >
                    {describeToken(token)}
                    {required > 1 ? ` ×${required}` : ""}
                    {satisfied ? " ✓" : ""}
                  </button>
                );
              })
            ) : (
              <span className="editor__slot-empty">— none —</span>
            )}
          </span>
        </div>

        <div className="editor__slot">
          <span className="editor__slot-label">Glossary</span>
          <span className="editor__slot-body">
            {glossaryMatches.length > 0 ? (
              glossaryMatches.map((match, i) => (
                <button
                  key={i}
                  type="button"
                  className="editor__gloss"
                  title={`Insert “${match.translation}” at the cursor`}
                  onClick={() => insertToken(match.translation)}
                >
                  {match.term} → {match.translation}
                </button>
              ))
            ) : (
              <span className="editor__slot-empty">— no hints —</span>
            )}
          </span>
        </div>

        <div className="editor__panes">
          <label className="editor__pane">
            <span>Original (English)</span>
            <textarea readOnly value={row.source} />
          </label>
          <label className="editor__pane">
            <span>Translation</span>
            <textarea
              ref={textareaRef}
              value={value}
              onChange={(event) => editValue(event.target.value)}
              aria-label="Translation"
            />
          </label>
        </div>

        {/* Reserved validation line (fixed min-height — see editor__slot note). */}
        <div className="editor__validation">
          {issues.length === 0 ? (
            <span className="editor__valid-ok">✓ No issues</span>
          ) : (
            issues.map((issue, i) => (
              <span
                key={i}
                className={`editor__issue editor__issue--${issue.severity}`}
              >
                {issue.message}
              </span>
            ))
          )}
          {translateMsg && (
            <span className="editor__ai-msg">{translateMsg}</span>
          )}
        </div>

        <footer className="editor__footer">
          <button
            type="button"
            className="editor__save"
            onClick={saveAndNext}
            title="Confirm this string and jump to the next one"
          >
            Save & next <Kbd>Ctrl+Shift+Enter</Kbd>
          </button>
          <button type="button" onClick={save}>
            Save <Kbd>Ctrl+Enter</Kbd>
          </button>
          <button
            type="button"
            className="editor__ai-btn"
            onClick={() => void handleTranslate()}
            disabled={translating}
            title={
              onTranslate
                ? "Translate with the local AI (Ctrl+F5)"
                : "Configure a local AI in Settings"
            }
          >
            {translating ? "Translating…" : "Translate"} <Kbd>Ctrl+F5</Kbd>
          </button>
          <span className="editor__spacer" />
          <button
            type="button"
            className="editor__iconbtn"
            onClick={() => navigate(-1)}
            disabled={index === 0}
            aria-label="Prev"
            title="Previous string — saves changes (Alt+←)"
          >
            ‹
          </button>
          <button
            type="button"
            className="editor__iconbtn"
            onClick={() => navigate(1)}
            disabled={index >= total - 1}
            aria-label="Next"
            title="Next string — saves changes (Alt+→)"
          >
            ›
          </button>
          <button
            type="button"
            className="editor__iconbtn"
            onClick={keepOriginal}
            aria-label="Keep original"
            title="Keep the original text — copies it as the translation (F2)"
          >
            ⧉
          </button>
          <button
            type="button"
            className="editor__iconbtn"
            onClick={reset}
            aria-label="Reset"
            title="Clear the translation (F4)"
          >
            ↺
          </button>
          <button
            type="button"
            className="editor__iconbtn"
            onClick={onClose}
            aria-label="Cancel"
            title="Close without saving (Esc)"
          >
            ✕
          </button>
        </footer>
      </div>
    </div>
  );
}
