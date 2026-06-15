import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, vi } from "vitest";
import {
  LLM_BATCH_HANDOFF_PROMPT,
  ResultTray,
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

const exportData: ResultTrayData = {
  kind: "export",
  title: "Test Mod",
  collapsed: false,
  pending: false,
  error: null,
  modsWritten: null,
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
  problems: [
    {
      id: "a",
      modUniqueId: "a.b",
      modName: "Test Mod",
      relativeDir: "i18n",
      key: "greeting",
      reason: "Missing protected tokens",
      resolved: false,
    },
  ],
};

describe("ResultTray", () => {
  it("keeps the complete problem list navigable", () => {
    const inspect = vi.fn();
    render(
      <ResultTray
        data={exportData}
        onToggle={vi.fn()}
        onClose={vi.fn()}
        onInspect={inspect}
        onRetry={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /i18n \/ greeting/ }));
    expect(inspect).toHaveBeenCalledWith(exportData.problems[0]);
    expect(screen.getByText("1 open, 0 resolved")).toBeInTheDocument();
  });

  it("provides keyboard-accessible collapse and dismiss controls", () => {
    const toggle = vi.fn();
    const close = vi.fn();
    render(
      <ResultTray
        data={exportData}
        onToggle={toggle}
        onClose={close}
        onInspect={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Collapse result" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss result" }));
    expect(toggle).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("shows export again only after every blocking problem is resolved", () => {
    const retry = vi.fn();
    render(
      <ResultTray
        data={{
          ...exportData,
          problems: exportData.problems.map((problem) => ({
            ...problem,
            resolved: true,
          })),
        }}
        onToggle={vi.fn()}
        onClose={vi.fn()}
        onInspect={vi.fn()}
        onRetry={retry}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Export again" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(screen.getByText("0 open, 1 resolved")).toBeInTheDocument();
  });

  it("shows and copies the exact external batch handoff prompt", async () => {
    render(
      <ResultTray
        data={{
          kind: "batch-export",
          title: "Test Mod",
          collapsed: false,
          pending: false,
          error: null,
          outcome: {
            path: "C:/out/test.llm-batch.json",
            stringCount: 3,
            glossaryTerms: 2,
          },
          problems: [],
        }}
        onToggle={vi.fn()}
        onClose={vi.fn()}
        onInspect={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByText("Batch exported")).toBeInTheDocument();
    expect(screen.getByText("C:/out/test.llm-batch.json")).toBeInTheDocument();
    expect(screen.getByText(LLM_BATCH_HANDOFF_PROMPT)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Copy prompt" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(LLM_BATCH_HANDOFF_PROMPT),
    );
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("uses compact action styling for ZIP follow-up actions", () => {
    render(
      <ResultTray
        data={{
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
        }}
        onToggle={vi.fn()}
        onClose={vi.fn()}
        onInspect={vi.fn()}
        onRetry={vi.fn()}
        onOpenFolder={vi.fn()}
        onReleaseNotes={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Open folder" })).toHaveClass(
      "resulttray__action",
    );
    expect(screen.getByRole("button", { name: "Release notes" })).toHaveClass(
      "resulttray__action",
    );
  });
});
