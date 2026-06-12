import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHORTCUTS,
  displayShortcut,
  matchesShortcut,
  resolveShortcuts,
  shortcutFromEvent,
  shortcutProblem,
} from "./shortcuts";

describe("shortcuts", () => {
  it("merges persisted overrides with defaults", () => {
    const shortcuts = resolveShortcuts({ "editor.save": "Ctrl+S" });
    expect(shortcuts["editor.save"]).toBe("Ctrl+S");
    expect(shortcuts["editor.close"]).toBe(DEFAULT_SHORTCUTS["editor.close"]);
  });

  it("normalizes and matches keyboard events", () => {
    const event = {
      key: "s",
      ctrlKey: true,
      metaKey: false,
      shiftKey: true,
      altKey: false,
    };
    expect(shortcutFromEvent(event)).toBe("Ctrl+Shift+S");
    expect(matchesShortcut(event, "Ctrl+Shift+S")).toBe(true);
  });

  it("rejects reserved combinations and unsafe bare letters", () => {
    expect(shortcutProblem("Alt+F4")).toMatch(/reserved/);
    expect(shortcutProblem("A")).toMatch(/Ctrl/);
    expect(shortcutProblem("F6")).toBeNull();
  });

  it("uses compact arrow glyphs for display", () => {
    expect(displayShortcut("Alt+ArrowLeft")).toBe("Alt+←");
  });
});
