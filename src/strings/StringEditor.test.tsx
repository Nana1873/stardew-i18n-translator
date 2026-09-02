/**
 * StringEditor in isolation — the editor only talks through its callbacks, so
 * no Tauri mock is needed. Focus: the save/navigate/dirty state machine that
 * the table tests don't cover (status-only changes, discard paths).
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import {
  StringEditor,
  type EditorRow,
  type EditorTranslationResult,
} from "./StringEditor";
import type { GlossaryEntry } from "../tauri/commands";
import { resolveShortcuts } from "../shortcuts";

function row(overrides: Partial<EditorRow> = {}): EditorRow {
  return {
    modUniqueId: "test.mod",
    key: "greeting",
    source: "Hello",
    target: "Hallo",
    file: "i18n",
    targetPresent: true,
    status: "translated",
    tokenMismatchAccepted: false,
    ...overrides,
  };
}

function renderEditor(
  overrides: Partial<EditorRow> = {},
  onTranslate?: (
    source: string,
    section?: string | null,
  ) => Promise<EditorTranslationResult>,
  position: { index: number; total: number } = { index: 0, total: 2 },
  reviewProgress?: { current: number; total: number },
  glossary?: GlossaryEntry[] | null,
  onSave: (
    value: string,
    status: EditorRow["status"],
    tokenMismatchAccepted: boolean,
  ) => Promise<void> | void = vi.fn(),
) {
  const onClose = vi.fn();
  const onNavigate = vi.fn();
  const rendered = render(
    <StringEditor
      row={row(overrides)}
      index={position.index}
      total={position.total}
      modName="Test Mod"
      aiEngineLabel="Codex CLI"
      aiModel="codex-test-model"
      aiReasoning="High"
      reviewProgress={reviewProgress}
      glossary={glossary}
      onTranslate={onTranslate}
      onSave={onSave}
      onClose={onClose}
      onNavigate={onNavigate}
    />,
  );
  return {
    ...rendered,
    onSave: onSave as ReturnType<typeof vi.fn>,
    onClose,
    onNavigate,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function entry(
  source: string,
  target: string,
  kind: GlossaryEntry["kind"],
): GlossaryEntry {
  return { source, target, kind, asset: "test", key: source };
}

describe("StringEditor", () => {
  it("navigating without any change does not save", () => {
    const { onSave, onNavigate } = renderEditor();

    fireEvent.click(screen.getByRole("button", { name: /Next/ }));

    expect(onSave).not.toHaveBeenCalled();
    expect(onNavigate).toHaveBeenCalledWith(1);
  });

  it("F2 keeps the original: copies the source, saved as translated on navigation", async () => {
    const { onSave, onNavigate } = renderEditor();

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "F2" });
    expect(
      screen.queryByText("Translation is identical to the original"),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));

    expect(onSave).toHaveBeenCalledWith("Hello", "translated", false);
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith(1));
  });

  it("Esc asks before discarding a dirty edit", () => {
    const { onSave, onClose } = renderEditor();

    fireEvent.change(screen.getByRole("textbox", { name: "Translation" }), {
      target: { value: "Geändert" },
    });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("Discard changes?")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Close without saving" }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("focuses nested confirmation and blocks editor shortcuts behind it", async () => {
    const onTranslate = vi.fn().mockResolvedValue({
      text: "AI result",
      missingTokens: [],
      glossaryMisses: [],
    });
    const { onSave, onNavigate } = renderEditor({}, onTranslate);
    const field = screen.getByRole("textbox", { name: "Translation" });
    fireEvent.change(field, { target: { value: "Unsaved edit" } });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    const continueButton = screen.getByRole("button", {
      name: "Continue editing",
    });
    const editor = continueButton.closest(".translator-editor")!;
    const nestedDialog = continueButton.closest(".translator-flow-dialog")!;
    for (const selector of [
      ".translator-editor-head",
      ".translator-editor-body",
      ".translator-editor-actions",
    ]) {
      const underlying = editor.querySelector(selector)!;
      expect(underlying).toHaveAttribute("aria-hidden", "true");
      expect(underlying).toHaveAttribute("inert");
    }
    expect(nestedDialog).not.toHaveAttribute("aria-hidden");
    expect(nestedDialog).not.toHaveAttribute("inert");
    expect(
      screen.queryByRole("textbox", { name: "Translation" }),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(continueButton).toHaveFocus());
    fireEvent.keyDown(window, { key: "F4" });
    fireEvent.keyDown(window, { key: "ArrowRight", altKey: true });
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(window, { key: "F5", ctrlKey: true });

    expect(field).toHaveValue("Unsaved edit");
    expect(onSave).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
    expect(onTranslate).not.toHaveBeenCalled();

    fireEvent.click(continueButton);
    await waitFor(() => expect(field).toHaveFocus());
    expect(
      screen.getByRole("textbox", { name: "Translation" }),
    ).toBeInTheDocument();
  });

  it("Save approves a persisted review suggestion as translated and closes", async () => {
    const { onSave, onClose } = renderEditor({ status: "review-needed" });

    fireEvent.click(screen.getByRole("button", { name: /Approve suggestion/ }));

    expect(onSave).toHaveBeenCalledWith("Hallo", "translated", false);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("navigating away from an untouched AI suggestion keeps it unsaved (stays review-needed)", () => {
    const { onSave, onNavigate } = renderEditor({ status: "review-needed" });

    fireEvent.click(screen.getByRole("button", { name: /Next/ }));

    expect(onSave).not.toHaveBeenCalled();
    expect(onNavigate).toHaveBeenCalledWith(1);
  });

  it("shows the correct action states for persisted Review rows", () => {
    renderEditor({ status: "review-needed" });

    expect(
      screen.getByRole("button", { name: /Approve suggestion/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Approve & next/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Discard this review suggestion; save to return the string to Open",
      }),
    ).toHaveTextContent("Discard suggestion");

    fireEvent.change(screen.getByRole("textbox", { name: "Translation" }), {
      target: { value: "Hallo!" },
    });
    expect(
      screen.getByRole("button", { name: /Save edited suggestion/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Save edit & next/ }),
    ).toBeInTheDocument();
  });

  it("shows the correct action states for Changed rows and queue ends", () => {
    renderEditor({ status: "outdated" }, undefined, { index: 1, total: 2 });

    expect(
      screen.getByRole("button", { name: /Keep translation/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Keep & close/ }),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "Translation" }), {
      target: { value: "Aktualisiert" },
    });
    expect(
      screen.getByRole("button", { name: "Save update" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Save update & close/ }),
    ).toBeInTheDocument();
  });

  it("navigation accepts an edited Changed translation as Done", async () => {
    const { onSave, onNavigate } = renderEditor({ status: "outdated" });

    fireEvent.change(screen.getByRole("textbox", { name: "Translation" }), {
      target: { value: "Aktualisiert" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Next string/ }));

    expect(onSave).toHaveBeenCalledWith("Aktualisiert", "translated", false);
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith(1));
  });

  it("shows a persisted live result in Review with the returned engine metadata", async () => {
    const onTranslate = vi.fn().mockResolvedValue({
      text: "Hallo Welt",
      missingTokens: [],
      glossaryMisses: [],
      engine: "Codex CLI",
      model: "Codex default",
      reasoning: "Medium",
      persisted: true,
    });
    const onSave = vi.fn();
    const first = renderEditor(
      { target: "", targetPresent: false, status: "untranslated" },
      onTranslate,
      undefined,
      undefined,
      undefined,
      onSave,
    );

    expect(screen.queryByText("Generated by")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Translate with AI/ }));

    expect(
      await screen.findByRole("textbox", { name: "Translation" }),
    ).toHaveValue("Hallo Welt");
    expect(onSave).not.toHaveBeenCalled();

    first.rerender(
      <StringEditor
        row={row({
          target: "Hallo Welt",
          targetPresent: true,
          status: "review-needed",
        })}
        index={0}
        total={2}
        modName="Test Mod"
        aiEngineLabel="Codex CLI"
        aiModel="codex-test-model"
        aiReasoning="High"
        onTranslate={onTranslate}
        onSave={onSave}
        onClose={first.onClose}
        onNavigate={first.onNavigate}
      />,
    );

    expect(screen.getByText("Review")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Approve suggestion/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("Generated by")).toBeInTheDocument();
    expect(
      screen.getByText("Codex CLI", { selector: "strong" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Saved to Review/)).toBeInTheDocument();
    expect(screen.getByText(/Codex default/)).toBeInTheDocument();
    expect(screen.getByText(/Medium/)).toBeInTheDocument();
  });

  it("blocks close, navigation, saving, and editing while live translation is pending", async () => {
    const pending = deferred<EditorTranslationResult>();
    const onTranslate = vi.fn(() => pending.promise);
    const { onSave, onClose, onNavigate } = renderEditor(
      { target: "", targetPresent: false, status: "untranslated" },
      onTranslate,
    );

    fireEvent.click(screen.getByRole("button", { name: /Translate with AI/ }));

    const field = screen.getByRole("textbox", { name: "Translation" });
    expect(field).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "Close editor" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next string" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Save$/ })).toBeDisabled();
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.keyDown(window, { key: "ArrowRight", altKey: true });
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
    fireEvent.change(field, { target: { value: "Manual overwrite" } });
    expect(onClose).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
    expect(field).toHaveValue("");

    pending.resolve({
      text: "Persisted result",
      missingTokens: [],
      glossaryMisses: [],
      engine: "Codex CLI",
      model: "codex-test-model",
      reasoning: "High",
      persisted: true,
    });

    await waitFor(() => expect(field).toHaveValue("Persisted result"));
    expect(field).not.toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "Close editor" })).toBeEnabled();
  });

  it("hides suggestion provenance when no real metadata is available", () => {
    renderEditor({ status: "review-needed" });

    expect(screen.queryByText("Generated by")).not.toBeInTheDocument();
    expect(screen.queryByText(/Model unavailable/)).not.toBeInTheDocument();
  });

  it("does not invent provenance for a translation result without metadata", async () => {
    const onTranslate = vi.fn().mockResolvedValue({
      text: "Hallo Welt",
      missingTokens: [],
      glossaryMisses: [],
    });
    render(
      <StringEditor
        row={row({
          target: "",
          targetPresent: false,
          status: "untranslated",
        })}
        index={0}
        total={1}
        modName="Test Mod"
        onTranslate={onTranslate}
        onSave={vi.fn()}
        onClose={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Translate with AI/ }));

    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Translation" })).toHaveValue(
        "Hallo Welt",
      ),
    );
    expect(screen.queryByText("Generated by")).not.toBeInTheDocument();
    expect(screen.queryByText(/unavailable/i)).not.toBeInTheDocument();
  });

  it("hides cached provenance after the suggestion is no longer in Review", () => {
    render(
      <StringEditor
        row={row({ target: "Hallo", status: "translated" })}
        index={0}
        total={1}
        modName="Test Mod"
        suggestionProvenance={{
          identity: JSON.stringify(["test.mod", "i18n", "greeting"]),
          engine: "Codex CLI",
          model: "gpt-5.6-sol",
          reasoning: "Medium",
          persisted: true,
          value: "Hallo",
        }}
        onSave={vi.fn()}
        onClose={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );

    expect(screen.queryByText("Generated by")).not.toBeInTheDocument();
    expect(screen.queryByText(/just now/i)).not.toBeInTheDocument();
  });

  it("resets editor-local state between mods with the same file and key", () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    const onNavigate = vi.fn();
    const first = row({ modUniqueId: "first.mod" });
    const second = row({ modUniqueId: "second.mod" });
    const { rerender } = render(
      <StringEditor
        row={first}
        index={0}
        total={2}
        modName="First Mod"
        onSave={onSave}
        onClose={onClose}
        onNavigate={onNavigate}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Translation" }), {
      target: { value: "Unsaved first-mod edit" },
    });
    expect(screen.getByRole("textbox", { name: "Translation" })).toHaveValue(
      "Unsaved first-mod edit",
    );

    rerender(
      <StringEditor
        row={second}
        index={1}
        total={2}
        modName="Second Mod"
        onSave={onSave}
        onClose={onClose}
        onNavigate={onNavigate}
      />,
    );

    expect(screen.getByRole("textbox", { name: "Translation" })).toHaveValue(
      "Hallo",
    );
  });

  it("passes the row section to the configured AI translation callback", async () => {
    const onTranslate = vi.fn().mockResolvedValue({
      text: "Guten Morgen",
      missingTokens: [],
      glossaryMisses: [],
    });
    renderEditor(
      {
        source: "Good morning",
        target: "",
        status: "untranslated",
        section: "NPC dialogue",
      },
      onTranslate,
    );

    fireEvent.click(screen.getByRole("button", { name: /Translate/ }));
    await waitFor(() =>
      expect(onTranslate).toHaveBeenCalledWith("Good morning", "NPC dialogue"),
    );
  });

  it("Clear then navigate saves the cleared string as untranslated", () => {
    const { onSave } = renderEditor();

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));

    expect(onSave).toHaveBeenCalledWith("", "untranslated", false);
  });

  it("Save & next confirms the string and jumps to the next one", async () => {
    const { onSave, onNavigate, onClose } = renderEditor({
      status: "review-needed",
    });

    fireEvent.click(screen.getByRole("button", { name: /Approve & next/ }));

    expect(onSave).toHaveBeenCalledWith("Hallo", "translated", false);
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith(1));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("requires an explicit confirmation before accepting token errors", async () => {
    const { onSave, onNavigate } = renderEditor({
      source: "What happened?$8",
      target: "Was ist passiert?$7",
    });

    fireEvent.click(screen.getByRole("button", { name: /Save & next/ }));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText("Protected token mismatch")).toBeInTheDocument();
    expect(screen.getByText(/broken in game/)).toBeInTheDocument();
    const saveAnyway = screen.getByRole("button", { name: "Save anyway" });
    const editor = saveAnyway.closest(".translator-editor")!;
    const nestedDialog = saveAnyway.closest(".translator-flow-dialog")!;
    for (const selector of [
      ".translator-editor-head",
      ".translator-editor-body",
      ".translator-editor-actions",
    ]) {
      const underlying = editor.querySelector(selector)!;
      expect(underlying).toHaveAttribute("aria-hidden", "true");
      expect(underlying).toHaveAttribute("inert");
    }
    expect(nestedDialog).not.toHaveAttribute("aria-hidden");
    expect(nestedDialog).not.toHaveAttribute("inert");
    expect(
      screen.queryByRole("textbox", { name: "Translation" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Return to editor"));
    expect(onSave).not.toHaveBeenCalled();
    expect(
      screen.getByRole("textbox", { name: "Translation" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Save & next/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save anyway" }));

    expect(onSave).toHaveBeenCalledWith(
      "Was ist passiert?$7",
      "translated",
      true,
    );
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith(1));
  });

  it("reuses an accepted mismatch until the translation is edited", async () => {
    const { onSave } = renderEditor({
      source: "What happened?$8",
      target: "Was ist passiert?$7",
      tokenMismatchAccepted: true,
    });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith(
      "Was ist passiert?$7",
      "translated",
      true,
    );
    expect(
      screen.queryByText("Protected token mismatch"),
    ).not.toBeInTheDocument();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled(),
    );
    const field = screen.getByRole("textbox", { name: "Translation" });
    fireEvent.change(field, { target: { value: "Was geschah?$7" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("Protected token mismatch")).toBeInTheDocument();
  });

  it("uses the generic token-mismatch confirmation for an added-only token", () => {
    const { onSave } = renderEditor({
      source: "Hello",
      target: "Hallo {{name}}",
    });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText("Protected token mismatch")).toBeInTheDocument();
    expect(screen.getAllByText(/expected 0, found 1/)).not.toHaveLength(0);
  });

  it("shows an accepted token mismatch as a non-blocking warning", () => {
    renderEditor({
      source: "Saved {{saveName}}",
      target: "Gespeichert",
      tokenMismatchAccepted: true,
    });

    const warning = screen.getByText(
      /mismatch explicitly accepted for this exact translation/i,
    );
    expect(warning.closest(".translator-validation")).toHaveClass("is-warning");
    expect(warning.closest(".translator-validation")).not.toHaveClass(
      "is-error",
    );
    expect(screen.getByRole("button", { name: /saveName/i })).toHaveClass(
      "is-accepted",
    );
  });

  it("shows missing-token help and red chips for extra target tokens", () => {
    renderEditor({
      source: "Hello {{name}}",
      target: "Hallo {{extra}} {{extra}}",
    });

    expect(
      screen.getByRole("button", {
        name: "Insert missing token {{name}}",
      }),
    ).toHaveClass("is-missing");
    expect(
      screen.getByText("Click a missing token to insert it"),
    ).toBeVisible();
    const extraToken = screen.getByLabelText("Extra token {{extra}}");
    expect(extraToken).toHaveClass("is-missing");
    expect(extraToken).toHaveTextContent("×2");
  });

  it("shows a missing gender-switch shape as a passive structure warning", () => {
    renderEditor({
      source: "${Hello^Goodbye}$",
      target: "Hallo und auf Wiedersehen",
    });

    const shape = screen.getByLabelText("Missing token ${^}$");
    expect(shape.tagName).toBe("SPAN");
    expect(shape).toHaveTextContent("gender switch (2 branches, ^ separator)");
    expect(
      screen.queryByRole("button", {
        name: "Insert missing token ${^}$",
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Click a missing token to insert it"),
    ).not.toBeInTheDocument();
  });

  it("does not mark a target-language-only gender switch as extra", () => {
    const { onSave } = renderEditor({
      source: "Dear @.",
      target: "${Lieber^Liebe}$ @.",
    });

    expect(
      screen.queryByLabelText("Extra token ${^}$"),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(
      screen.queryByText("Protected token mismatch"),
    ).not.toBeInTheDocument();
    expect(onSave).toHaveBeenCalledWith(
      "${Lieber^Liebe}$ @.",
      "translated",
      false,
    );
  });

  it("still marks a changed source switch shape as extra", () => {
    renderEditor({
      source: "${a^b}$",
      target: "${x^y^z}$ ${neu^neu}$",
    });

    expect(screen.getByLabelText("Extra token ${^^}$")).toBeInTheDocument();
  });

  it("renders already satisfied protected tokens as passive chips", () => {
    renderEditor({
      source: "Hello {{name}}",
      target: "Hallo {{name}}",
    });
    const field = screen.getByRole("textbox", { name: "Translation" });
    const token = screen.getByLabelText("Token {{name}} is present in full");

    expect(token.tagName).toBe("SPAN");
    expect(
      screen.queryByRole("button", {
        name: "Token {{name}} is present in full",
      }),
    ).not.toBeInTheDocument();
    fireEvent.click(token);
    expect(field).toHaveValue("Hallo {{name}}");
  });

  it("does not present bracketed UI labels as protected tokens", () => {
    renderEditor({
      source: "[Right]",
      target: "[Rechts]",
    });

    expect(screen.getByText("None")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /Insert missing token/ }),
    ).not.toBeInTheDocument();
  });

  it("keeps an untouched changed source visibly Changed", () => {
    renderEditor({ status: "outdated" });

    expect(screen.getByText("Changed")).toBeInTheDocument();
  });

  it("keeps the persisted status badge stable until a save succeeds", () => {
    const first = renderEditor({ target: "", status: "untranslated" });
    fireEvent.change(screen.getByRole("textbox", { name: "Translation" }), {
      target: { value: "Draft" },
    });
    expect(screen.getByText("Open")).toBeInTheDocument();
    expect(screen.queryByText("Done")).not.toBeInTheDocument();
    first.unmount();

    renderEditor({ status: "review-needed" });
    fireEvent.change(screen.getByRole("textbox", { name: "Translation" }), {
      target: { value: "Edited review" },
    });
    expect(screen.getByText("Review")).toBeInTheDocument();
    expect(screen.queryByText("Done")).not.toBeInTheDocument();
  });

  it("keeps token and glossary support rows reachable in their empty states", () => {
    renderEditor();

    expect(screen.getByText("Protected tokens")).toBeVisible();
    expect(screen.getByText("None")).toBeVisible();
    expect(screen.getByText("Glossary hints")).toBeVisible();
    expect(screen.getByText("No matching hints")).toBeVisible();
  });

  it("keeps unavailable AI actionable through Translation engines", () => {
    const onOpenEngineSettings = vi.fn();
    render(
      <StringEditor
        row={row()}
        index={0}
        total={1}
        modName="Test Mod"
        onSave={vi.fn()}
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        onOpenEngineSettings={onOpenEngineSettings}
      />,
    );
    const translateButton = screen.getByRole("button", {
      name: /Translate with AI/,
    });
    expect(translateButton).toBeEnabled();

    fireEvent.click(translateButton);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Configure a translation engine in Settings",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Open Translation engines" }),
    );
    expect(onOpenEngineSettings).toHaveBeenCalledOnce();
  });

  it("renders successful AI validation notes without an engine-error recovery", async () => {
    const onTranslate = vi.fn().mockResolvedValue({
      text: "Hallo",
      missingTokens: ["{{name}}"],
      glossaryMisses: ["Pelican Town"],
    });
    render(
      <StringEditor
        row={row({
          source: "Hello {{name}} in Pelican Town",
          target: "",
          status: "untranslated",
        })}
        index={0}
        total={1}
        modName="Test Mod"
        onTranslate={onTranslate}
        onSave={vi.fn()}
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        onOpenEngineSettings={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Translate with AI/ }));

    const note = await screen.findByText(
      /AI damaged protected structure\/token/,
    );
    expect(note).toHaveClass("editor__ai-msg");
    expect(note.closest(".translator-editor-ai-error")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Open Translation engines" }),
    ).not.toBeInTheDocument();
  });

  it("uses the language-specific translation field label", () => {
    render(
      <StringEditor
        row={row()}
        index={0}
        total={1}
        modName="Test Mod"
        targetLanguageLabel="German (de)"
        onSave={vi.fn()}
        onClose={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );

    expect(screen.getByText("German translation")).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "German translation" }),
    ).toBeInTheDocument();
  });

  it("Save & close on the last string closes instead of navigating", async () => {
    const { onSave, onNavigate, onClose } = renderEditor({}, undefined, {
      index: 1,
      total: 2,
    });

    fireEvent.click(screen.getByRole("button", { name: /Save & close/ }));

    expect(onSave).toHaveBeenCalledWith("Hallo", "translated", false);
    expect(onNavigate).not.toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("uses a configured shortcut instead of the default", async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    render(
      <StringEditor
        row={row()}
        index={0}
        total={1}
        modName="Test Mod"
        onSave={onSave}
        onClose={onClose}
        onNavigate={() => {}}
        shortcuts={resolveShortcuts({ "editor.save": "Ctrl+S" })}
      />,
    );

    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    expect(onSave).toHaveBeenCalledWith("Hallo", "translated", false);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("waits for a delayed save before navigating", async () => {
    const pending = deferred<void>();
    const onSave = vi.fn(() => pending.promise);
    const { onNavigate } = renderEditor(
      { status: "review-needed" },
      undefined,
      { index: 0, total: 2 },
      undefined,
      undefined,
      onSave,
    );

    fireEvent.click(screen.getByRole("button", { name: /Approve & next/ }));

    expect(onSave).toHaveBeenCalledWith("Hallo", "translated", false);
    expect(onNavigate).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /Approve & next/ }),
    ).toBeDisabled();

    pending.resolve();
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith(1));
  });

  it("keeps the current text and focus when saving fails", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("disk full"));
    const { onNavigate, onClose } = renderEditor(
      { status: "review-needed" },
      undefined,
      { index: 0, total: 2 },
      undefined,
      undefined,
      onSave,
    );
    const field = screen.getByRole("textbox", { name: "Translation" });
    field.focus();

    fireEvent.click(screen.getByRole("button", { name: /Approve & next/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
    expect(onNavigate).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(field).toHaveValue("Hallo");
    expect(field).toHaveFocus();
  });

  it("keeps a valid pending AI result across an unrelated parent rerender", async () => {
    const pending = deferred<EditorTranslationResult>();
    const firstTranslate = vi.fn(() => pending.promise);
    const replacementTranslate = vi.fn().mockResolvedValue({
      text: "Replacement",
      missingTokens: [],
      glossaryMisses: [],
    });
    const editorRow = row({ target: "", status: "untranslated" });
    const onSave = vi.fn();
    const onClose = vi.fn();
    const onNavigate = vi.fn();
    const { rerender } = render(
      <StringEditor
        row={editorRow}
        index={0}
        total={1}
        modName="Test Mod"
        onTranslate={firstTranslate}
        onSave={onSave}
        onClose={onClose}
        onNavigate={onNavigate}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Translate with AI/ }));

    rerender(
      <StringEditor
        row={editorRow}
        index={0}
        total={1}
        modName="Test Mod"
        onTranslate={replacementTranslate}
        onSave={onSave}
        onClose={onClose}
        onNavigate={onNavigate}
      />,
    );
    pending.resolve({
      text: "Valid pending result",
      missingTokens: [],
      glossaryMisses: [],
      engine: "Codex CLI",
      model: "codex-test-model",
      reasoning: "High",
      persisted: true,
    });

    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Translation" })).toHaveValue(
        "Valid pending result",
      ),
    );
    expect(replacementTranslate).not.toHaveBeenCalled();
  });

  it("shows typed glossary hints as passive reference chips", () => {
    renderEditor(
      { source: "Visit Pelican Town in Spring", target: "" },
      undefined,
      { index: 0, total: 2 },
      undefined,
      [
        entry("Pelican Town", "Pelikanstadt", "location"),
        entry("Spring", "Frühling", "season"),
        entry("Parsnip", "Pastinake", "item"), // not in the source → no hint
      ],
    );

    // Category chips render beside each matched hint.
    expect(screen.getByText("Place")).toBeInTheDocument();
    expect(screen.getByText("Season")).toBeInTheDocument();
    // Unmatched terms produce no hint.
    expect(screen.queryByText("Item")).not.toBeInTheDocument();

    const textarea = screen.getByRole("textbox", {
      name: "Translation",
    }) as HTMLTextAreaElement;
    const placeHint = screen.getByTitle("Place");
    expect(placeHint.tagName).toBe("SPAN");
    expect(placeHint).toHaveTextContent("Pelican Town → Pelikanstadt");
    fireEvent.click(placeHint);
    expect(textarea.value).toBe("");
  });

  it("prefers the longer glossary term over an overlapping shorter one", () => {
    renderEditor(
      { source: "Refined some Iridium Ore today", target: "" },
      undefined,
      { index: 0, total: 2 },
      undefined,
      [entry("Ore", "Erz", "item"), entry("Iridium Ore", "Iridiumerz", "item")],
    );

    const hints = Array.from(
      document.querySelectorAll<HTMLElement>(".translator-glossary-term"),
    ).map((hint) => hint.textContent ?? "");
    expect(hints.some((hint) => hint.includes("Iridium Ore"))).toBe(true);
    // The bare "Ore" must not also appear — the longer term claimed the span.
    expect(hints.some((hint) => hint.trim().startsWith("ItemOre →"))).toBe(
      false,
    );
  });

  it("checks later occurrences when the first glossary match is unavailable", () => {
    renderEditor(
      { source: "Iridium Ore and Ore from Oreville", target: "" },
      undefined,
      { index: 0, total: 2 },
      undefined,
      [entry("Ore", "Erz", "item"), entry("Iridium Ore", "Iridiumerz", "item")],
    );

    const hints = Array.from(
      document.querySelectorAll<HTMLElement>(".translator-glossary-term"),
    ).map((hint) => hint.textContent ?? "");
    expect(hints.some((hint) => hint.includes("Iridium Ore"))).toBe(true);
    expect(hints.some((hint) => hint.includes("Ore → Erz"))).toBe(true);
  });

  it("shows review-session progress only in the compact header position", () => {
    renderEditor(
      {},
      undefined,
      { index: 2, total: 5 },
      {
        current: 3,
        total: 5,
      },
    );

    expect(screen.getByText("3 / 5")).toBeInTheDocument();
    expect(screen.queryByText("Reviewing 3 of 5")).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("uses the exact changed-source heading and exposes status help", async () => {
    renderEditor({ status: "outdated" });

    expect(screen.getByText("English source update")).toBeInTheDocument();
    const status = screen.getByText("Changed");
    expect(status).toHaveAttribute(
      "aria-description",
      expect.stringContaining("English source changed"),
    );

    fireEvent.pointerEnter(status);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "The English source changed after this target translation was saved.",
    );
  });
});
