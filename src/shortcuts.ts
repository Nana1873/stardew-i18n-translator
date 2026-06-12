export const SHORTCUT_COMMANDS = [
  {
    id: "table.edit",
    group: "String table",
    label: "Edit selected string",
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
    label: "Keep original text",
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
    label: "Translate with local AI",
    defaultShortcut: "Ctrl+F5",
  },
  {
    id: "editor.close",
    group: "String editor",
    label: "Close without saving",
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
  return { ...DEFAULT_SHORTCUTS, ...(shortcuts ?? {}) };
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

const RESERVED_SHORTCUTS = new Set([
  "Alt+F4",
  "Ctrl+W",
  "Ctrl+R",
  "Ctrl+Shift+I",
  "Ctrl+Shift+J",
]);

export function shortcutProblem(shortcut: string): string | null {
  if (RESERVED_SHORTCUTS.has(shortcut))
    return "This combination is reserved by the app window or web runtime.";

  const parts = shortcut.split("+");
  const key = parts.at(-1) ?? "";
  const hasModifier = parts.length > 1;
  const isFunctionKey = /^F([1-9]|1[0-2])$/.test(key);
  const isNavigationKey = [
    "Enter",
    "Escape",
    "Tab",
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

  if (!hasModifier && !isFunctionKey && !isNavigationKey)
    return "Use Ctrl, Shift, or Alt with letters and numbers.";
  return null;
}
