import { render, screen, fireEvent } from "@testing-library/react";
import { vi } from "vitest";
import { LlmExportDialog, LlmImportDialog } from "./LlmBatchDialog";

describe("LlmExportDialog", () => {
  it("shows the written path and complete external LLM workflow", () => {
    render(
      <LlmExportDialog
        outcome={{
          path: "C:/batches/my.mod.llm-batch.json",
          stringCount: 12,
          glossaryTerms: 3,
        }}
        error={null}
        modName="My Mod"
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("Batch exported")).toBeInTheDocument();
    expect(
      screen.getByText("C:/batches/my.mod.llm-batch.json"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Open ChatGPT, Claude, Gemini/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Follow the "instructions"/)).toBeInTheDocument();
    expect(screen.getByText(/drop it onto the app/)).toBeInTheDocument();
    expect(screen.getByText(/Import batch…/)).toBeInTheDocument();
    expect(screen.getByText(/Needs review/)).toBeInTheDocument();
  });

  it("shows the failure message on error", () => {
    render(
      <LlmExportDialog
        outcome={null}
        error="disk full"
        modName="My Mod"
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("Batch export failed")).toBeInTheDocument();
    expect(screen.getByText("disk full")).toBeInTheDocument();
  });
});

describe("LlmImportDialog", () => {
  it("summarizes imported, protected, unmatched and flagged strings", () => {
    const onClose = vi.fn();
    render(
      <LlmImportDialog
        summary={{
          imported: 5,
          skippedTranslated: 2,
          unmatched: 1,
          tokenIssues: 1,
          tokenIssueKeys: ["FestivalToday"],
          identicalToSource: 1,
          totalInFile: 8,
        }}
        error={null}
        modName="My Mod"
        onClose={onClose}
      />,
    );
    expect(screen.getByText("Batch imported")).toBeInTheDocument();
    expect(screen.getByText(/Needs\s*review/)).toBeInTheDocument();
    expect(screen.getByText(/already translated locally/)).toBeInTheDocument();
    expect(screen.getByText(/Unmatched/)).toBeInTheDocument();
    expect(screen.getByText(/Missing protected tokens/)).toBeInTheDocument();
    expect(
      screen.getByText(/Identical to the English source/),
    ).toBeInTheDocument();
    // The affected key is named so the user can search/jump to it.
    expect(screen.getByText("FestivalToday")).toBeInTheDocument();
    expect(
      screen.getByText(/paste one into the search box/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the failure message on error", () => {
    render(
      <LlmImportDialog
        summary={null}
        error="Not an LLM batch/result file"
        modName="My Mod"
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("Batch import failed")).toBeInTheDocument();
    expect(
      screen.getByText(/Not an LLM batch\/result file/),
    ).toBeInTheDocument();
  });
});
