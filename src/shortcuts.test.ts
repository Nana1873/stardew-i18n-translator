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
    expect(shortcuts["table.search"]).toBe("Ctrl+F");
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

  it("drops saved overrides that are no longer allowed", () => {
    const resolved = resolveShortcuts({
      "editor.save": "Tab",
      "editor.close": "Ctrl+Tab",
      "editor.reset": "F8",
    });
    expect(resolved["editor.save"]).toBe(DEFAULT_SHORTCUTS["editor.save"]);
    expect(resolved["editor.close"]).toBe(DEFAULT_SHORTCUTS["editor.close"]);
    expect(resolved["editor.reset"]).toBe("F8");
  });

  it("never accepts Tab so keyboard navigation keeps working", () => {
    expect(shortcutProblem("Tab")).toMatch(/keyboard navigation/);
    expect(shortcutProblem("Shift+Tab")).toMatch(/keyboard navigation/);
    expect(shortcutProblem("Ctrl+Tab")).toMatch(/keyboard navigation/);
  });

  it("uses compact arrow glyphs for display", () => {
    expect(displayShortcut("Alt+ArrowLeft")).toBe("Alt+←");
  });
});
