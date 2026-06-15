import { fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";
import {
  TranslationZipDialog,
  ZipOverwriteDialog,
} from "./TranslationZipDialog";
import type { ZipPreview } from "../tauri/commands";

const PREVIEW: ZipPreview = {
  packageName: "Sample Pack",
  selectedVersion: "2.0",
  versionSource: "[CP] Sample",
  versionConflicts: [{ modName: "[JA] Sample", version: "1.5" }],
  defaultFileName: "Sample Pack - 2.0 - German (de).zip",
  targetLang: "de",
  targetLanguage: "German",
  entries: [
    {
      modName: "[CP] Sample",
      modVersion: "2.0",
      archivePath: "Sample Pack/[CP] Sample/i18n/de.json",
      strings: 42,
      totalSourceStrings: 50,
      outdated: 1,
      reviewNeeded: 2,
    },
  ],
  omittedComponents: ["Framework"],
  warnings: ["[CP] Sample contains 1 outdated translation."],
  problems: [],
  totalStrings: 42,
  totalSourceStrings: 50,
};

describe("TranslationZipDialog", () => {
  it("previews included paths, omissions and version conflicts", () => {
    render(
      <TranslationZipDialog
        preview={PREVIEW}
        error={null}
        building={false}
        onInspect={vi.fn()}
        onReleaseNotes={vi.fn()}
        onBuild={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(
      screen.getByText("Sample Pack/[CP] Sample/i18n/de.json"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Framework/)).toBeInTheDocument();
    expect(screen.getByText(/Component versions differ/)).toBeInTheDocument();
  });

  it("updates the safe filename when the package version is corrected", () => {
    const build = vi.fn();
    render(
      <TranslationZipDialog
        preview={PREVIEW}
        error={null}
        building={false}
        onInspect={vi.fn()}
        onReleaseNotes={vi.fn()}
        onBuild={build}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Package version"), {
      target: { value: "2.1/beta" },
    });
    expect(screen.getByLabelText("Archive name")).toHaveValue(
      "Sample Pack - 2.1_beta - German (de).zip",
    );
    fireEvent.click(screen.getByRole("button", { name: "Choose location..." }));
    expect(build).toHaveBeenCalledWith(
      "2.1/beta",
      "Sample Pack - 2.1_beta - German (de).zip",
    );
  });

  it("blocks creation and links validation problems", () => {
    const inspect = vi.fn();
    const problem = {
      modUniqueId: "sample.cp",
      modName: "[CP] Sample",
      relativeDir: "i18n",
      key: "hello",
      reason: "token count mismatch",
    };
    render(
      <TranslationZipDialog
        preview={{ ...PREVIEW, problems: [problem] }}
        error={null}
        building={false}
        onInspect={inspect}
        onReleaseNotes={vi.fn()}
        onBuild={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Choose location..." }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /hello/ }));
    expect(inspect).toHaveBeenCalledWith(problem);
  });
});

describe("ZipOverwriteDialog", () => {
  it("requires an explicit replacement action", () => {
    const confirm = vi.fn();
    render(
      <ZipOverwriteDialog
        fileName="translation.zip"
        onConfirm={confirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Replace ZIP" }));
    expect(confirm).toHaveBeenCalledOnce();
  });
});
