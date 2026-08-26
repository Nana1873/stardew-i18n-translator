import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
        componentCount={2}
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
    expect(screen.getByText(/package with 2 components/)).toBeVisible();
    expect(screen.getByText(/Framework/)).toBeInTheDocument();
    expect(screen.getByText(/Component versions differ/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Choose save location …" }),
    ).toBeDisabled();
  });

  it("updates the safe filename when the package version is corrected", () => {
    const build = vi.fn();
    render(
      <TranslationZipDialog
        preview={PREVIEW}
        componentCount={2}
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
    fireEvent.click(
      screen.getByLabelText(
        /I verified the advertised package version 2\.1\/beta/,
      ),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Choose save location …" }),
    );
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
        componentCount={2}
        error={null}
        building={false}
        onInspect={inspect}
        onReleaseNotes={vi.fn()}
        onBuild={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Choose save location …" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Open issue" }));
    expect(inspect).toHaveBeenCalledWith(problem);
  });

  it("uses explicit close semantics and keeps Tab inside the ZIP preview", async () => {
    const onClose = vi.fn();
    const { container } = render(
      <TranslationZipDialog
        preview={PREVIEW}
        componentCount={2}
        error={null}
        building={false}
        onInspect={vi.fn()}
        onReleaseNotes={vi.fn()}
        onBuild={vi.fn()}
        onClose={onClose}
      />,
    );

    const first = screen.getByRole("button", { name: "Close ZIP preview" });
    await waitFor(() => expect(first).toHaveFocus());
    fireEvent.mouseDown(container.firstElementChild!);
    expect(onClose).not.toHaveBeenCalled();

    const last = screen.getByRole("button", { name: "Translation notes" });
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("freezes every close and navigation action while the ZIP build runs", () => {
    const onClose = vi.fn();
    render(
      <TranslationZipDialog
        preview={PREVIEW}
        componentCount={2}
        error={null}
        building
        onInspect={vi.fn()}
        onReleaseNotes={vi.fn()}
        onBuild={vi.fn()}
        onClose={onClose}
      />,
    );

    const dialog = screen.getByRole("dialog", {
      name: "Build translation ZIP",
    });
    expect(dialog).toHaveAttribute("aria-busy", "true");
    expect(
      screen.getByRole("button", { name: "Close ZIP preview" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Translation notes" }),
    ).toBeDisabled();
    expect(screen.getByLabelText("Package version")).toBeDisabled();
    expect(
      screen.getByLabelText(/I verified the advertised package version/),
    ).toBeDisabled();

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
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

  it("cancels the nested overwrite dialog on Escape", async () => {
    const cancel = vi.fn();
    render(
      <ZipOverwriteDialog
        fileName="translation.zip"
        onConfirm={vi.fn()}
        onCancel={cancel}
      />,
    );
    const close = screen.getByRole("button", { name: "Cancel ZIP overwrite" });
    await waitFor(() => expect(close).toHaveFocus());
    fireEvent.keyDown(close, { key: "Escape" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("isolates the underlying ZIP preview while overwrite confirmation is active", async () => {
    const zip = (
      <TranslationZipDialog
        preview={PREVIEW}
        componentCount={2}
        error={null}
        building={false}
        onInspect={vi.fn()}
        onReleaseNotes={vi.fn()}
        onBuild={vi.fn()}
        onClose={vi.fn()}
      />
    );
    const { rerender } = render(<div id="stardew-i18n-translator">{zip}</div>);
    expect(
      await screen.findByRole("dialog", { name: "Build translation ZIP" }),
    ).toBeVisible();

    rerender(
      <div id="stardew-i18n-translator">
        {zip}
        <ZipOverwriteDialog
          fileName="translation.zip"
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />
      </div>,
    );

    expect(
      await screen.findByRole("dialog", { name: "Confirm ZIP overwrite" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("dialog", { name: "Build translation ZIP" }),
    ).toBeNull();

    rerender(<div id="stardew-i18n-translator">{zip}</div>);
    expect(
      await screen.findByRole("dialog", { name: "Build translation ZIP" }),
    ).toBeVisible();
  });
});
