import { createRef } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, vi } from "vitest";
import {
  LLM_BATCH_HANDOFF_PROMPT,
  ResultTray,
  type ResultProblem,
  type ResultTrayData,
} from "./ResultTray";

const writeText = vi.fn();

beforeEach(() => {
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});

const problem: ResultProblem = {
  id: "a",
  modUniqueId: "a.b",
  modName: "Test Mod",
  relativeDir: "i18n",
  key: "greeting",
  reason: "Missing protected tokens",
  resolved: false,
};

const exportData: ResultTrayData = {
  kind: "export",
  title: "Test Mod",
  collapsed: false,
  pending: false,
  error: null,
  modsChanged: null,
  retry: { kind: "selected", modUniqueId: "a.b" },
  result: {
    files: [],
    skipped: [],
    filesWritten: 0,
    filesRemoved: 0,
    totalWrittenKeys: 0,
    totalUntranslated: 1,
    totalOutdated: 0,
    totalReviewNeeded: 0,
    totalOrphanKeys: 0,
    blocked: true,
  },
  problems: [problem],
};

function renderTray(
  data: ResultTrayData,
  overrides: Partial<React.ComponentProps<typeof ResultTray>> = {},
) {
  const props: React.ComponentProps<typeof ResultTray> = {
    data,
    onToggle: vi.fn(),
    onClose: vi.fn(),
    onInspect: vi.fn(),
    onRetry: vi.fn(),
    ...overrides,
  };
  return { ...render(<ResultTray {...props} />), props };
}

