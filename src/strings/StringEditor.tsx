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

export interface EditorRow {
  key: string;
  source: string;
  /** Effective current target (saved edit or imported value). */
  target: string;
  file: string;
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

const TOKEN_RE = /\{\{([^}]+)\}\}/g;

function tokensOf(text: string): string[] {
  return Array.from(text.matchAll(TOKEN_RE), (match) => match[0]);
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

  const sourceTokens = tokensOf(row.source);

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

        {sourceTokens.length > 0 && (
          <div className="editor__tokens">
            Tokens:{" "}
            {sourceTokens.map((token, i) => (
              <code key={i} className="editor__token">
                {token}
              </code>
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

        <div className="editor__validation">Validation runs in the next step.</div>

        <footer className="editor__footer">
          <button type="button" onClick={() => navigate(-1)} disabled={index === 0}>
            ◀ Prev
          </button>
          <button
            type="button"
            onClick={() => navigate(1)}
            disabled={index >= total - 1}
          >
            Next ▶
          </button>
          <span className="editor__spacer" />
          <button type="button" onClick={() => setValue(row.source)}>
            Copy original
          </button>
          <button type="button" onClick={() => setValue(row.target)}>
            Reset
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="editor__save" onClick={save}>
            Save
          </button>
        </footer>
      </div>
    </div>
  );
}
