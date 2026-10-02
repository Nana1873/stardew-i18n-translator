/**
 * BatchTranslateDialog in isolation — immediate selected-string execution,
 * compact progress, cancellation, Review persistence, and completion reporting.
 */
import { StrictMode } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, vi } from "vitest";
import {
  BatchTranslateDialog,
  type BatchFinishedResult,
  type BatchItem,
  type LiveAiEngineOption,
} from "./BatchTranslateDialog";
import type { AiRunResult } from "../tauri/commands";

const eventApi = vi.hoisted(() => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: eventApi.listen }));

let unlistenProgress: ReturnType<typeof vi.fn>;

beforeEach(() => {
  unlistenProgress = vi.fn();
  eventApi.listen.mockReset();
  eventApi.listen.mockResolvedValue(unlistenProgress);
});

const ITEMS: BatchItem[] = [
  {
    modUniqueId: "a.b",
    key: "first.key",
    file: "i18n",
    source: "One",
    status: "untranslated",
    section: "Dialogue",
  },
  {
    modUniqueId: "a.b",
    key: "second.key",
    file: "i18n",
    source: "Two",
    status: "outdated",
  },
];

const CLOUD_ENGINE: LiveAiEngineOption = {
  id: "chatgpt",
  label: "ChatGPT",
  ready: true,
  model: "gpt-6.1-sol",
  reasoning: "medium",
  note: "Uses the signed-in ChatGPT.",
};

function liveResult(overrides: Partial<AiRunResult> = {}): AiRunResult {
  return {
    runId: "run-1",
    engine: "chatgpt",
    model: "gpt-6.1-sol",
    reasoning: "medium",
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
    onFinished?: (result: BatchFinishedResult) => void;
    onClose?: () => void;
    strict?: boolean;
  } = {},
) {
  const onLiveRun =
    options.onLiveRun ?? vi.fn(async (runId: string) => liveResult({ runId }));
  const onFinished = options.onFinished ?? vi.fn();
  const onClose = options.onClose ?? vi.fn();
  const dialog = (
    <BatchTranslateDialog
      items={options.items ?? ITEMS}
      modName="Test Mod"
      engine={options.engine}
      onLiveRun={onLiveRun}
      onCancelLiveRun={options.onCancelLiveRun}
      onFinished={onFinished}
      onClose={onClose}
    />
  );
  const view = render(
    options.strict ? <StrictMode>{dialog}</StrictMode> : dialog,
  );
  return { ...view, onLiveRun, onFinished, onClose };
}