describe("ResultTray V3", () => {
  it("uses the accepted V3 shell and keeps every issue navigable", () => {
    const inspect = vi.fn();
    const close = vi.fn();
    const toggle = vi.fn();
    const { container } = renderTray(exportData, {
      onInspect: inspect,
      onClose: close,
      onToggle: toggle,
    });

    expect(
      screen.getByRole("complementary", {
        name: "Latest operation result",
      }),
    ).toHaveClass("stv3-result");
    expect(container.querySelector(".stv3-result-head")).not.toBeNull();
    expect(container.querySelector(".stv3-result-body")).not.toBeNull();
    expect(container.querySelector(".stv3-result-status")).toHaveClass(
      "is-error",
    );

    fireEvent.click(screen.getByRole("button", { name: /i18n \/ greeting/ }));
    expect(inspect).toHaveBeenCalledWith(problem);

    fireEvent.click(screen.getByRole("button", { name: "Collapse result" }));
    fireEvent.click(screen.getByRole("button", { name: "Hide result" }));
    expect(toggle).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("exposes the result toggle for shell focus restoration", () => {
    const toggleButtonRef = createRef<HTMLButtonElement>();
    renderTray(exportData, { toggleButtonRef });

    expect(toggleButtonRef.current).toBe(
      screen.getByRole("button", { name: "Collapse result" }),
    );
  });

  it("renders collapsed, pending, success, warning, and error states", () => {
    const pending: ResultTrayData = {
      ...exportData,
      collapsed: true,
      pending: true,
      result: null,
      problems: [],
    };
    const { container, rerender } = renderTray(pending);
    expect(screen.getByText("Exporting")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Expand result" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelector(".stv3-result-body")).toBeNull();
    expect(container.querySelector(".stv3-result-status")).toHaveClass(
      "is-pending",
    );

    const success: ResultTrayData = {
      kind: "zip",
      title: "Test.zip",
      collapsed: false,
      pending: false,
      error: null,
      outcome: {
        path: "C:/release/Test.zip",
        folder: "C:/release",
        fileName: "Test.zip",
        entries: 1,
        strings: 2,
      },
      problems: [],
    };
    rerender(
      <ResultTray
        data={success}
        onToggle={vi.fn()}
        onClose={vi.fn()}
        onInspect={vi.fn()}
      />,
    );
    expect(screen.getByText("ZIP created")).toBeInTheDocument();
    expect(container.querySelector(".stv3-result-status")).not.toHaveClass(
      "is-warning",
      "is-error",
      "is-pending",
    );

    const warning: ResultTrayData = {
      kind: "import",
      title: "Test Mod",
      collapsed: false,
      pending: false,
      error: null,
      sourcePath: "C:/in/result.json",
      summary: {
        imported: 2,
        skippedTranslated: 0,
        unmatched: 1,
        identicalToSource: 0,
        totalInFile: 3,
      },
      problems: [],
    };
    rerender(
      <ResultTray
        data={warning}
        onToggle={vi.fn()}
        onClose={vi.fn()}
        onInspect={vi.fn()}
      />,
    );
    expect(container.querySelector(".stv3-result-status")).toHaveClass(
      "is-warning",
    );

    rerender(
      <ResultTray
        data={{ ...warning, error: "Invalid JSON", summary: null }}
        onToggle={vi.fn()}
        onClose={vi.fn()}
        onInspect={vi.fn()}
      />,
    );
    expect(screen.getByText("LLM import rejected")).toBeInTheDocument();
    expect(container.querySelector(".stv3-result-status")).toHaveClass(
      "is-error",
    );
  });

  it("shows retry only for a failed or blocked operation", () => {
    const retry = vi.fn();
    const { rerender } = renderTray(exportData, { onRetry: retry });
    fireEvent.click(screen.getByRole("button", { name: "Export again" }));
    expect(retry).toHaveBeenCalledOnce();

    rerender(
      <ResultTray
        data={{
          ...exportData,
          problems: [{ ...problem, resolved: true }],
        }}
        onToggle={vi.fn()}
        onClose={vi.fn()}
        onInspect={vi.fn()}
        onRetry={retry}
      />,
    );
    expect(screen.getByText("Ready to export again")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export again" })).toBeEnabled();
  });

  it("shows real batch path and file name, handoff prompt, and workflow", async () => {
    const notify = vi.fn();
    renderTray(
      {
        kind: "batch-export",
        title: "Test Mod",
        collapsed: false,
        pending: false,
        error: null,
        outcome: {
          path: "C:/out/test.llm-batch.json",
          stringCount: 3,
        },
        problems: [],
      },
      { onNotify: notify },
    );

    expect(screen.getByText("LLM batch exported")).toBeInTheDocument();
    expect(screen.getByText("test.llm-batch.json")).toBeInTheDocument();
    expect(screen.getByText("C:/out/test.llm-batch.json")).toBeInTheDocument();
    expect(screen.getByText(LLM_BATCH_HANDOFF_PROMPT)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Show workflow"));
    expect(
      screen.getByText(
        "Upload the JSON file to an LLM that supports file uploads.",
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Copy prompt" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(LLM_BATCH_HANDOFF_PROMPT),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Handoff prompt copied.",
    );
    expect(notify).toHaveBeenCalledWith("Handoff prompt copied.");

    writeText.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Copy details" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(writeText.mock.calls[0][0]).toContain(LLM_BATCH_HANDOFF_PROMPT);
  });

  it.each([
    ["cancelled", "AI translation cancelled", "is-warning"],
    ["error", "AI translation failed", "is-error"],
  ] as const)(
    "shows an exact partial AI %s result with review and undo actions",
    (outcome, label, toneClass) => {
      const openReview = vi.fn();
      renderTray(
        {
          kind: "ai-batch",
          title: "Test Mod",
          collapsed: false,
          pending: false,
          error: null,
          problems: [],
          outcome,
          done: 2,
          total: 5,
          engine: "Local AI",
          undoAvailable: true,
        },
        { onOpenReview: openReview, onUndoBulk: vi.fn() },
      );

      expect(screen.getByText(label)).toBeInTheDocument();
      expect(
        screen.getByText(/2 completed Local AI suggestions/),
      ).toBeInTheDocument();
      expect(screen.getByText("2 saved · 3 not started.")).toBeInTheDocument();
      expect(document.querySelector(".stv3-result-status")).toHaveClass(
        toneClass,
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Open review queue" }),
      );
      expect(openReview).toHaveBeenCalledOnce();
      expect(
        screen.getByRole("button", { name: "Undo the latest batch edit" }),
      ).toBeInTheDocument();
    },
  );

  it("copies generic details assembled only from the current real result", async () => {
    renderTray({
      kind: "zip",
      title: "Test.zip",
      collapsed: false,
      pending: false,
      error: null,
      outcome: {
        path: "C:/release/Test.zip",
        folder: "C:/release",
        fileName: "Test.zip",
        entries: 3,
        strings: 804,
      },
      problems: [],
    });

    fireEvent.click(screen.getByRole("button", { name: "Copy details" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).toContain("ZIP created");
    expect(copied).toContain("Test.zip");
    expect(copied).toContain("C:/release/Test.zip");
    expect(copied).toContain("804 strings");
  });

  it("surfaces a real import source path and opens its folder and review queue", () => {
    const openFolder = vi.fn();
    const openReview = vi.fn();
    renderTray(
      {
        kind: "import",
        title: "Test Mod",
        collapsed: false,
        pending: false,
        error: null,
        sourcePath: "C:\\Temp\\Meadow.de.llm-result.json",
        sourceFileName: "Meadow.de.llm-result.json",
        summary: {
          imported: 18,
          skippedTranslated: 2,
          unmatched: 1,
          identicalToSource: 1,
          totalInFile: 21,
        },
        problems: [],
      },
      { onOpenFolder: openFolder, onOpenReview: openReview },
    );

    expect(screen.getByText("Meadow.de.llm-result.json")).toBeInTheDocument();
    expect(
      screen.getByText("C:\\Temp\\Meadow.de.llm-result.json"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/18 of 21 values saved to the review queue/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show source file" }));
    fireEvent.click(screen.getByRole("button", { name: "Open review queue" }));
    expect(openFolder).toHaveBeenCalledWith("C:\\Temp");
    expect(openReview).toHaveBeenCalledOnce();
  });

  it("offers a one-shot undo for the latest bulk result", async () => {
    const undo = vi.fn().mockResolvedValue(undefined);
    renderTray(
      {
        kind: "bulk",
        title: "Keep original",
        collapsed: false,
        pending: false,
        error: null,
        count: 4,
        undone: false,
        undoAvailable: true,
        problems: [],
      },
      { onUndoBulk: undo },
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Undo the latest batch edit",
      }),
    );
    await waitFor(() => expect(undo).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(
        screen.queryByRole("button", {
          name: "Undo the latest batch edit",
        }),
      ).toBeNull(),
    );
  });

  it("keeps ZIP follow-up actions in the accepted compact action style", () => {
    renderTray(
      {
        kind: "zip",
        title: "Test.zip",
        collapsed: false,
        pending: false,
        error: null,
        outcome: {
          path: "C:/release/Test.zip",
          folder: "C:/release",
          fileName: "Test.zip",
          entries: 1,
          strings: 2,
        },
        problems: [],
      },
      { onOpenFolder: vi.fn(), onReleaseNotes: vi.fn() },
    );
    expect(screen.getByRole("button", { name: "Show in folder" })).toHaveClass(
      "stv3-button",
      "stv3-button-quiet",
    );
    expect(
      screen.getByRole("button", { name: "Translation notes" }),
    ).toHaveClass("stv3-button", "stv3-button-quiet");
  });
});
