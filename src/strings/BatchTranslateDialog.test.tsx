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
} from "@testing-library/react";
import { beforeEach, vi } from "vitest";
import {
  BatchTranslateDialog,
  type BatchFinishedResult,
  type BatchItem,
  type LiveAiEngineOption,
} from "./BatchTranslateDialog";
import type { AiRunProgress, AiRunResult } from "../tauri/commands";

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
  model: "gpt-5.6",
  reasoning: "high",
  note: "Uses the signed-in ChatGPT.",
};

function liveResult(overrides: Partial<AiRunResult> = {}): AiRunResult {
  return {
    runId: "run-1",
    engine: "chatgpt",
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

describe("AI progress notice", () => {
  it("starts once, stays nonmodal and reports the authoritative result", async () => {
    let resolve!: (result: AiRunResult) => void;
    const run = vi.fn(
      (_id: string) =>
        new Promise<AiRunResult>((done) => {
          resolve = done;
        }),
    );
    const { onFinished, onClose } = renderDialog({
      engine: CLOUD_ENGINE,
      onLiveRun: run,
      strict: true,
    });
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(screen.getByLabelText("AI translation progress")).toBeVisible();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Test Mod")).toBeVisible();
    expect(screen.queryByText("Details")).toBeNull();
    const progress = screen.getByRole("progressbar", {
      name: "Strings saved to Review",
    });
    expect(progress).not.toHaveAttribute("value");
    const runId = run.mock.calls[0][0];
    await act(async () => {
      resolve(liveResult({ runId }));
    });
    expect(onFinished).toHaveBeenCalledExactlyOnceWith({
      runId,
      done: 2,
      total: 2,
      outcome: "complete",
      engine: "ChatGPT",
      model: "gpt-5.6",
      reasoning: "high",
    });
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole("img", { name: "In progress" })).toBeNull();
  });

  it("announces a singular selected string", async () => {
    const run = vi.fn((_id: string) => new Promise<AiRunResult>(() => {}));
    renderDialog({ items: [ITEMS[0]], engine: CLOUD_ENGINE, onLiveRun: run });
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuetext",
      "1 selected string is being prepared",
    );
  });

  it("shows saved progress only and sends batch activity to the shared log", async () => {
    const run = vi.fn((_id: string) => new Promise<AiRunResult>(() => {}));
    const activity = vi.fn();
    window.addEventListener("translator-ai-activity", activity);
    try {
      renderDialog({ engine: CLOUD_ENGINE, onLiveRun: run });
      await waitFor(() => expect(run).toHaveBeenCalledOnce());
      const runId = run.mock.calls[0][0],
        receive = eventApi.listen.mock.calls[0][1];
      act(() =>
        receive({
          payload: {
            runId: "other",
            phase: "saving",
            completed: 99,
            total: 100,
            retries: 0,
            splits: 0,
          },
        }),
      );
      expect(screen.getByRole("progressbar")).not.toHaveAttribute("value");
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
      act(() => receive({ payload }));
      expect(screen.getByRole("progressbar")).toHaveAttribute("value", "0");
      expect(screen.getByText("0 / 282")).toBeVisible();
      expect(screen.queryByText("93 / 282")).toBeNull();
      expect(screen.queryByRole("log")).toBeNull();
      expect(
        activity.mock.calls.some(([event]) =>
          event.detail.entries.some((entry: { message: string }) =>
            entry.message.includes("Checking translation quality"),
          ),
        ),
      ).toBe(true);
      act(() =>
        receive({ payload: { ...payload, phase: "saving", completed: 93 } }),
      );
      expect(screen.getByRole("progressbar")).toHaveAttribute("value", "93");
      expect(screen.getByRole("progressbar")).toHaveAttribute(
        "aria-valuetext",
        "93 of 282 suggestions saved to Review",
      );
    } finally {
      window.removeEventListener("translator-ai-activity", activity);
    }
  });

  it("keeps main steps active without logging provider microsteps or inventing saves", async () => {
    const run = vi.fn((_id: string) => new Promise<AiRunResult>(() => {}));
    const activity = vi.fn();
    window.addEventListener("translator-ai-activity", activity);
    try {
      renderDialog({ engine: CLOUD_ENGINE, onLiveRun: run });
      await waitFor(() => expect(run).toHaveBeenCalledOnce());
      const receive = eventApi.listen.mock.calls[0][1];
      let payload: AiRunProgress = {
        runId: run.mock.calls[0][0],
        phase: "translating",
        batchIndex: 1,
        batchSize: 2,
        completed: 0,
        translated: 0,
        total: 2,
        retries: 0,
        splits: 0,
      };
      const update = (changes: Partial<AiRunProgress>) => {
        payload = { ...payload, ...changes };
        act(() => receive({ payload }));
      };
      const messages = () =>
        activity.mock.calls.flatMap(([event]) =>
          event.detail.entries.map(
            (entry: { message: string }) => entry.message,
          ),
        );
      update({ providerStage: "working", providerActivitySequence: 1 });
      expect(screen.getByRole("status")).toHaveTextContent(
        "Batch 1 · Translating draft · 2 strings",
      );
      update({ providerStage: "reasoning", providerActivitySequence: 2 });
      expect(screen.getByRole("status")).toHaveTextContent(
        "Batch 1 · Translating draft · 2 strings",
      );
      update({ providerStage: "writingResponse", providerActivitySequence: 3 });
      expect(screen.getByRole("status")).toHaveTextContent(
        "Batch 1 · Translating draft · 2 strings",
      );
      const logged = messages().length;
      update({ providerActivitySequence: 4 });
      expect(messages()).toHaveLength(logged);
      expect(screen.getByRole("img", { name: "In progress" })).toBeVisible();
      expect(activity.mock.calls.at(-1)?.[0].detail.activeSteps).toEqual([
        `${payload.runId}:1:translating`,
      ]);
      expect(messages()).not.toContainEqual(
        expect.stringMatching(
          /Processing request|Preparing response|Receiving response|Response received/,
        ),
      );
      expect(screen.getByRole("progressbar")).toHaveAttribute("value", "0");
      expect(messages()).not.toContainEqual(
        expect.stringContaining("saved to Review"),
      );

      update({ providerStage: "completed", providerActivitySequence: 5 });
      update({ translated: 2 });
      update({ phase: "reviewing", providerStage: undefined });
      update({ providerStage: "writingResponse", providerActivitySequence: 6 });
      expect(screen.getByRole("status")).toHaveTextContent(
        "Checking translation quality · 2 strings",
      );
      expect(screen.getByRole("progressbar")).toHaveAttribute("value", "0");
      expect(messages()).toContain("Batch 1 · 2 drafts received · 2 / 2");
      expect(
        messages().filter((message: string) =>
          message.includes("drafts received"),
        ),
      ).toHaveLength(1);
      update({ phase: "saving", providerStage: undefined });
      update({ completed: 2 });
      expect(messages()).toContain("Batch 1 · 2 strings saved to Review");
      expect(screen.getByRole("progressbar")).toHaveAttribute("value", "2");
      expect(screen.queryByRole("img", { name: "In progress" })).toBeNull();
      expect(activity.mock.calls.at(-1)?.[0].detail.activeSteps).toEqual([]);
    } finally {
      window.removeEventListener("translator-ai-activity", activity);
    }
  });

  it("does not assign aggregate provider activity to a parallel batch or infer saves", async () => {
    const run = vi.fn((_id: string) => new Promise<AiRunResult>(() => {}));
    const activity = vi.fn();
    window.addEventListener("translator-ai-activity", activity);
    try {
      renderDialog({ engine: CLOUD_ENGINE, onLiveRun: run });
      await waitFor(() => expect(run).toHaveBeenCalledOnce());
      const receive = eventApi.listen.mock.calls[0][1];
      const payload: AiRunProgress = {
        runId: run.mock.calls[0][0],
        phase: "translating",
        batchIndex: 2,
        completed: 0,
        translated: 1,
        total: 2,
        retries: 0,
        splits: 0,
        providerStage: "writingResponse",
        providerActivitySequence: 1,
        batchActivity: [
          { batchIndex: 1, phase: "reviewing", batchSize: 1 },
          { batchIndex: 2, phase: "translating", batchSize: 1 },
        ],
      };
      act(() => receive({ payload }));
      expect(screen.getByRole("status")).toHaveTextContent("2 batches active");
      const messages = activity.mock.calls.flatMap(([event]) =>
        event.detail.entries.map((entry: { message: string }) => entry.message),
      );
      expect(messages).toContain(
        "Batch 1 · Checking translation quality · 1 string",
      );
      expect(messages).toContain("Batch 2 · Translating draft · 1 string");
      expect(activity.mock.calls.at(-1)?.[0].detail.activeSteps).toEqual([
        `${payload.runId}:1:reviewing`,
        `${payload.runId}:2:translating`,
      ]);
      expect(messages).toContain("1 draft received · 1 / 2");
      expect(messages).not.toContain("Batch 2 · Receiving response");
      act(() =>
        receive({
          payload: { ...payload, batchActivity: [], providerStage: undefined },
        }),
      );
      expect(screen.getByRole("progressbar")).toHaveAttribute("value", "0");
      expect(screen.getByRole("status")).toHaveTextContent("Finishing run");
      expect(screen.queryByRole("img", { name: "In progress" })).toBeNull();
      expect(activity.mock.calls.at(-1)?.[0].detail.activeSteps).toEqual([]);
      const logged = activity.mock.calls.flatMap(
        ([event]) => event.detail.entries,
      );
      expect(logged).not.toContainEqual(
        expect.objectContaining({
          message: expect.stringContaining("saved to Review"),
        }),
      );
    } finally {
      window.removeEventListener("translator-ai-activity", activity);
    }
  });

  it("keeps the original selection, engine and callbacks when the workspace changes", async () => {
    const run = vi.fn((_id: string) => new Promise<AiRunResult>(() => {}));
    const replacement = vi.fn();
    const view = renderDialog({ engine: CLOUD_ENGINE, onLiveRun: run });
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    view.rerender(
      <BatchTranslateDialog
        items={[ITEMS[0]]}
        modName="Other mod"
        engine={{ ...CLOUD_ENGINE, label: "Local AI" }}
        onLiveRun={replacement}
        onFinished={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("Test Mod")).toBeVisible();
    expect(screen.getByText("ChatGPT")).toBeVisible();
    expect(screen.getByText("0 / 2")).toBeVisible();
    expect(replacement).not.toHaveBeenCalled();
  });

  it("cancels before listener setup without launching a backend run", async () => {
    let resolve!: (release: () => void) => void;
    eventApi.listen.mockReturnValueOnce(
      new Promise<() => void>((done) => {
        resolve = done;
      }),
    );
    const run = vi.fn(() => new Promise<AiRunResult>(() => {}));
    const cancel = vi.fn(async () => false);
    const { onFinished, onClose } = renderDialog({
      engine: CLOUD_ENGINE,
      onLiveRun: run,
      onCancelLiveRun: cancel,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel AI translation" }),
    );
    await act(async () => {
      resolve(unlistenProgress as () => void);
    });
    expect(run).not.toHaveBeenCalled();
    expect(onFinished).toHaveBeenCalledWith(
      expect.objectContaining({ done: 0, total: 2, outcome: "cancelled" }),
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("waits for backend cancellation and preserves the saved partial result", async () => {
    let resolve!: (result: AiRunResult) => void;
    const run = vi.fn(
      (_id: string) =>
        new Promise<AiRunResult>((done) => {
          resolve = done;
        }),
    );
    const cancel = vi.fn(async () => true);
    const { onFinished } = renderDialog({
      engine: CLOUD_ENGINE,
      onLiveRun: run,
      onCancelLiveRun: cancel,
    });
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    const runId = run.mock.calls[0][0];
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel AI translation" }),
    );
    expect(cancel).toHaveBeenCalledWith(runId);
    expect(
      screen.getByRole("button", { name: "Cancel AI translation" }),
    ).toBeDisabled();
    expect(onFinished).not.toHaveBeenCalled();
    expect(screen.queryByRole("img", { name: "In progress" })).toBeNull();
    await act(async () => {
      resolve(liveResult({ runId, completed: 1, outcome: "cancelled" }));
    });
    expect(onFinished).toHaveBeenCalledWith(
      expect.objectContaining({ done: 1, total: 2, outcome: "cancelled" }),
    );
  });

  it("allows a failed cancellation to be retried", async () => {
    const run = vi.fn((_id: string) => new Promise<AiRunResult>(() => {}));
    const cancel = vi
      .fn()
      .mockRejectedValueOnce(new Error("Cancel unavailable"))
      .mockResolvedValueOnce(true);
    renderDialog({
      engine: CLOUD_ENGINE,
      onLiveRun: run,
      onCancelLiveRun: cancel,
    });
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel AI translation" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Cancel unavailable",
    );
    expect(screen.getByRole("img", { name: "In progress" })).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel AI translation" }),
    );
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it("still completes when progress events cannot be subscribed", async () => {
    eventApi.listen.mockRejectedValueOnce(new Error("No events"));
    const { onFinished } = renderDialog({ engine: CLOUD_ENGINE });
    await waitFor(() =>
      expect(onFinished).toHaveBeenCalledWith(
        expect.objectContaining({ done: 2, outcome: "complete" }),
      ),
    );
  });

  it("reports launch errors with their actual cause", async () => {
    const { onFinished, onClose } = renderDialog({
      engine: CLOUD_ENGINE,
      onLiveRun: vi.fn().mockRejectedValue(new Error("Local AI offline")),
    });
    await waitFor(() =>
      expect(onFinished).toHaveBeenCalledWith(
        expect.objectContaining({
          done: 0,
          total: 2,
          outcome: "error",
          error: "Error: Local AI offline",
        }),
      ),
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("removes the event listener on unmount", async () => {
    const run = vi.fn((_id: string) => new Promise<AiRunResult>(() => {}));
    const { unmount } = renderDialog({ engine: CLOUD_ENGINE, onLiveRun: run });
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    unmount();
    expect(unlistenProgress).toHaveBeenCalledOnce();
  });

  it.each(["complete", "cancelled", "error", "unmount"] as const)(
    "clears the Activity log's active steps on %s",
    async (outcome) => {
      let resolve!: (result: AiRunResult) => void;
      const run = vi.fn(
        (_id: string) =>
          new Promise<AiRunResult>((done) => {
            resolve = done;
          }),
      );
      const activity = vi.fn();
      window.addEventListener("translator-ai-activity", activity);
      try {
        const view = renderDialog({ engine: CLOUD_ENGINE, onLiveRun: run });
        await waitFor(() => expect(run).toHaveBeenCalledOnce());
        const runId = run.mock.calls[0][0];
        expect(activity.mock.calls.at(-1)?.[0].detail.activeSteps).toHaveLength(
          1,
        );
        if (outcome === "unmount") view.unmount();
        else
          await act(async () => {
            resolve(liveResult({ runId, outcome }));
          });
        expect(activity.mock.calls.at(-1)?.[0].detail).toMatchObject({
          runId,
          activeSteps: [],
        });
      } finally {
        window.removeEventListener("translator-ai-activity", activity);
      }
    },
  );
});
