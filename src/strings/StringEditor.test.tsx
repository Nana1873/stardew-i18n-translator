/**
 * StringEditor in isolation — the editor only talks through its callbacks, so
 * no Tauri mock is needed. Focus: the save/navigate/dirty state machine that
 * the table tests don't cover (status-only changes, discard paths).
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { StringEditor, type EditorRow } from "./StringEditor";
import type { GlossaryEntry, TranslationResult } from "../tauri/commands";
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
  ) => Promise<TranslationResult>,
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
      localAiModel="local-instruct-8b"
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

  it("matches the demo action states for persisted Review rows", () => {
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

  it("matches the demo action states for Changed rows and queue ends", () => {
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

  it("AI translate then manual edit and navigation still saves the draft as review-needed", async () => {
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
        (
          screen.getByRole("textbox", {
            name: "Translation",
          }) as HTMLTextAreaElement
        ).value,
      ).toBe("Hallo Welt"),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Translation" }), {
      target: { value: "Hallo Welt!" },
    });

    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(onSave).toHaveBeenCalledWith("Hallo Welt!", "review-needed", false);
  });

  it("saves an AI draft to Review on navigation even when its text matches the existing target", async () => {
    const onTranslate = vi.fn().mockResolvedValue({
      text: "Hallo",
      missingTokens: [],
      glossaryMisses: [],
    });
    const { onSave, onNavigate } = renderEditor({}, onTranslate);

    fireEvent.click(screen.getByRole("button", { name: /Translate with AI/ }));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Translation" })).toHaveValue(
        "Hallo",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Next string" }));

    expect(onSave).toHaveBeenCalledWith("Hallo", "review-needed", false);
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith(1));
  });

  it("persists a fresh AI draft to Review before a later manual save can mark it Done", async () => {
    const onTranslate = vi.fn().mockResolvedValue({
      text: "Hallo Welt",
      missingTokens: [],
      glossaryMisses: [],
    });
    const onSave = vi.fn();
    const first = renderEditor(
      { target: "", status: "untranslated" },
      onTranslate,
      undefined,
      undefined,
      undefined,
      onSave,
    );

    fireEvent.click(screen.getByRole("button", { name: /Translate with AI/ }));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Translation" })).toHaveValue(
        "Hallo Welt",
      ),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Translation" }), {
      target: { value: "Hallo Welt!" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenLastCalledWith(
      "Hallo Welt!",
      "review-needed",
      false,
    );
    await waitFor(() => expect(first.onClose).toHaveBeenCalled());
    first.unmount();

    const second = renderEditor(
      {
        target: "Hallo Welt!",
        status: "review-needed",
      },
      undefined,
      undefined,
      undefined,
      undefined,
      onSave,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Translation" }), {
      target: { value: "Hallo, Welt!" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /Save edited suggestion/ }),
    );

    expect(onSave).toHaveBeenLastCalledWith(
      "Hallo, Welt!",
      "translated",
      false,
    );
    await waitFor(() => expect(second.onClose).toHaveBeenCalled());
  });

  it("keeps a token-mismatched fresh AI draft in Review after Save anyway", async () => {
    const onTranslate = vi.fn().mockResolvedValue({
      text: "Hallo",
      missingTokens: ["{{name}}"],
      glossaryMisses: [],
    });
    const { onSave, onNavigate } = renderEditor(
      {
        source: "Hello {{name}}",
        target: "",
        status: "untranslated",
      },
      onTranslate,
    );

    fireEvent.click(screen.getByRole("button", { name: /Translate with AI/ }));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Translation" })).toHaveValue(
        "Hallo",
      ),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Translation" }), {
      target: { value: "Guten Tag" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Next string" }));
    fireEvent.click(screen.getByRole("button", { name: "Save anyway" }));

    expect(onSave).toHaveBeenCalledWith("Guten Tag", "review-needed", true);
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith(1));
  });

  it("shows Local AI provenance as soon as a draft is generated", async () => {
    const onTranslate = vi.fn().mockResolvedValue({
      text: "Hallo Welt",
      missingTokens: [],
      glossaryMisses: [],
    });
    renderEditor({ target: "", status: "untranslated" }, onTranslate);

    expect(screen.queryByText("Suggestion source")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Translate with AI/ }));

    expect(await screen.findByText("Suggestion source")).toBeInTheDocument();
    expect(
      screen.getByText("Local AI", { selector: "strong" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Draft in editor/)).toBeInTheDocument();
    expect(screen.getByText(/local-instruct-8b/)).toBeInTheDocument();
    expect(screen.getByText(/Default/)).toBeInTheDocument();
    expect(screen.getByText(/just now/)).toBeInTheDocument();
  });

  it("shows unavailable persisted provenance without inventing metadata", () => {
    renderEditor({ status: "review-needed" });

    expect(
      screen.getByText("Unavailable", { selector: "strong" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Awaiting review/)).toBeInTheDocument();
    expect(screen.getByText(/Model unavailable/)).toBeInTheDocument();
    expect(screen.getByText(/Reasoning unavailable/)).toBeInTheDocument();
    expect(screen.getByText(/Time unavailable/)).toBeInTheDocument();
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

  it("passes the row section to local AI translation", async () => {
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
    expect(screen.getByText("Protected token missing")).toBeInTheDocument();
    expect(screen.getByText(/broken in game/)).toBeInTheDocument();

    fireEvent.click(screen.getByText("Return to editor"));
    expect(onSave).not.toHaveBeenCalled();

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
      screen.queryByText("Protected token missing"),
    ).not.toBeInTheDocument();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled(),
    );
    const field = screen.getByRole("textbox", { name: "Translation" });
    fireEvent.change(field, { target: { value: "Was geschah?$7" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("Protected token missing")).toBeInTheDocument();
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
    expect(warning.closest(".stv3-validation")).toHaveClass("is-warning");
    expect(warning.closest(".stv3-validation")).not.toHaveClass("is-error");
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

  it("keeps empty token and glossary support rows out of the layout", () => {
    renderEditor();

    expect(screen.queryByText("Protected tokens")).not.toBeInTheDocument();
    expect(screen.queryByText("Glossary hints")).not.toBeInTheDocument();
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
      "Configure a local AI in Settings",
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

    const note = await screen.findByText(/AI dropped token/);
    expect(note).toHaveClass("editor__ai-msg");
    expect(note.closest(".stv3-editor-ai-error")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Open Translation engines" }),
    ).not.toBeInTheDocument();
  });

  it("uses the accepted language-specific translation field label", () => {
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

  it("ignores an AI response after manual input", async () => {
    const pending = deferred<TranslationResult>();
    renderEditor(
      { target: "", status: "untranslated" },
      vi.fn(() => pending.promise),
    );

    fireEvent.click(screen.getByRole("button", { name: /Translate with AI/ }));
    const field = screen.getByRole("textbox", { name: "Translation" });
    fireEvent.change(field, { target: { value: "Mein Text" } });
    pending.resolve({
      text: "Verspaetete KI-Antwort",
      missingTokens: [],
      glossaryMisses: [],
    });

    await waitFor(() => expect(field).toHaveValue("Mein Text"));
  });

  it("keeps a valid pending AI result across an unrelated parent rerender", async () => {
    const pending = deferred<TranslationResult>();
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
      document.querySelectorAll<HTMLElement>(".stv3-glossary-term"),
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
      document.querySelectorAll<HTMLElement>(".stv3-glossary-term"),
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
