/**
 * BatchTranslateDialog in isolation — immediate selected-string execution,
 * compact progress, cancellation, Review persistence, and completion reporting.
 */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { vi } from "vitest";
import {
  BatchTranslateDialog,
  type BatchFinishedResult,
  type BatchItem,
  type LiveAiEngineOption,
} from "./BatchTranslateDialog";
import type { AiRunResult, TranslationResult } from "../tauri/commands";

const ITEMS: BatchItem[] = [
  {
    index: 0,
    modUniqueId: "a.b",
    key: "first.key",
    file: "i18n",
    source: "One",
    status: "untranslated",
    section: "Dialogue",
  },
  {
    index: 1,
    modUniqueId: "a.b",
    key: "second.key",
    file: "i18n",
    source: "Two",
    status: "outdated",
  },
];

const CODEX_ENGINE: LiveAiEngineOption = {
  id: "codex",
  label: "Codex CLI",
  ready: true,
  model: "gpt-5.6",
  reasoning: "high",
  note: "Uses the signed-in Codex CLI.",
};

function ok(text: string): TranslationResult {
  return { text, missingTokens: [], glossaryMisses: [] };
}

function liveResult(overrides: Partial<AiRunResult> = {}): AiRunResult {
  return {
    runId: "run-1",
    engine: "codex",
    model: "gpt-5.6",
    reasoning: "high",
    scope: "selected",
    requested: 2,
    completed: 2,
    outcome: "complete",
    suggestions: [],
    ...overrides,
  };
}

function renderDialog(
  options: {
    items?: BatchItem[];
    engine?: LiveAiEngineOption;
    onLiveRun?: (runId: string) => Promise<AiRunResult>;
    onCancelLiveRun?: (runId: string) => Promise<boolean>;
    onTranslate?: (
      source: string,
      section?: string | null,
    ) => Promise<TranslationResult>;
    onResult?: (item: BatchItem, text: string) => Promise<void>;
    onFinished?: (result: BatchFinishedResult) => void;
    onClose?: () => void;
  } = {},
) {
  const onTranslate =
    options.onTranslate ?? vi.fn(async (source: string) => ok(source));
  const onResult = options.onResult ?? vi.fn(async () => undefined);
  const onFinished = options.onFinished ?? vi.fn();
  const onClose = options.onClose ?? vi.fn();
  const view = render(
    <BatchTranslateDialog
      items={options.items ?? ITEMS}
      modName="Test Mod"
      engine={options.engine}
      onLiveRun={options.onLiveRun}
      onCancelLiveRun={options.onCancelLiveRun}
      onTranslate={onTranslate}
      onResult={onResult}
      onFinished={onFinished}
      onClose={onClose}
    />,
  );
  return { ...view, onTranslate, onResult, onFinished, onClose };
}

