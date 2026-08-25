import {
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
} from "react";

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(
    dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter(
    (element) =>
      !element.closest("[hidden]") && !element.closest('[aria-hidden="true"]'),
  );
}

interface IsolationSnapshot {
  element: HTMLElement;
  inert: boolean;
  ariaHidden: string | null;
}

/**
 * Isolate the active modal at every nesting level. This also works for the
 * editor, which lives inside the string workbench instead of beside it.
 */
export function useModalIsolation(dialogRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const dialog = dialogRef.current;
    const root = dialog?.closest<HTMLElement>("#stv3-dense-demo");
    if (!dialog || !root) return;

    const snapshots: IsolationSnapshot[] = [];
    let active: HTMLElement = dialog;
    while (active !== root) {
      const parent = active.parentElement;
      if (!parent) break;
      for (const sibling of Array.from(parent.children)) {
        if (!(sibling instanceof HTMLElement) || sibling === active) continue;
        snapshots.push({
          element: sibling,
          inert: sibling.inert,
          ariaHidden: sibling.getAttribute("aria-hidden"),
        });
        sibling.inert = true;
        sibling.setAttribute("aria-hidden", "true");
      }
      active = parent;
    }

    return () => {
      for (const snapshot of snapshots.reverse()) {
        snapshot.element.inert = snapshot.inert;
        if (snapshot.ariaHidden == null) {
          snapshot.element.removeAttribute("aria-hidden");
        } else {
          snapshot.element.setAttribute("aria-hidden", snapshot.ariaHidden);
        }
      }
    };
  }, [dialogRef]);
}

/** The keyboard and focus behavior shared by the V3 modal overlays. */
export function useDialogAccessibility({
  dialogRef,
  onEscape,
  escapeDisabled = false,
  initialFocusSelector = FOCUSABLE_SELECTOR,
}: {
  dialogRef: RefObject<HTMLElement | null>;
  onEscape: () => void;
  escapeDisabled?: boolean;
  initialFocusSelector?: string;
}) {
  const returnFocusRef = useRef<HTMLElement | null>(null);
  useModalIsolation(dialogRef);

  const focusInitial = useCallback(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const preferred = dialog.querySelector<HTMLElement>(initialFocusSelector);
    (preferred ?? focusableElements(dialog)[0])?.focus();
  }, [dialogRef, initialFocusSelector]);

  useEffect(() => {
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const frame = requestAnimationFrame(focusInitial);
    return () => {
      cancelAnimationFrame(frame);
      const target = returnFocusRef.current;
      if (target?.isConnected) target.focus();
    };
  }, [focusInitial]);

  const onDialogKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      // A flow can be mounted above the string editor. Its keyboard events
      // must not trigger editor shortcuts in a lower modal layer.
      event.stopPropagation();

      if (event.key === "Escape") {
        event.preventDefault();
        if (!escapeDisabled) onEscape();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = focusableElements(event.currentTarget);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!focusable.includes(active as HTMLElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [escapeDisabled, onEscape],
  );

  return { focusInitial, onDialogKeyDown };
}