describe("BatchTranslateDialog", () => {
  it("records interleaved phases once and advances only on persisted saves", async () => {
    const onLiveRun = vi.fn(
      (_runId: string) => new Promise<AiRunResult>(() => {}),
    );
    renderDialog({ engine: CLOUD_ENGINE, onLiveRun });
    await waitFor(() => expect(onLiveRun).toHaveBeenCalledOnce());
    const receiveProgress = eventApi.listen.mock.calls[0][1];
    const payload = {
      runId: onLiveRun.mock.calls[0][0],
      phase: "reviewing",
      completed: 24,
      translated: 177,
      total: 1109,
      batchTotal: 13,
      parallelLimit: 4,
      retries: 1,
      splits: 0,
      batchActivity: [
        { batchIndex: 1, phase: "reviewing", batchSize: 83 },
        { batchIndex: 2, phase: "translating", batchSize: 100 },
        {
          batchIndex: 3,
          phase: "reviewing",
          batchSize: 94,
          recovery: "transientRetry",
        },
        { batchIndex: 4, phase: "translating", batchSize: 97 },
      ],
    };
    act(() => receiveProgress({ payload }));
    const log = screen.getByRole("log", { name: "Batch activity" });
    expect(screen.getAllByRole("progressbar")).toHaveLength(1);
    expect(screen.getByRole("status", { name: "" })).toHaveTextContent(
      "4 batches active · up to 4 · 13 batches total",
    );
    expect(
      within(log).getByText("Batch 2 · Translating draft · 100 strings"),
    ).toBeVisible();
    expect(
      within(log).getByText(
        "Batch 3 · Checking translation quality · 94 strings",
      ),
    ).toBeVisible();
    expect(
      within(log).getByText("Batch 3 · Retrying temporary failure"),
    ).toBeVisible();
    const count = within(log).getAllByRole("listitem").length;
    act(() =>
      receiveProgress({
        payload: {
          ...payload,
          providerStage: "writingResponse",
          providerActivitySequence: 8,
        },
      }),
    );
    expect(within(log).getAllByRole("listitem")).toHaveLength(count);

    // A vanished pipeline may have failed. It cannot advance persisted progress.
    const removed = {
      ...payload,
      batchActivity: payload.batchActivity.slice(1),
    };
    act(() => receiveProgress({ payload: removed }));
    expect(within(log).getAllByRole("listitem")).toHaveLength(count);
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "24",
    );

    act(() =>
      receiveProgress({
        payload: {
          ...removed,
          phase: "tokenRepair",
          completed: 107,
          translated: 277,
          batchActivity: [
            { batchIndex: 2, phase: "reviewing", batchSize: 100 },
            { batchIndex: 3, phase: "tokenRepair", batchSize: 1 },
            { batchIndex: 4, phase: "translating", batchSize: 97 },
          ],
        },
      }),
    );
    expect(screen.getByRole("status", { name: "" })).toHaveTextContent(
      "3 batches active · up to 4 · 13 batches total",
    );
    expect(
      within(log).getByText("Batch 3 · Repairing protected tokens · 1 string"),
    ).toBeVisible();
    expect(
      within(log).getByText("83 suggestions saved to Review · 107 / 1109"),
    ).toBeVisible();
    // Old phase entries remain available as history, not current activity cards.
    expect(
      within(log).getByText(
        "Batch 1 · Checking translation quality · 83 strings",
      ),
    ).toBeVisible();
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "107",
    );
    act(() =>
      receiveProgress({
        payload: { ...removed, completed: 107, batchActivity: [] },
      }),
    );
    expect(screen.getByRole("status", { name: "" })).toHaveTextContent(
      "0 batches active",
    );
    expect(within(log).queryByText(/Batch 1.*saved/)).not.toBeInTheDocument();
  });

  it("records eight batch identities and shows quality settings above the log", async () => {
    const onLiveRun = vi.fn(
      (_runId: string) => new Promise<AiRunResult>(() => {}),
    );
    renderDialog({
      engine: { ...CLOUD_ENGINE, qualityReview: false },
      onLiveRun,
    });
    await waitFor(() => expect(onLiveRun).toHaveBeenCalledOnce());
    const receiveProgress = eventApi.listen.mock.calls[0][1];
    act(() =>
      receiveProgress({
        payload: {
          runId: onLiveRun.mock.calls[0][0],
          phase: "translating",
          completed: 0,
          total: 800,
          batchTotal: 8,
          parallelLimit: 8,
          retries: 0,
          splits: 0,
          batchActivity: Array.from({ length: 8 }, (_, index) => ({
            batchIndex: 8 - index,
            phase: "translating",
            batchSize: 100,
          })),
        },
      }),
    );
    const log = screen.getByRole("log");
    for (let batch = 1; batch <= 8; batch++) {
      expect(
        within(log).getByText(
          `Batch ${batch} · Translating draft · 100 strings`,
        ),
      ).toBeVisible();
    }
    expect(screen.getByText("Off")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("status", { name: "" })).toHaveTextContent(
      "Cancelling active batches",
    );
    expect(within(log).getByText(/Cancellation requested/)).toBeVisible();
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "0",
    );
  });

  it("bounds long activity histories without duplicating provider updates", async () => {
    const onLiveRun = vi.fn(
      (_runId: string) => new Promise<AiRunResult>(() => {}),
    );
    renderDialog({ onLiveRun });
    await waitFor(() => expect(onLiveRun).toHaveBeenCalledOnce());
    const receiveProgress = eventApi.listen.mock.calls[0][1];
    act(() => {
      for (let batchIndex = 1; batchIndex <= 205; batchIndex++) {
        receiveProgress({
          payload: {
            runId: onLiveRun.mock.calls[0][0],
            phase: "translating",
            completed: 0,
            total: 205,
            batchIndex,
            batchSize: 1,
            retries: 0,
            splits: 0,
          },
        });
      }
    });
    const log = screen.getByRole("log");
    expect(within(log).getAllByRole("listitem")).toHaveLength(200);
    expect(screen.getByText("Latest 200 events")).toBeVisible();
    expect(
      within(log).queryByText("Batch 1 · Translating draft · 1 string"),
    ).not.toBeInTheDocument();
    expect(
      within(log).getByText("Batch 205 · Translating draft · 1 string"),
    ).toBeVisible();
    expect(within(log).queryByText(/saved to Review/)).not.toBeInTheDocument();
  });

  it("allows reading older activity without forcing the scroll back down", async () => {
    const onLiveRun = vi.fn(
      (_runId: string) => new Promise<AiRunResult>(() => {}),
    );
    renderDialog({ onLiveRun });
    await waitFor(() => expect(onLiveRun).toHaveBeenCalledOnce());
    const receiveProgress = eventApi.listen.mock.calls[0][1];
    const log = screen.getByRole("log");
    Object.defineProperties(log, {
      scrollHeight: { value: 300, configurable: true },
      clientHeight: { value: 100 },
    });
    log.scrollTop = 40;
    fireEvent.scroll(log);
    const payload = {
      runId: onLiveRun.mock.calls[0][0],
      phase: "translating",
      completed: 0,
      total: 2,
      batchIndex: 1,
      batchSize: 2,
      retries: 0,
      splits: 0,
    };
    act(() => receiveProgress({ payload }));
    expect(log.scrollTop).toBe(40);
    log.scrollTop = 200;
    fireEvent.scroll(log);
    Object.defineProperty(log, "scrollHeight", { value: 400 });
    act(() => receiveProgress({ payload: { ...payload, phase: "reviewing" } }));
    expect(log.scrollTop).toBe(400);
  });

  it("shows translated drafts before the first batch is saved to Review", async () => {
    const onLiveRun = vi.fn(
      (_runId: string) => new Promise<AiRunResult>(() => {}),
    );
    renderDialog({ engine: CLOUD_ENGINE, onLiveRun });
    await waitFor(() => expect(onLiveRun).toHaveBeenCalledOnce());
    const runId = onLiveRun.mock.calls[0][0];
    const receiveProgress = eventApi.listen.mock.calls[0][1];
    const payload = {
      runId,
      phase: "reviewing",
      completed: 0,
      translated: 93,
      total: 282,
      batchIndex: 1,
      batchTotal: 4,
      batchSize: 93,
      retries: 0,
      splits: 0,
    };
    act(() => receiveProgress({ payload }));
    expect(screen.getByLabelText("Translated strings")).toHaveTextContent(
      "93 / 282",
    );
    expect(screen.getByLabelText("Translated strings")).toBeVisible();
    expect(screen.getByText("0 / 282")).toBeVisible();
    expect(screen.getByRole("status", { name: "" })).toHaveTextContent(
      "Checking translation quality · Batch 1 of 4 · 93 strings",
    );
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "0",
    );
    act(() =>
      receiveProgress({
        payload: { ...payload, phase: "saving", completed: 93 },
      }),
    );
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "93",
    );
    expect(screen.getByRole("status", { name: "" })).toHaveTextContent(
      "Validating & saving",
    );
  });

  it("starts the configured live engine immediately with only compact progress and Cancel", async () => {
    let resolveRun: (result: AiRunResult) => void = () => {};
    const onLiveRun = vi.fn(
      (_runId: string) =>
        new Promise<AiRunResult>((resolve) => {
          resolveRun = resolve;
        }),
    );
    const { onFinished, onClose } = renderDialog({
      engine: CLOUD_ENGINE,
      onLiveRun,
    });

    await waitFor(() => expect(onLiveRun).toHaveBeenCalledOnce());
    const runId = onLiveRun.mock.calls[0][0];
    expect(runId).toEqual(expect.any(String));
    expect(
      screen.getByRole("dialog", { name: "AI translation progress" }),
    ).toBeVisible();
    expect(screen.getByText("ChatGPT · GPT 6.1 Sol · Medium")).toBeVisible();
    expect(screen.getByText("Saved to Review")).toBeVisible();
    expect(screen.getByRole("status", { name: "" })).toHaveTextContent(
      "Preparing selected strings",
    );
    expect(screen.getByText(/Elapsed · 00:00/)).toBeVisible();
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
      engine: "ChatGPT",
      model: "gpt-6.1-sol",
      reasoning: "medium",
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("announces one selected string with singular grammar", async () => {
    let resolveRun: (result: AiRunResult) => void = () => {};
    const onLiveRun = vi.fn(
      (_runId: string) =>
        new Promise<AiRunResult>((resolve) => {
          resolveRun = resolve;
        }),
    );
    const { onFinished } = renderDialog({
      items: [ITEMS[0]],
      engine: CLOUD_ENGINE,
      onLiveRun,
    });

    await waitFor(() => expect(onLiveRun).toHaveBeenCalledOnce());
    expect(
      screen.getByRole("progressbar", { name: "AI translation progress" }),
    ).toHaveAttribute("aria-valuetext", "1 selected string is being prepared");

    const runId = onLiveRun.mock.calls[0][0];
    act(() =>
      resolveRun(
        liveResult({
          runId,
          requested: 1,
          completed: 1,
        }),
      ),
    );
    await waitFor(() => expect(onFinished).toHaveBeenCalledOnce());
  });

  it("starts only one live backend run under React StrictMode", async () => {
    let resolveRun: (result: AiRunResult) => void = () => {};
    const onLiveRun = vi.fn(
      (_runId: string) =>
        new Promise<AiRunResult>((resolve) => {
          resolveRun = resolve;
        }),
    );
    const { onFinished, onClose } = renderDialog({
      engine: CLOUD_ENGINE,
      onLiveRun,
      strict: true,
    });

    await waitFor(() => expect(onLiveRun).toHaveBeenCalledOnce());
    const runId = onLiveRun.mock.calls[0][0];
    act(() => resolveRun(liveResult({ runId })));

    await waitFor(() => expect(onFinished).toHaveBeenCalledOnce());
    expect(onFinished).toHaveBeenCalledWith({
      runId,
      done: 2,
      total: 2,
      outcome: "complete",
      engine: "ChatGPT",
      model: "gpt-6.1-sol",
      reasoning: "medium",
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not start a live backend run when Cancel wins the listener setup race", async () => {
    let resolveListen: (unlisten: typeof unlistenProgress) => void = () => {};
    eventApi.listen.mockReturnValueOnce(
      new Promise<typeof unlistenProgress>((resolve) => {
        resolveListen = resolve;
      }),
    );
    const onLiveRun = vi.fn(() => new Promise<AiRunResult>(() => {}));
    const onCancelLiveRun = vi.fn(async () => false);
    const { onFinished, onClose } = renderDialog({
      engine: CLOUD_ENGINE,
      onLiveRun,
      onCancelLiveRun,
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancelLiveRun).toHaveBeenCalledOnce();
    expect(onLiveRun).not.toHaveBeenCalled();
    expect(
      screen.getByRole("progressbar", { name: "AI translation progress" }),
    ).toHaveAttribute(
      "aria-valuetext",
      "Cancelling active AI work; 0 of 2 suggestions saved to Review",
    );

    await act(async () => resolveListen(unlistenProgress));

    await waitFor(() => expect(onFinished).toHaveBeenCalledOnce());
    expect(onLiveRun).not.toHaveBeenCalled();
    expect(onFinished).toHaveBeenCalledWith({
      runId: expect.any(String),
      done: 0,
      total: 2,
      outcome: "cancelled",
      engine: "ChatGPT",
      model: "gpt-6.1-sol",
      reasoning: "medium",
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows matching live backend progress and ignores progress from other runs", async () => {
    let resolveRun: (result: AiRunResult) => void = () => {};
    const onLiveRun = vi.fn(
      (_runId: string) =>
        new Promise<AiRunResult>((resolve) => {
          resolveRun = resolve;
        }),
    );
    const { onFinished } = renderDialog({
      engine: CLOUD_ENGINE,
      onLiveRun,
    });

    await waitFor(() => expect(onLiveRun).toHaveBeenCalledOnce());
    const runId = onLiveRun.mock.calls[0][0];
    expect(eventApi.listen).toHaveBeenCalledWith(
      "ai-run-progress",
      expect.any(Function),
    );
    const receiveProgress = eventApi.listen.mock.calls[0][1];
    const progress = screen.getByRole("progressbar", {
      name: "AI translation progress",
    });

    act(() =>
      receiveProgress({
        payload: {
          runId: "another-run",
          phase: "translating",
          completed: 99,
          total: 100,
          retries: 0,
          splits: 0,
        },
      }),
    );
    expect(screen.getByLabelText("Translated strings")).toHaveTextContent(
      "0 / 2",
    );
    expect(progress).toHaveAttribute("data-indeterminate", "true");

    act(() =>
      receiveProgress({
        payload: {
          runId,
          phase: "reviewing",
          completed: 320,
          translated: 407,
          total: 1_000,
          batchIndex: 4,
          batchTotal: 11,
          batchSize: 87,
          retries: 1,
          splits: 2,
          recovery: "structureRetry",
          providerStage: "reasoning",
          providerActivitySequence: 7,
          usage: {
            inputTokens: 45_200,
            cachedInputTokens: 32_900,
            outputTokens: 2_100,
            reasoningOutputTokens: 900,
          },
        },
      }),
    );
    expect(screen.getByText("320 / 1000")).toBeVisible();
    expect(screen.getByLabelText("Translated strings")).toHaveTextContent(
      "407 / 1000",
    );
    expect(screen.getByRole("status", { name: "" })).toHaveTextContent(
      "Checking translation quality · Batch 4 of 11 · 87 strings",
    );
    expect(
      within(screen.getByRole("log")).getByText(
        "Batch 4 · Retrying response structure",
      ),
    ).toBeVisible();
    expect(screen.getByText("Reasoning · just now")).toBeVisible();
    expect(
      screen.getByText(
        "45.2k input (32.9k cached) · 2.1k output · 900 reasoning",
      ),
    ).toBeVisible();
    expect(progress).not.toHaveAttribute("data-indeterminate");
    expect(progress).toHaveAttribute("aria-valuemax", "1000");
    expect(progress).toHaveAttribute("aria-valuenow", "320");
    expect(progress).toHaveAttribute(
      "aria-valuetext",
      "320 of 1000 suggestions saved to Review; checking translation quality · batch 4 of 11 · 87 strings",
    );

    act(() => resolveRun(liveResult({ runId })));
    await waitFor(() => expect(onFinished).toHaveBeenCalledOnce());
  });

  it("updates a stable ETA only when more suggestions have been saved", async () => {
    const startedAt = Date.parse("2026-08-27T10:00:00Z");
    const now = vi.spyOn(Date, "now").mockReturnValue(startedAt);
    let resolveRun: (result: AiRunResult) => void = () => {};
    const onLiveRun = vi.fn(
      (_runId: string) =>
        new Promise<AiRunResult>((resolve) => {
          resolveRun = resolve;
        }),
    );
    const onCancelLiveRun = vi.fn(async () => true);
    try {
      const { onFinished } = renderDialog({
        engine: CLOUD_ENGINE,
        onLiveRun,
        onCancelLiveRun,
      });
      await waitFor(() => expect(onLiveRun).toHaveBeenCalledOnce());
      const runId = onLiveRun.mock.calls[0][0];
      const receiveProgress = eventApi.listen.mock.calls[0][1];

      expect(screen.queryByText(/Estimated remaining/)).not.toBeInTheDocument();

      now.mockReturnValue(startedAt + 480_000);
      act(() =>
        receiveProgress({
          payload: {
            runId,
            phase: "saving",
            completed: 80,
            total: 400,
            batchIndex: 1,
            batchTotal: 5,
            batchSize: 80,
            retries: 0,
            splits: 0,
          },
        }),
      );
      expect(
        screen.getByText("Estimated remaining · about 32 min"),
      ).toBeVisible();

      now.mockReturnValue(startedAt + 600_000);
      act(() =>
        receiveProgress({
          payload: {
            runId,
            phase: "translating",
            completed: 80,
            total: 400,
            batchIndex: 2,
            batchTotal: 5,
            batchSize: 80,
            retries: 1,
            splits: 0,
            recovery: "transientRetry",
          },
        }),
      );
      expect(
        screen.getByText("Estimated remaining · about 32 min"),
      ).toBeVisible();

      now.mockReturnValue(startedAt + 900_000);
      act(() =>
        receiveProgress({
          payload: {
            runId,
            phase: "saving",
            completed: 160,
            total: 400,
            batchIndex: 2,
            batchTotal: 5,
            batchSize: 80,
            retries: 1,
            splits: 0,
          },
        }),
      );
      expect(
        screen.getByText("Estimated remaining · about 23 min"),
      ).toBeVisible();

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.queryByText(/Estimated remaining/)).not.toBeInTheDocument();
      expect(onCancelLiveRun).toHaveBeenCalledWith(runId);

      act(() =>
        resolveRun(
          liveResult({
            runId,
            requested: 400,
            completed: 160,
            outcome: "cancelled",
          }),
        ),
      );
      await waitFor(() => expect(onFinished).toHaveBeenCalledOnce());
    } finally {
      now.mockRestore();
    }
  });

  it("removes the live progress listener when the dialog unmounts", async () => {
    const onLiveRun = vi.fn(() => new Promise<AiRunResult>(() => {}));
    const { unmount } = renderDialog({
      engine: CLOUD_ENGINE,
      onLiveRun,
    });

    await waitFor(() => expect(onLiveRun).toHaveBeenCalledOnce());
    unmount();

    expect(unlistenProgress).toHaveBeenCalledOnce();
  });

  it("updates the elapsed timer while the live backend is running", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T10:00:00Z"));
    try {
      const onLiveRun = vi.fn(() => new Promise<AiRunResult>(() => {}));
      const { unmount } = renderDialog({
        onLiveRun,
      });

      expect(screen.getByText(/Elapsed · 00:00/)).toBeVisible();
      act(() => {
        vi.advanceTimersByTime(34_000);
      });
      expect(screen.getByText(/Elapsed · 00:34/)).toBeVisible();
      unmount();
    } finally {
      vi.useRealTimers();
    }
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
    const { onFinished, onClose } = renderDialog({
      engine: CLOUD_ENGINE,
      onLiveRun,
      onCancelLiveRun,
    });

    await waitFor(() => expect(onLiveRun).toHaveBeenCalledOnce());
    const runId = onLiveRun.mock.calls[0][0];
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancelLiveRun).toHaveBeenCalledWith(runId);
    expect(screen.getByRole("heading", { name: "Cancelling…" })).toBeVisible();
    const receiveProgress = eventApi.listen.mock.calls[0][1];
    act(() =>
      receiveProgress({
        payload: {
          runId,
          phase: "reviewing",
          completed: 1,
          total: 2,
          batchIndex: 1,
          batchTotal: 1,
          batchSize: 2,
          retries: 0,
          splits: 0,
        },
      }),
    );
    expect(screen.getByRole("status", { name: "" })).toHaveTextContent(
      "Cancelling active batch",
    );
    expect(
      screen.queryByText(/Checking translation quality/),
    ).not.toBeInTheDocument();

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
      engine: "ChatGPT",
      model: "gpt-6.1-sol",
      reasoning: "medium",
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("reports a live backend error and closes", async () => {
    const onLiveRun = vi.fn().mockRejectedValue(new Error("Local AI offline"));
    const { onFinished, onClose } = renderDialog({
      engine: CLOUD_ENGINE,
      onLiveRun,
    });

    await waitFor(() => expect(onFinished).toHaveBeenCalledOnce());
    expect(onFinished).toHaveBeenCalledWith({
      runId: expect.any(String),
      done: 0,
      total: 2,
      outcome: "error",
      error: "Error: Local AI offline",
      engine: "ChatGPT",
      model: "gpt-6.1-sol",
      reasoning: "medium",
    });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