describe("BatchTranslateDialog", () => {
  it("starts the configured live engine immediately with only compact progress and Cancel", async () => {
    let resolveRun: (result: AiRunResult) => void = () => {};
    const onLiveRun = vi.fn(
      (_runId: string) =>
        new Promise<AiRunResult>((resolve) => {
          resolveRun = resolve;
        }),
    );
    const { onResult, onFinished, onClose } = renderDialog({
      engine: CODEX_ENGINE,
      onLiveRun,
    });

    await waitFor(() => expect(onLiveRun).toHaveBeenCalledOnce());
    const runId = onLiveRun.mock.calls[0][0];
    expect(runId).toEqual(expect.any(String));
    expect(
      screen.getByRole("dialog", { name: "AI translation progress" }),
    ).toBeVisible();
    expect(
      screen.getByText(/Codex CLI .* completed suggestions enter Review/),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Start AI translation/ }),
    ).not.toBeInTheDocument();
    const progress = screen.getByRole("progressbar", {
      name: "AI translation progress",
    });
    expect(progress).toHaveAttribute("data-indeterminate", "true");
    expect(progress).not.toHaveAttribute("aria-valuenow");

    act(() => resolveRun(liveResult({ runId })));

    await waitFor(() => expect(onFinished).toHaveBeenCalledOnce());
    expect(onFinished).toHaveBeenCalledWith({
      runId,
      done: 2,
      total: 2,
      outcome: "complete",
      engine: "Codex CLI",
      model: "gpt-5.6",
      reasoning: "high",
    });
    expect(onResult).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("translates the selected Open and Changed items serially and hands every result to Review persistence", async () => {
    const calls: string[] = [];
    const onTranslate = vi.fn(async (source: string) => {
      calls.push(source);
      return ok(`X-${source}`);
    });
    const onResult = vi.fn(async () => undefined);
    const onFinished = vi.fn();
    const { onClose } = renderDialog({
      onTranslate,
      onResult,
      onFinished,
    });

    await waitFor(() => expect(onFinished).toHaveBeenCalledOnce());
    expect(calls).toEqual(["One", "Two"]);
    expect(onTranslate).toHaveBeenNthCalledWith(1, "One", "Dialogue");
    expect(onTranslate).toHaveBeenNthCalledWith(2, "Two", undefined);
    expect(onResult).toHaveBeenNthCalledWith(1, ITEMS[0], "X-One");
    expect(onResult).toHaveBeenNthCalledWith(2, ITEMS[1], "X-Two");
    expect(onFinished).toHaveBeenCalledWith({
      done: 2,
      total: 2,
      outcome: "complete",
      engine: "Local AI",
    });
    expect(onFinished.mock.invocationCallOrder[0]).toBeGreaterThan(
      onResult.mock.invocationCallOrder.at(-1)!,
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("cancels after the in-flight local result is saved to Review", async () => {
    let release: (result: TranslationResult) => void = () => {};
    const onTranslate = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<TranslationResult>((resolve) => (release = resolve)),
      )
      .mockResolvedValue(ok("never reached"));
    const { onResult, onFinished, onClose } = renderDialog({ onTranslate });

    await waitFor(() => expect(onTranslate).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Cancelling…" })).toBeDisabled();
    act(() => release(ok("Eins")));

    await waitFor(() => expect(onFinished).toHaveBeenCalledOnce());
    expect(onResult).toHaveBeenCalledWith(ITEMS[0], "Eins");
    expect(onTranslate).toHaveBeenCalledOnce();
    expect(onFinished).toHaveBeenCalledWith({
      done: 1,
      total: 2,
      outcome: "cancelled",
      engine: "Local AI",
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("forwards live cancellation to the backend and keeps backend Review work authoritative", async () => {
    let resolveRun: (result: AiRunResult) => void = () => {};
    const onLiveRun = vi.fn(
      (_runId: string) =>
        new Promise<AiRunResult>((resolve) => {
          resolveRun = resolve;
        }),
    );
    const onCancelLiveRun = vi.fn(async () => true);
    const { onResult, onFinished, onClose } = renderDialog({
      engine: CODEX_ENGINE,
      onLiveRun,
      onCancelLiveRun,
    });

    await waitFor(() => expect(onLiveRun).toHaveBeenCalledOnce());
    const runId = onLiveRun.mock.calls[0][0];
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancelLiveRun).toHaveBeenCalledWith(runId);
    expect(screen.getByRole("heading", { name: "Cancelling…" })).toBeVisible();

    act(() =>
      resolveRun(
        liveResult({
          runId,
          requested: 2,
          completed: 1,
          outcome: "cancelled",
          suggestions: [
            {
              identity: {
                modUniqueId: "a.b",
                relativeDir: "i18n",
                key: "first.key",
              },
              text: "Eins",
              status: "review-needed",
              tokenDifferences: [],
              glossaryMisses: [],
            },
          ],
        }),
      ),
    );

    await waitFor(() => expect(onFinished).toHaveBeenCalledOnce());
    expect(onFinished).toHaveBeenCalledWith({
      runId,
      done: 1,
      total: 2,
      outcome: "cancelled",
      engine: "Codex CLI",
      model: "gpt-5.6",
      reasoning: "high",
    });
    expect(onResult).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("reports an error with the completed Review count and closes", async () => {
    const onTranslate = vi
      .fn()
      .mockResolvedValueOnce(ok("Eins"))
      .mockRejectedValueOnce(new Error("Local AI offline"));
    const { onResult, onFinished, onClose } = renderDialog({ onTranslate });

    await waitFor(() => expect(onFinished).toHaveBeenCalledOnce());
    expect(onResult).toHaveBeenCalledOnce();
    expect(onFinished).toHaveBeenCalledWith({
      done: 1,
      total: 2,
      outcome: "error",
      error: "Error: Local AI offline",
      engine: "Local AI",
    });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
