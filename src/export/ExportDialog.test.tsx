import { render, screen, fireEvent } from "@testing-library/react";
import { ExportDialog } from "./ExportDialog";
import type { ExportResult } from "../tauri/commands";

const RESULT: ExportResult = {
  files: [
    {
      relativeDir: "i18n",
      targetPath: "x/i18n/de.json",
      written: true,
      removed: false,
      backedUp: true,
      writtenKeys: 3,
      untranslated: 1,
      outdated: 1,
      reviewNeeded: 1,
      orphanKeys: ["legacy.key"],
    },
  ],
  skipped: [
    { relativeDir: "i18n", key: "bad", reason: "missing required token(s)" },
  ],
  filesWritten: 1,
  filesRemoved: 0,
  totalWrittenKeys: 3,
  totalUntranslated: 1,
  totalOutdated: 1,
  totalReviewNeeded: 1,
  totalOrphanKeys: 1,
  blocked: false,
};

describe("ExportDialog", () => {
  it("summarizes written keys, omissions, outdated and skipped", () => {
    render(
      <ExportDialog
        modName="Test Mod"
        result={RESULT}
        error={null}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("Export complete")).toBeInTheDocument();
    expect(screen.getByText(/Untranslated/)).toBeInTheDocument();
    expect(screen.getByText(/Outdated/)).toBeInTheDocument();
    expect(screen.getByText(/Needs review/)).toBeInTheDocument();
    // Skipped key is listed with its name.
    expect(screen.getByText("bad")).toBeInTheDocument();
    // Orphan key (dropped from the existing file) is reported by name.
    expect(
      screen.getByText(/Removed \(key no longer in default\.json/),
    ).toBeInTheDocument();
    expect(screen.getByText("legacy.key")).toBeInTheDocument();
    // Backup note appears because a file was backed up.
    expect(screen.getByText(/backed up/)).toBeInTheDocument();
  });

  it("shows the failure message on error", () => {
    render(
      <ExportDialog
        modName="Test Mod"
        result={null}
        error="disk full"
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("Export failed")).toBeInTheDocument();
    expect(screen.getByText("disk full")).toBeInTheDocument();
  });

  it("explains when token errors block the mod export", () => {
    render(
      <ExportDialog
        modName="Test Mod"
        result={{
          ...RESULT,
          files: [],
          filesWritten: 0,
          totalWrittenKeys: 0,
          blocked: true,
        }}
        error={null}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("Export blocked")).toBeInTheDocument();
    expect(
      screen.getByText(/No files or backups were written/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Blocking token errors/)).toBeInTheDocument();
  });

  it("reports the mod count for an export-all run", () => {
    const { container } = render(
      <ExportDialog
        modName="All mods"
        modsWritten={3}
        result={RESULT}
        error={null}
        onClose={() => {}}
      />,
    );
    const summary =
      container.querySelector(".exportdlg__body p")?.textContent ?? "";
    expect(summary).toContain("in");
    expect(summary).toContain("3 mods");
  });

  it("calls onClose when Close is clicked", () => {
    const onClose = vi.fn();
    render(
      <ExportDialog
        modName="Test Mod"
        result={RESULT}
        error={null}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("opens a skipped key from both the count and key links", () => {
    const onInspectSkip = vi.fn();
    render(
      <ExportDialog
        modName="Test Mod"
        result={RESULT}
        error={null}
        onInspectSkip={onInspectSkip}
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "1" }));
    fireEvent.click(screen.getByRole("button", { name: "bad" }));

    expect(onInspectSkip).toHaveBeenNthCalledWith(1, RESULT.skipped[0]);
    expect(onInspectSkip).toHaveBeenNthCalledWith(2, RESULT.skipped[0]);
  });
});
