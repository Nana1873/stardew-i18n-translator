import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ZipPreview } from "../tauri/commands";
import { ReleaseNotesDialog } from "./ReleaseNotesDialog";

const writeText = vi.fn();

const PREVIEW: ZipPreview = {
  packageName: "Sample Pack",
  selectedVersion: "2.0",
  versionSource: "[CP] Sample",
  versionConflicts: [],
  defaultFileName: "Sample Pack - 2.0 - German (de).zip",
  targetLang: "de",
  targetLanguage: "German",
  entries: [
    {
      modName: "[CP] Sample",
      modVersion: "2.0",
      archivePath: "Sample Pack/[CP] Sample/i18n/de.json",
      strings: 75,
      totalSourceStrings: 100,
      outdated: 2,
      reviewNeeded: 3,
    },
  ],
  omittedComponents: [],
  warnings: [],
  problems: [],
  totalStrings: 75,
  totalSourceStrings: 100,
};

beforeEach(() => {
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});

describe("ReleaseNotesDialog", () => {
  it("shows a read-only localized preview and switches to English", () => {
    render(
      <ReleaseNotesDialog
        preview={PREVIEW}
        error={null}
        initialVersion="2.0"
        archiveFileName={PREVIEW.defaultFileName}
        onInspect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const preview = screen.getByLabelText("Generated release notes");
    expect(preview).toHaveAttribute("readonly");
    expect((preview as HTMLTextAreaElement).value).toContain("Übersetzung");
    fireEvent.change(screen.getByLabelText("Draft language"), {
      target: { value: "en" },
    });
    expect((preview as HTMLTextAreaElement).value).toContain(
      "German translation for Sample Pack 2.0",
    );
    expect((preview as HTMLTextAreaElement).value).toContain(
      PREVIEW.defaultFileName,
    );
  });

  it("copies the generated text", async () => {
    render(
      <ReleaseNotesDialog
        preview={PREVIEW}
        error={null}
        initialVersion="2.0"
        archiveFileName={PREVIEW.defaultFileName}
        onInspect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy to clipboard" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(writeText.mock.calls[0][0]).toContain("Sample Pack");
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("requires explicit version confirmation when components disagree", () => {
    render(
      <ReleaseNotesDialog
        preview={{
          ...PREVIEW,
          versionConflicts: [{ modName: "[JA] Sample", version: "1.5" }],
        }}
        error={null}
        initialVersion="2.1"
        archiveFileName="Sample Pack - 2.1 - German (de).zip"
        onInspect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const copy = screen.getByRole("button", { name: "Copy to clipboard" });
    expect(copy).toBeDisabled();
    fireEvent.click(
      screen.getByLabelText(
        "I confirmed the advertised package version above.",
      ),
    );
    expect(copy).toBeEnabled();
  });

  it("marks blocking problems and opens the affected string", () => {
    const inspect = vi.fn();
    const problem = {
      modUniqueId: "sample.cp",
      modName: "[CP] Sample",
      relativeDir: "i18n",
      key: "broken.key",
      reason: "token count mismatch",
    };
    render(
      <ReleaseNotesDialog
        preview={{ ...PREVIEW, problems: [problem] }}
        error={null}
        initialVersion="2.0"
        archiveFileName={null}
        onInspect={inspect}
        onClose={vi.fn()}
      />,
    );
    expect(
      (screen.getByLabelText("Generated release notes") as HTMLTextAreaElement)
        .value,
    ).toContain("Nicht veröffentlichungsbereit");
    fireEvent.click(screen.getByRole("button", { name: /broken\.key/ }));
    expect(inspect).toHaveBeenCalledWith(problem);
  });
});
