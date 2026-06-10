import { render, screen, fireEvent } from "@testing-library/react";
import { vi } from "vitest";
import { ClaudeExportDialog, ClaudeImportDialog } from "./ClaudeBatchDialog";

describe("ClaudeExportDialog", () => {
  it("shows the written path and the import hint", () => {
    render(
      <ClaudeExportDialog
        outcome={{
          path: "C:/batches/my.mod.claude-batch.json",
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
      screen.getByText("C:/batches/my.mod.claude-batch.json"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Import batch…/)).toBeInTheDocument();
  });

  it("shows the failure message on error", () => {
    render(
      <ClaudeExportDialog
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

describe("ClaudeImportDialog", () => {
  it("summarizes imported, protected, unmatched and flagged strings", () => {
    const onClose = vi.fn();
    render(
      <ClaudeImportDialog
        summary={{
          imported: 5,
          skippedTranslated: 2,
          unmatched: 1,
          tokenIssues: 1,
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

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the failure message on error", () => {
    render(
      <ClaudeImportDialog
        summary={null}
        error="Not a Claude-Code batch/result file"
        modName="My Mod"
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("Batch import failed")).toBeInTheDocument();
    expect(
      screen.getByText(/Not a Claude-Code batch\/result file/),
    ).toBeInTheDocument();
  });
});
