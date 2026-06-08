/**
 * String editor dialog — M2 / Issue 8 (SPEC §7.5).
 *
 * Opened by double-clicking a string row. Source on the left (read-only),
 * editable target on the right, with prev/next navigation and keyboard
 * shortcuts. Saving updates the in-memory translation; disk persistence and the
 * full status model arrive in Issue 10. Validation panel is a placeholder until
 * Issue 9.
 *
 * Shortcuts: Ctrl+Enter save · Esc cancel · Alt+←/→ prev/next · F3 copy
 * original · F4 reset.
 */
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from "react";
import { validate } from "./validation";
import { describeToken, extractProtectedTokens } from "./protectedTokens";

export interface EditorRow {
  key: string;
  source: string;
  /** Effective current target (saved edit or imported value). */
  target: string;
  file: string;
  targetPresent: boolean;
}

interface StringEditorProps {
  row: EditorRow;
  index: number;
  total: number;
  modName: string;
  /** Persist the edited target for this row. */
  onSave: (value: string) => void;
  onClose: () => void;
  onNavigate: (delta: number) => void;
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
  onSave,
  onClose,
  onNavigate,
}: StringEditorProps) {
  const [value, setValue] = useState(row.target);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Reset the field whenever the row changes (including via prev/next).
  useEffect(() => {
    setValue(row.target);
    textareaRef.current?.focus();
  }, [row.key, row.file, row.target]);

  function save() {
    onSave(value);
    onClose();
  }

  function navigate(delta: number) {
    if (value !== row.target) onSave(value);
    onNavigate(delta);
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
    } else if (event.key === "F3") {
      event.preventDefault();
      setValue(row.source);
    } else if (event.key === "F4") {
      event.preventDefault();
      setValue(row.target);
    }
  }

  const sourceTokenCounts = countTokens(row.source);
  const valueTokenCounts = countTokens(value);
  const issues = validate(row.source, value, row.targetPresent);

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
          <span className="editor__crumbs">
            {modName} · {row.file} · {index + 1}/{total}
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
          <button type="button" onClick={() => setValue(row.target)}>
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
