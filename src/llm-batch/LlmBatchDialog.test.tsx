import { render, screen } from "@testing-library/react";
import { LlmExportDialog } from "./LlmBatchDialog";

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
