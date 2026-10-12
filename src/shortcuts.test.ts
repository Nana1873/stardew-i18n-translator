import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHORTCUTS,
  displayShortcut,
  matchesShortcut,
  resolveShortcuts,
  shortcutFromEvent,
  blockBrowserKeys,
  isBrowserKey,
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

  it("rejects bare typing keys that would fire inside text fields", () => {
    for (const key of ["Backspace", "Delete", "Space", "ArrowLeft", "Home"]) {
      expect(shortcutProblem(key)).toMatch(/text fields/);
    }
    expect(shortcutProblem("Ctrl+Backspace")).toBeNull();
    expect(shortcutProblem("Shift+Delete")).toMatch(/text fields/);
    expect(shortcutProblem("Shift+Enter")).toBeNull();
    expect(shortcutProblem("Shift+K")).toMatch(/types a character/);
    expect(shortcutProblem("Ctrl+Shift+K")).toBeNull();
    expect(shortcutProblem("Enter")).toBeNull();
    expect(shortcutProblem("Escape")).toBeNull();
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

  it("keeps browser keys free for app shortcuts and Ctrl+F5 as the AI default", () => {
    // Their browser action is blocked instead (see blockBrowserKeys).
    for (const shortcut of ["F5", "Ctrl+F5", "F3", "Ctrl+P"]) {
      expect(shortcutProblem(shortcut)).toBeNull();
    }
    expect(shortcutProblem("Ctrl+R")).toMatch(/reserved/);
    expect(DEFAULT_SHORTCUTS["editor.translate"]).toBe("Ctrl+F5");
    expect(
      resolveShortcuts({ "editor.translate": "Ctrl+Shift+T" })[
        "editor.translate"
      ],
    ).toBe("Ctrl+Shift+T");
  });

  it("blocks the browser action of reload and print keys only", () => {
    const stop = blockBrowserKeys(window);
    const press = (init: KeyboardEventInit) => {
      const event = new KeyboardEvent("keydown", {
        ...init,
        cancelable: true,
      });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(press({ key: "F5" })).toBe(true);
    expect(press({ key: "F5", ctrlKey: true })).toBe(true);
    expect(press({ key: "r", ctrlKey: true })).toBe(true);
    expect(press({ key: "p", ctrlKey: true })).toBe(true);
    expect(press({ key: "F3" })).toBe(true);
    expect(press({ key: "F8" })).toBe(false);
    expect(press({ key: "c", ctrlKey: true })).toBe(false);
    stop();
    expect(press({ key: "F5" })).toBe(false);
    expect(
      isBrowserKey({
        key: "F2",
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
      }),
    ).toBe(false);
  });

  it("uses compact arrow glyphs for display", () => {
    expect(displayShortcut("Alt+ArrowLeft")).toBe("Alt+←");
  });
});
