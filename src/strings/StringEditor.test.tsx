/**
 * StringEditor in isolation — the editor only talks through its callbacks, so
 * no Tauri mock is needed. Focus: the save/navigate/dirty state machine that
 * the table tests don't cover (status-only changes, discard paths).
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { StringEditor, type EditorRow } from "./StringEditor";
import type { TranslationResult } from "../tauri/commands";

function row(overrides: Partial<EditorRow> = {}): EditorRow {
  return {
    key: "greeting",
    source: "Hello",
    target: "Hallo",
    file: "i18n",
    targetPresent: true,
    status: "translated",
    ...overrides,
  };
}

function renderEditor(
  overrides: Partial<EditorRow> = {},
  onTranslate?: (source: string) => Promise<TranslationResult>,
  position: { index: number; total: number } = { index: 0, total: 2 },
) {
  const onSave = vi.fn();
  const onClose = vi.fn();
  const onNavigate = vi.fn();
  render(
    <StringEditor
      row={row(overrides)}
      index={position.index}
      total={position.total}
      modName="Test Mod"
      onTranslate={onTranslate}
      onSave={onSave}
      onClose={onClose}
      onNavigate={onNavigate}
    />,
  );
  return { onSave, onClose, onNavigate };
}

describe("StringEditor", () => {
  it("navigating without any change does not save", () => {
    const { onSave, onNavigate } = renderEditor();

    fireEvent.click(screen.getByRole("button", { name: /Next/ }));

    expect(onSave).not.toHaveBeenCalled();
    expect(onNavigate).toHaveBeenCalledWith(1);
  });

  it("F2 keeps the original: copies the source, saved as translated on navigation", () => {
    const { onSave, onNavigate } = renderEditor();

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "F2" });
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));

    expect(onSave).toHaveBeenCalledWith("Hello", "translated");
    expect(onNavigate).toHaveBeenCalledWith(1);
  });

  it("Esc cancels without saving", () => {
    const { onSave, onClose } = renderEditor();

    fireEvent.change(screen.getByLabelText("Translation"), {
      target: { value: "Geändert" },
    });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("Save confirms an unreviewed AI suggestion to translated and closes", () => {
    const { onSave, onClose } = renderEditor({ status: "review-needed" });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith("Hallo", "translated");
    expect(onClose).toHaveBeenCalled();
  });

  it("navigating away from an untouched AI suggestion keeps it unsaved (stays review-needed)", () => {
    const { onSave, onNavigate } = renderEditor({ status: "review-needed" });

    fireEvent.click(screen.getByRole("button", { name: /Next/ }));

    expect(onSave).not.toHaveBeenCalled();
    expect(onNavigate).toHaveBeenCalledWith(1);
  });

  it("AI translate then navigate saves the suggestion as review-needed", async () => {
    const onTranslate = vi.fn().mockResolvedValue({
      text: "Hallo Welt",
      missingTokens: [],
      glossaryMisses: [],
    });
    const { onSave } = renderEditor(
      { target: "", status: "untranslated" },
      onTranslate,
    );

    fireEvent.click(screen.getByRole("button", { name: /Translate/ }));
    await waitFor(() =>
      expect(
        (screen.getByLabelText("Translation") as HTMLTextAreaElement).value,
      ).toBe("Hallo Welt"),
    );

    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(onSave).toHaveBeenCalledWith("Hallo Welt", "review-needed");
  });

  it("Reset then navigate saves the cleared string as untranslated", () => {
    const { onSave } = renderEditor();

    fireEvent.click(screen.getByRole("button", { name: /Reset/ }));
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));

    expect(onSave).toHaveBeenCalledWith("", "untranslated");
  });

  it("Save & next confirms the string and jumps to the next one", () => {
    const { onSave, onNavigate, onClose } = renderEditor({
      status: "review-needed",
    });

    fireEvent.click(screen.getByRole("button", { name: /Save & next/ }));

    expect(onSave).toHaveBeenCalledWith("Hallo", "translated");
    expect(onNavigate).toHaveBeenCalledWith(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Save & next on the last string closes instead of navigating", () => {
    const { onSave, onNavigate, onClose } = renderEditor({}, undefined, {
      index: 1,
      total: 2,
    });

    fireEvent.click(screen.getByRole("button", { name: /Save & next/ }));

    expect(onSave).toHaveBeenCalledWith("Hallo", "translated");
    expect(onNavigate).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
