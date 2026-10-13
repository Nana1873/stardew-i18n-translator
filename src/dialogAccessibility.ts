import {
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
} from "react";

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], summary, [tabindex]:not([tabindex="-1"])';

function availableForFocus(element: HTMLElement): boolean {
  const closedDetails = element.closest("details:not([open])");
  return (
    !element.matches(":disabled") &&
    !element.closest("[hidden], [inert]") &&
    !element.closest('[aria-hidden="true"]') &&
    (!closedDetails || element === closedDetails.querySelector("summary"))
  );
}

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(
    dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter((element) => element.tabIndex >= 0 && availableForFocus(element));
}

interface IsolationSnapshot {
  /** How many open dialogs currently hide this element. */
  count: number;
  inert: boolean;
  ariaHidden: string | null;
}

/** Where focus returns when a dialog closes, by dialog element. */
const returnTargets = new WeakMap<HTMLElement, HTMLElement | null>();

/** The state before the first dialog hid an element. Dialogs can overlap
 * briefly (the Export… dialog swaps its JSON and ZIP previews), so the
 * original state is restored only when the last of them closes. */
const isolated = new Map<HTMLElement, IsolationSnapshot>();

function hide(element: HTMLElement) {
  const snapshot = isolated.get(element);
  if (snapshot) {
    snapshot.count++;
    return;
  }
  isolated.set(element, {
    count: 1,
    inert: element.inert,
    ariaHidden: element.getAttribute("aria-hidden"),
  });
  element.inert = true;
  element.setAttribute("aria-hidden", "true");
}

function release(element: HTMLElement) {
  const snapshot = isolated.get(element);
  if (!snapshot) return;
  snapshot.count--;
  if (snapshot.count > 0) return;
  isolated.delete(element);
  element.inert = snapshot.inert;
  if (snapshot.ariaHidden == null) element.removeAttribute("aria-hidden");
  else element.setAttribute("aria-hidden", snapshot.ariaHidden);
}

/**
 * Isolate the active modal at every nesting level. This also works for the
 * editor, which lives inside the string workbench instead of beside it.
 */
export function useModalIsolation(dialogRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const dialog = dialogRef.current;
    const root = dialog?.closest<HTMLElement>("#stardew-i18n-translator");
    if (!dialog || !root) return;

    const hidden: HTMLElement[] = [];
    let active: HTMLElement = dialog;
    while (active !== root) {
      const parent = active.parentElement;
      if (!parent) break;
      for (const sibling of Array.from(parent.children)) {
        if (!(sibling instanceof HTMLElement) || sibling === active) continue;
        hide(sibling);
        hidden.push(sibling);
      }
      active = parent;
    }

    return () => {
      for (const element of hidden.reverse()) release(element);
    };
  }, [dialogRef]);
}

/** The keyboard and focus behavior shared by the application modal overlays. */
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
    const focusable = focusableElements(dialog);
    // A deliberate initial target may be programmatically focusable (-1),
    // such as scan diagnostics, without joining the normal Tab order.
    const preferred =
      initialFocusSelector === FOCUSABLE_SELECTOR
        ? focusable[0]
        : Array.from(
            dialog.querySelectorAll<HTMLElement>(initialFocusSelector),
          ).find(availableForFocus);
    (preferred ?? focusable[0] ?? dialog).focus();
  }, [dialogRef, initialFocusSelector]);

  useEffect(() => {
    const active =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    returnFocusRef.current = active;
    // When this dialog replaces another one (the Export… dialog swaps its
    // JSON and ZIP previews), focus returns to where that one came from.
    const owner = active?.closest<HTMLElement>('[aria-modal="true"]');
    const fallback = owner ? (returnTargets.get(owner) ?? null) : null;
    const dialog = dialogRef.current;
    if (dialog) returnTargets.set(dialog, fallback ?? active);
    const frame = requestAnimationFrame(focusInitial);
    return () => {
      cancelAnimationFrame(frame);
      const target = returnFocusRef.current;
      if (target?.isConnected) target.focus();
      else if (fallback?.isConnected) fallback.focus();
    };
  }, [dialogRef, focusInitial]);

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
