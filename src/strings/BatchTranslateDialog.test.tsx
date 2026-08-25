/**
 * BatchTranslateDialog in isolation — filtering, serial persistence,
 * cancellation, progress, completion reporting, and modal keyboard behavior.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { vi } from "vitest";
import {
  BatchTranslateDialog,
  type BatchFinishedResult,
  type BatchItem,
} from "./BatchTranslateDialog";
import type { TranslationResult } from "../tauri/commands";

const ITEMS: BatchItem[] = [
  {
    index: 0,
    key: "first.key",
    file: "i18n",
    source: "One",
    status: "untranslated",
    section: "Dialogue",
  },
  {
    index: 1,
    key: "second.key",
    file: "i18n",
    source: "Two",
    status: "untranslated",
  },
];

function ok(text: string): TranslationResult {
  return { text, missingTokens: [], glossaryMisses: [] };
}

function renderDialog(
  onTranslate: (
    source: string,
    section?: string | null,
  ) => Promise<TranslationResult>,
  options: {
    items?: BatchItem[];
    onResult?: (item: BatchItem, text: string) => Promise<void>;
    onFinished?: (result: BatchFinishedResult) => void;
    onClose?: () => void;
    translationReady?: boolean;
    translationUnavailableReason?: string;
  } = {},
) {
  const items = options.items ?? ITEMS;
  const onResult = options.onResult ?? vi.fn(async () => undefined);
  const onFinished = options.onFinished ?? vi.fn();
  const onClose = options.onClose ?? vi.fn();
  function Harness() {
    const [includeOpen, setIncludeOpen] = useState(true);
    const [includeChanged, setIncludeChanged] = useState(false);
    return (
      <BatchTranslateDialog
        items={items}
        modName="Test Mod"
        scopeSummary="2 selected · Test Mod"
        targetLanguageLabel="German (de)"
        includeOpen={includeOpen}
        includeChanged={includeChanged}
        onIncludeOpenChange={setIncludeOpen}
        onIncludeChangedChange={setIncludeChanged}
        translationReady={options.translationReady}
        translationUnavailableReason={options.translationUnavailableReason}
        onTranslate={onTranslate}
        onResult={onResult}
        onFinished={onFinished}
        onClose={onClose}
      />
    );
  }

  const view = render(<Harness />);
  return { ...view, onResult, onFinished, onClose };
}

function startRun() {
  fireEvent.click(screen.getByRole("button", { name: "Start AI translation" }));
}

describe("BatchTranslateDialog", () => {
  it("keeps preview available but blocks Start when the selected engine is not ready", () => {
    const onTranslate = vi.fn(async (source: string) => ok(source));
    renderDialog(onTranslate, {
      translationReady: false,
      translationUnavailableReason:
        "This engine is not ready; check its status in Settings first.",
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "This engine is not ready; check its status in Settings first.",
    );
    const start = screen.getByRole("button", {
      name: "Start AI translation",
    });
    expect(start).toBeDisabled();
    expect(start).toHaveAttribute(
      "title",
      "Configure or check this translation engine in Settings first.",
    );
    fireEvent.click(start);
    expect(onTranslate).not.toHaveBeenCalled();
  });

  it("starts with independent Open and Changed filters", async () => {
    const onTranslate = vi.fn(async (source: string) => ok(`X-${source}`));
    renderDialog(onTranslate, {
      items: [ITEMS[0], { ...ITEMS[1], status: "outdated" }],
    });

    const open = screen.getByRole("checkbox", { name: /Open/ });
    const changed = screen.getByRole("checkbox", { name: /Changed/ });
    expect(open).toBeChecked();
    expect(changed).not.toBeChecked();
    expect(screen.getByText("1 strings")).toBeVisible();
    expect(screen.getByText("2 selected · Test Mod")).toBeVisible();

    fireEvent.click(changed);
    expect(screen.getByText("2 strings")).toBeVisible();
    fireEvent.click(open);
    expect(screen.getByText("1 strings")).toBeVisible();
    startRun();

    await screen.findByText("Batch translation complete");
    expect(onTranslate).toHaveBeenCalledOnce();
    expect(onTranslate).toHaveBeenCalledWith("Two", undefined);
  });

  it("translates all included items serially and reports completion", async () => {
    const calls: string[] = [];
    const onTranslate = vi.fn(async (source: string) => {
      calls.push(source);
      return ok(`X-${source}`);
    });
    const onResult = vi.fn(async () => undefined);
    const onFinished = vi.fn();
    const { onClose } = renderDialog(onTranslate, { onResult, onFinished });
    startRun();

    await screen.findByText("Batch translation complete");
    expect(calls).toEqual(["One", "Two"]);
    expect(onTranslate).toHaveBeenNthCalledWith(1, "One", "Dialogue");
    expect(onTranslate).toHaveBeenNthCalledWith(2, "Two", undefined);
    expect(onResult).toHaveBeenNthCalledWith(1, ITEMS[0], "X-One");
    expect(onResult).toHaveBeenNthCalledWith(2, ITEMS[1], "X-Two");
    expect(onFinished).toHaveBeenCalledOnce();
    expect(onFinished).toHaveBeenCalledWith({
      done: 2,
      total: 2,
      outcome: "complete",
    });
    expect(onFinished.mock.invocationCallOrder[0]).toBeGreaterThan(
      onResult.mock.invocationCallOrder.at(-1)!,
    );
    const progress = screen.getByRole("progressbar", {
      name: "AI translation progress",
    });
    expect(progress).toHaveAttribute("aria-valuenow", "100");
    expect(progress).toHaveStyle("--stv3-batch-progress: 100%");
    expect(screen.getByText(/saved as “Needs review”/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("cancel finishes the in-flight string, saves it, then stops", async () => {
    let release: (result: TranslationResult) => void = () => {};
    const onTranslate = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<TranslationResult>((resolve) => (release = resolve)),
      )
      .mockResolvedValue(ok("never reached"));
    const { onResult, onFinished } = renderDialog(onTranslate);
    startRun();

    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    release(ok("Eins"));

    await screen.findByText("Batch translation cancelled");
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith(ITEMS[0], "Eins");
    expect(onTranslate).toHaveBeenCalledTimes(1);
    expect(onFinished).toHaveBeenCalledWith({
      done: 1,
      total: 2,
      outcome: "cancelled",
    });
    expect(screen.getByText(/Re-run later to continue/)).toBeInTheDocument();
  });

  it("turns Escape into a safe cancellation while a request is in flight", async () => {
    let release: (result: TranslationResult) => void = () => {};
    const onTranslate = vi.fn(
      () => new Promise<TranslationResult>((resolve) => (release = resolve)),
    );
    const { onClose, onFinished } = renderDialog(onTranslate);
    startRun();

    const dialog = await screen.findByRole("dialog", {
      name: "Batch AI translation",
    });
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("Cancelling…")).toBeVisible();
    release(ok("Eins"));

    await screen.findByText("Batch translation cancelled");
    expect(onFinished).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "cancelled" }),
    );
  });

  it("reports completion when Cancel arrives during the final in-flight string", async () => {
    let release: (result: TranslationResult) => void = () => {};
    const onTranslate = vi.fn(
      () => new Promise<TranslationResult>((resolve) => (release = resolve)),
    );
    const onFinished = vi.fn();
    renderDialog(onTranslate, { items: [ITEMS[0]], onFinished });
    startRun();

    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    release(ok("Eins"));

    await screen.findByText("Batch translation complete");
    expect(onFinished).toHaveBeenCalledWith({
      done: 1,
      total: 1,
      outcome: "complete",
    });
    expect(screen.queryByText("Batch translation cancelled")).toBeNull();
  });

  it("a server error aborts the run and keeps the partial progress", async () => {
    const onTranslate = vi
      .fn()
      .mockResolvedValueOnce(ok("Eins"))
      .mockRejectedValueOnce("Could not reach http://localhost:1234");
    const { onResult, onFinished } = renderDialog(onTranslate);
    startRun();

    await screen.findByText("Batch translation failed");
    expect(
      screen.getByText(/Could not reach http:\/\/localhost:1234/),
    ).toBeInTheDocument();
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onFinished).toHaveBeenCalledWith({
      done: 1,
      total: 2,
      outcome: "error",
      error: "Could not reach http://localhost:1234",
    });
    expect(screen.getByText(/Re-run later to continue/)).toBeInTheDocument();
  });

  it("lists strings whose result still misses protected tokens", async () => {
    const onTranslate = vi
      .fn()
      .mockResolvedValueOnce({
        text: "kaputt",
        missingTokens: ["{{name}}"],
        glossaryMisses: [],
      })
      .mockResolvedValueOnce(ok("gut"));
    renderDialog(onTranslate);
    startRun();

    await screen.findByText("Batch translation complete");
    expect(screen.getByText(/Dropped protected tokens/)).toBeInTheDocument();
    expect(screen.getByText("first.key")).toBeInTheDocument();
  });

  it("traps Tab, closes on Escape before start, and restores trigger focus", async () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const parentKeyDown = vi.fn();
    document.body.addEventListener("keydown", parentKeyDown);
    const { onClose, unmount } = renderDialog(async (source) => ok(source));

    const first = screen.getByRole("button", { name: "Cancel AI translation" });
    await waitFor(() => expect(first).toHaveFocus());
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(
      screen.getByRole("button", { name: "Start AI translation" }),
    ).toHaveFocus();
    expect(parentKeyDown).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    unmount();
    expect(trigger).toHaveFocus();

    document.body.removeEventListener("keydown", parentKeyDown);
    trigger.remove();
  });
});
