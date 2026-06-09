import { render, screen, fireEvent } from "@testing-library/react";
import { ExportDialog } from "./ExportDialog";
import type { ExportResult } from "../tauri/commands";

const RESULT: ExportResult = {
  files: [
    {
      relativeDir: "i18n",
      targetPath: "x/i18n/de.json",
      written: true,
      backedUp: true,
      writtenKeys: 3,
      untranslated: 1,
      notTranslatable: 1,
      outdated: 1,
    },
  ],
  skipped: [{ relativeDir: "i18n", key: "bad", reason: "missing required token(s)" }],
  filesWritten: 1,
  totalWrittenKeys: 3,
  totalUntranslated: 1,
  totalNotTranslatable: 1,
  totalOutdated: 1,
};

describe("ExportDialog", () => {
  it("summarizes written keys, omissions, outdated and skipped", () => {
    render(<ExportDialog modName="Test Mod" result={RESULT} error={null} onClose={() => {}} />);

    expect(screen.getByText("Export complete")).toBeInTheDocument();
    expect(screen.getByText(/Untranslated/)).toBeInTheDocument();
    expect(screen.getByText(/Not\s*translatable/)).toBeInTheDocument();
    expect(screen.getByText(/Outdated/)).toBeInTheDocument();
    // Skipped key is listed with its name.
    expect(screen.getByText("bad")).toBeInTheDocument();
    // Backup note appears because a file was backed up.
    expect(screen.getByText(/backed up/)).toBeInTheDocument();
  });

  it("shows the failure message on error", () => {
    render(
      <ExportDialog modName="Test Mod" result={null} error="disk full" onClose={() => {}} />,
    );
    expect(screen.getByText("Export failed")).toBeInTheDocument();
    expect(screen.getByText("disk full")).toBeInTheDocument();
  });

  it("calls onClose when Close is clicked", () => {
    const onClose = vi.fn();
    render(<ExportDialog modName="Test Mod" result={RESULT} error={null} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });
});
