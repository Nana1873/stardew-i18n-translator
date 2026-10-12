import {
  useLayoutEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";

/** The Export… dialog asks which mods and where the output goes, then shows
 * the matching JSON or ZIP preview below. */
export type ExportScope = "mod" | "all";
export type ExportOutput = "json" | "zip";

export interface ExportChoice {
  scope: ExportScope;
  output: ExportOutput;
}

type ChoiceGroup = "mods" | "output";

/** Switching output swaps the JSON and ZIP dialogs. These session values keep
 * focus on the control the user just used and keep the dialog from shrinking
 * while it stays open. */
let focusGroup: ChoiceGroup = "mods";
let stickyHeight = 0;

/** Call when the Export… dialog opens fresh. */
export function resetExportDialogSession() {
  focusGroup = "mods";
  stickyHeight = 0;
}

/** Initial focus target for an export dialog that shows the chooser. */
export const EXPORT_CHOOSER_FOCUS = '[data-export-focus="true"]';

/** Keeps an open export dialog at least as tall as it has been, so switching
 * between the JSON and ZIP previews does not make it jump. */
export function useStickyExportHeight(
  dialogRef: RefObject<HTMLElement | null>,
  enabled: boolean,
) {
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!enabled || !dialog) return;
    const apply = () => {
      const limit = window.innerHeight - 48;
      dialog.style.minHeight = `${Math.min(stickyHeight, limit)}px`;
      stickyHeight = Math.max(stickyHeight, dialog.offsetHeight);
    };
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(apply);
    observer.observe(dialog);
    return () => observer.disconnect();
  });
}

function ChoiceRadios<T extends string>({
  id,
  group,
  label,
  value,
  options,
  busy,
  onChange,
}: {
  id: string;
  group: ChoiceGroup;
  label: string;
  value: T;
  options: { value: T; label: string; disabled?: boolean }[];
  busy: boolean;
  onChange: (value: T) => void;
}) {
  const groupRef = useRef<HTMLDivElement>(null);
  const select = (next: T) => {
    if (busy || next === value) return;
    focusGroup = group;
    onChange(next);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (!step) return;
    event.preventDefault();
    const enabled = options.filter((option) => !option.disabled);
    const index = enabled.findIndex((option) => option.value === value);
    const next = enabled[(index + step + enabled.length) % enabled.length];
    if (!next) return;
    select(next.value);
    groupRef.current
      ?.querySelector<HTMLElement>(`[data-value="${next.value}"]`)
      ?.focus();
  };
  return (
    <div className="desktop-xd-choice-group">
      <span id={id}>{label}</span>
      <div
        ref={groupRef}
        className="desktop-xd-seg"
        role="radiogroup"
        aria-labelledby={id}
        aria-busy={busy || undefined}
        onKeyDown={onKeyDown}
      >
        {options.map((option) => {
          const checked = value === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              data-value={option.value}
              data-export-focus={
                checked && focusGroup === group ? "true" : undefined
              }
              aria-checked={checked}
              tabIndex={checked ? 0 : -1}
              disabled={option.disabled}
              onClick={() => select(option.value)}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function ExportChooser({
  choice,
  modAvailable,
  busy = false,
  onChange,
}: {
  choice: ExportChoice;
  /** False when no mod is selected, so only All mods is possible. */
  modAvailable: boolean;
  /** True while a preview loads; further switches wait for it. */
  busy?: boolean;
  onChange: (choice: ExportChoice) => void;
}) {
  // The JSON preview shows its own destination block instead.
  const sentence =
    choice.output === "zip"
      ? choice.scope === "mod"
        ? "Saves one installable ZIP for this mod — for MO2, Vortex or a Nexus Mods upload."
        : "Saves one combined ZIP for all mods — for MO2, Vortex or a Nexus Mods upload."
      : null;
  return (
    <div className="desktop-xd-choice">
      <div className="desktop-xd-choice-groups">
        <ChoiceRadios
          id="translator-export-chooser-mods"
          group="mods"
          label="Mods"
          value={choice.scope}
          busy={busy}
          options={[
            { value: "mod", label: "This mod", disabled: !modAvailable },
            { value: "all", label: "All mods" },
          ]}
          onChange={(scope) => onChange({ ...choice, scope })}
        />
        <ChoiceRadios
          id="translator-export-chooser-output"
          group="output"
          label="Output"
          value={choice.output}
          busy={busy}
          options={[
            { value: "zip", label: "ZIP" },
            { value: "json", label: "JSON" },
          ]}
          onChange={(output) => onChange({ ...choice, output })}
        />
      </div>
      {sentence && <p className="desktop-xd-choice-sentence">{sentence}</p>}
    </div>
  );
}
