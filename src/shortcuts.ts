export const SHORTCUT_COMMANDS = [
  {
    id: "table.search",
    group: "String table",
    label: "Focus string search",
    defaultShortcut: "Ctrl+F",
  },
  {
    id: "table.edit",
    group: "String table",
    label: "Edit string",
    defaultShortcut: "Enter",
  },
  {
    id: "table.selectAll",
    group: "String table",
    label: "Select all visible strings",
    defaultShortcut: "Ctrl+A",
  },
  {
    id: "editor.save",
    group: "String editor",
    label: "Save and close",
    defaultShortcut: "Ctrl+Enter",
  },
  {
    id: "editor.saveNext",
    group: "String editor",
    label: "Save and open next",
    defaultShortcut: "Ctrl+Shift+Enter",
  },
  {
    id: "editor.previous",
    group: "String editor",
    label: "Previous string",
    defaultShortcut: "Alt+ArrowLeft",
  },
  {
    id: "editor.next",
    group: "String editor",
    label: "Next string",
    defaultShortcut: "Alt+ArrowRight",
  },
  {
    id: "editor.keepOriginal",
    group: "String editor",
    label: "Keep original",
    defaultShortcut: "F2",
  },
  {
    id: "editor.reset",
    group: "String editor",
    label: "Clear translation",
    defaultShortcut: "F4",
  },
  {
    id: "editor.translate",
    group: "String editor",
    label: "Translate with AI",
    // F5 and Ctrl+F5 reload the WebView, so the default stays off browser keys.
    defaultShortcut: "F8",
  },
  {
    id: "editor.close",
    group: "String editor",
    label: "Close editor",
    defaultShortcut: "Escape",
  },
] as const;

export type ShortcutCommand = (typeof SHORTCUT_COMMANDS)[number]["id"];
export type ShortcutSettings = Partial<Record<ShortcutCommand, string>>;
export type ResolvedShortcuts = Record<ShortcutCommand, string>;

export const DEFAULT_SHORTCUTS = Object.fromEntries(
  SHORTCUT_COMMANDS.map((command) => [command.id, command.defaultShortcut]),
) as ResolvedShortcuts;

export function resolveShortcuts(
  shortcuts?: ShortcutSettings | null,
): ResolvedShortcuts {
  // Saved overrides that are no longer allowed (for example Tab from an older
  // version) fall back to the default instead of trapping keyboard focus.
  const valid = Object.entries(shortcuts ?? {}).filter(
    ([, value]) => typeof value === "string" && shortcutProblem(value) === null,
  );
  return { ...DEFAULT_SHORTCUTS, ...Object.fromEntries(valid) };
}

function normalizedKey(key: string): string | null {
  if (["Control", "Shift", "Alt", "Meta"].includes(key)) return null;
  if (key === " ") return "Space";
  if (key.length === 1) return key.toUpperCase();
  return key;
}

export function shortcutFromEvent(
  event: Pick<
    KeyboardEvent,
    "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey"
  >,
): string | null {
  const key = normalizedKey(event.key);
  if (!key) return null;
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push("Ctrl");
  if (event.shiftKey) parts.push("Shift");
  if (event.altKey) parts.push("Alt");
  parts.push(key);
  return parts.join("+");
}

export function matchesShortcut(
  event: Pick<
    KeyboardEvent,
    "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey"
  >,
  shortcut: string,
): boolean {
  return shortcutFromEvent(event) === shortcut;
}

export function displayShortcut(shortcut: string): string {
  return shortcut
    .replace("ArrowLeft", "←")
    .replace("ArrowRight", "→")
    .replace("ArrowUp", "↑")
    .replace("ArrowDown", "↓");
}

// Keys the WebView would handle itself: reload, find next, and print. The
// app blocks their browser action (see blockBrowserKeys), so they can never
// work as app shortcuts either.
const BROWSER_KEYS = new Set([
  "F5",
  "Ctrl+F5",
  "Shift+F5",
  "Ctrl+R",
  "Ctrl+Shift+R",
  "F3",
  "Shift+F3",
  "Ctrl+P",
  "Ctrl+Shift+P",
]);

const RESERVED_SHORTCUTS = new Set([
  "Alt+F4",
  "Ctrl+W",
  "Ctrl+Shift+I",
  "Ctrl+Shift+J",
  ...BROWSER_KEYS,
]);

/** True for keys whose default WebView action (reload, print, find next) must not run. */
export function isBrowserKey(
  event: Pick<
    KeyboardEvent,
    "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey"
  >,
): boolean {
  const shortcut = shortcutFromEvent(event);
  return shortcut !== null && BROWSER_KEYS.has(shortcut);
}

/**
 * Stops the WebView from reloading (F5, Ctrl+R) or opening print or find
 * (Ctrl+P, F3) inside the desktop app, where a reload would drop unsaved
 * edits. Tauri 2 has no option to turn these browser keys off.
 */
export function blockBrowserKeys(target: Window = window): () => void {
  const handler = (event: KeyboardEvent) => {
    if (isBrowserKey(event)) event.preventDefault();
  };
  target.addEventListener("keydown", handler, true);
  return () => target.removeEventListener("keydown", handler, true);
}

export function shortcutProblem(shortcut: string): string | null {
  if (RESERVED_SHORTCUTS.has(shortcut))
    return "This combination is reserved by the app window or web runtime.";

  const parts = shortcut.split("+");
  const key = parts.at(-1) ?? "";
  if (key === "Tab") return "Tab is reserved for keyboard navigation.";
  const hasModifier = parts.length > 1;
  // Shift alone still types (Shift+Space, Shift+Backspace), so editing keys
  // need Ctrl, Alt, or Meta to be usable as commands inside a text field.
  const hasCommandModifier = parts
    .slice(0, -1)
    .some((part) => part !== "Shift");
  const isFunctionKey = /^F([1-9]|1[0-2])$/.test(key);
  const isConfirmKey = key === "Enter" || key === "Escape";
  // Keys that edit or move the caret inside a text field. Without a modifier
  // they would fire while typing a translation (Backspace bound to "Clear
  // translation" would empty the field on every keystroke).
  const isEditingKey = [
    "Space",
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "ArrowDown",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "Delete",
    "Backspace",
  ].includes(key);

  if (!hasCommandModifier && isEditingKey)
    return "Typing keys such as Space, Backspace, Delete, and the arrow keys need Ctrl or Alt so they stay usable in text fields.";
  if (!hasCommandModifier && hasModifier && /^[A-Za-z0-9]$/.test(key))
    return "Shift with a letter or number types a character; add Ctrl or Alt.";
  if (!hasModifier && !isFunctionKey && !isConfirmKey)
    return "Use Ctrl or Alt with letters and numbers.";
  return null;
}
