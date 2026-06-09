/**
 * String editor dialog — M2 / Issue 8 (SPEC §7.5).
 *
 * Opened by double-clicking a string row. Source on the left (read-only),
 * editable target on the right, with prev/next navigation, live validation, a
 * status badge, and keyboard shortcuts. Saving persists the target + status to
 * disk; the saved status follows the field (empty → untranslated, text →
 * translated) unless not-translatable is chosen.
 *
 * Shortcuts: Ctrl+Enter save · Esc cancel · Alt+←/→ prev/next · F2 toggle
 * not-translatable · F3 copy original · F4 reset (clears the field).
 */
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from "react";
import type { StringStatus } from "../tauri/commands";
import { validate } from "./validation";
import { describeToken, extractProtectedTokens } from "./protectedTokens";
import { STATUS_META } from "./status";

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
  const isWord = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);
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

/** The status to save into: keep an explicit not-translatable choice, otherwise
 * saving marks the string translated. */
function initialSaveStatus(status: StringStatus): StringStatus {
  return status === "not-translatable" ? "not-translatable" : "translated";
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
  onSave,
  onClose,
  onNavigate,
}: StringEditorProps) {
  const [value, setValue] = useState(row.target);
  const [status, setStatus] = useState<StringStatus>(initialSaveStatus(row.status));
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Reset the field whenever the row changes (including via prev/next).
  useEffect(() => {
    setValue(row.target);
    setStatus(initialSaveStatus(row.status));
    textareaRef.current?.focus();
  }, [row.key, row.file, row.target, row.status]);

  // The status to persist: an explicit not-translatable choice is kept;
  // otherwise it follows the field (empty → untranslated, text → translated).
  function effectiveStatus(): StringStatus {
    if (status === "not-translatable") return "not-translatable";
    return value.trim() === "" ? "untranslated" : "translated";
  }

  function save() {
    onSave(value, effectiveStatus());
    onClose();
  }

  function navigate(delta: number) {
    if (value !== row.target) onSave(value, effectiveStatus());
    onNavigate(delta);
  }

  function toggleNotTranslatable() {
    setStatus((current) => (current === "not-translatable" ? "translated" : "not-translatable"));
  }

  /** Reset (F4): clear the target field; the string becomes untranslated. */
  function reset() {
    setValue("");
    setStatus("translated"); // drop any not-translatable; empty value → untranslated
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

  function onKeyDown(event: ReactKeyboardEvent) {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      save();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.altKey && event.key === "ArrowLeft") {
      event.preventDefault();
      navigate(-1);
    } else if (event.altKey && event.key === "ArrowRight") {
      event.preventDefault();
      navigate(1);
    } else if (event.key === "F2") {
      event.preventDefault();
      toggleNotTranslatable();
    } else if (event.key === "F3") {
      event.preventDefault();
      setValue(row.source);
    } else if (event.key === "F4") {
      event.preventDefault();
      reset();
    }
  }

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
      onKeyDown={onKeyDown}
    >
      <div className="editor">
        <header className="editor__meta">
          <span className="editor__title">
            <code>{row.key}</code>
          </span>
          <span className="editor__meta-right">
            <button
              type="button"
              className="editor__status"
              style={{
                color: STATUS_META[shownStatus].color,
                borderColor: STATUS_META[shownStatus].color,
              }}
              onClick={toggleNotTranslatable}
              title="Toggle translated / not-translatable (F2)"
            >
              ● {STATUS_META[shownStatus].label}
            </button>
            <span className="editor__crumbs">
              {modName} · {row.file} · {index + 1}/{total}
            </span>
          </span>
        </header>

        {sourceTokenCounts.size > 0 && (
          <div className="editor__tokens">
            Tokens (click to insert):{" "}
            {[...sourceTokenCounts].map(([token, required], i) => {
              const satisfied = (valueTokenCounts.get(token) ?? 0) >= required;
              return (
                <button
                  key={i}
                  type="button"
                  className={`editor__token${satisfied ? " editor__token--done" : ""}`}
                  title={satisfied ? `${token} — all present` : `Insert ${token}`}
                  onClick={() => insertToken(token)}
                >
                  {describeToken(token)}
                  {required > 1 ? ` ×${required}` : ""}
                  {satisfied ? " ✓" : ""}
                </button>
              );
            })}
          </div>
        )}

        {glossaryMatches.length > 0 && (
          <div className="editor__glossary">
            Glossary (click to insert):{" "}
            {glossaryMatches.map((match, i) => (
              <button
                key={i}
                type="button"
                className="editor__gloss"
                title={`Insert “${match.translation}”`}
                onClick={() => insertToken(match.translation)}
              >
                {match.term} → {match.translation}
              </button>
            ))}
          </div>
        )}

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
              onChange={(event) => setValue(event.target.value)}
              aria-label="Translation"
            />
          </label>
        </div>

        <div className="editor__validation">
          {issues.length === 0 ? (
            <span className="editor__valid-ok">✓ All checks passed</span>
          ) : (
            issues.map((issue, i) => (
              <span key={i} className={`editor__issue editor__issue--${issue.severity}`}>
                {issue.message}
              </span>
            ))
          )}
        </div>

        <footer className="editor__footer">
          <button type="button" onClick={() => navigate(-1)} disabled={index === 0}>
            ◀ Prev <Kbd>Alt+←</Kbd>
          </button>
          <button
            type="button"
            onClick={() => navigate(1)}
            disabled={index >= total - 1}
          >
            Next ▶ <Kbd>Alt+→</Kbd>
          </button>
          <span className="editor__spacer" />
          <button type="button" onClick={() => setValue(row.source)}>
            Copy original <Kbd>F3</Kbd>
          </button>
          <button type="button" onClick={reset}>
            Reset <Kbd>F4</Kbd>
          </button>
          <button type="button" onClick={onClose}>
            Cancel <Kbd>Esc</Kbd>
          </button>
          <button type="button" className="editor__save" onClick={save}>
            Save <Kbd>Ctrl+Enter</Kbd>
          </button>
        </footer>
      </div>
    </div>
  );
}
