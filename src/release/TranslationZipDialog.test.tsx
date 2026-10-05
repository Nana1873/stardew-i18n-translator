import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { TranslationZipDialog } from "./TranslationZipDialog";
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
      modUniqueId: "[CP] Sample",
      installFolder: "[CP] Sample",
      archivePath: "[CP] Sample/i18n/de.json",
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
        onBuild={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("[CP] Sample/i18n/de.json")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveTextContent(PREVIEW.packageName);
    expect(screen.getByText(/Framework/)).toBeInTheDocument();
    expect(screen.getByText(/Component versions differ/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save ZIP…" })).toBeDisabled();
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
        onBuild={build}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Version"), {
      target: { value: "2.1/beta" },
    });
    expect(screen.getByLabelText("ZIP file")).toHaveTextContent(
      "Sample Pack - 2.1_beta - German (de).zip",
    );
    fireEvent.click(
      screen.getByLabelText(
        /I verified the advertised package version 2\.1\/beta/,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save ZIP…" }));
    expect(build).toHaveBeenCalledWith(
      "Sample Pack - 2.1_beta - German (de).zip",
      [],
    );
  });

  it("previews edited install paths and passes folder overrides to the build", () => {
    const build = vi.fn();
    render(
      <TranslationZipDialog
        preview={{ ...PREVIEW, versionConflicts: [] }}
        componentCount={1}
        error={null}
        building={false}
        onInspect={vi.fn()}
        onBuild={build}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Details", { selector: "summary" }));
    fireEvent.change(screen.getByLabelText("Install folder"), {
      target: { value: "Original Package/[CP] Sample" },
    });
    expect(
      screen.getByText("Original Package/[CP] Sample/i18n/de.json"),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Save ZIP…" }));
    expect(build).toHaveBeenCalledWith(PREVIEW.defaultFileName, [
      { modUniqueId: "[CP] Sample", folder: "Original Package/[CP] Sample" },
    ]);
  });

  it("preserves valid leading spaces in default and edited install paths", () => {
    const build = vi.fn();
    const { container } = render(
      <TranslationZipDialog
        preview={{
          ...PREVIEW,
          versionConflicts: [],
          entries: [
            {
              ...PREVIEW.entries[0],
              installFolder: " [CP] Sample",
              archivePath: " [CP] Sample/i18n/de.json",
            },
          ],
        }}
        componentCount={1}
        error={null}
        building={false}
        onInspect={vi.fn()}
        onBuild={build}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Details", { selector: "summary" }));
    expect(
      container.querySelector(".desktop-zip-files code")?.textContent,
    ).toBe(" [CP] Sample/i18n/de.json");
    fireEvent.click(screen.getByRole("button", { name: "Save ZIP…" }));
    expect(build).toHaveBeenLastCalledWith(PREVIEW.defaultFileName, []);
    fireEvent.change(screen.getByLabelText("Install folder"), {
      target: { value: " Original Package\\[CP] Sample" },
    });
    expect(
      container.querySelector(".desktop-zip-files code")?.textContent,
    ).toBe(" Original Package/[CP] Sample/i18n/de.json");
    fireEvent.click(screen.getByRole("button", { name: "Save ZIP…" }));
    expect(build).toHaveBeenLastCalledWith(PREVIEW.defaultFileName, [
      { modUniqueId: "[CP] Sample", folder: " Original Package/[CP] Sample" },
    ]);
  });

  it("blocks ambiguous and escaping install folders until corrected", () => {
    render(
      <TranslationZipDialog
        preview={{
          ...PREVIEW,
          versionConflicts: [],
          entries: [
            ...PREVIEW.entries,
            {
              ...PREVIEW.entries[0],
              modUniqueId: "Other.Mod",
              modName: "Other mod",
            },
          ],
        }}
        combined
        componentCount={2}
        error={null}
        building={false}
        onInspect={vi.fn()}
        onBuild={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const build = screen.getByRole("button", {
      name: "Save ZIP…",
    });
    expect(build).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "same installation folder",
    );
    fireEvent.change(screen.getByLabelText("Other mod"), {
      target: { value: "../escape" },
    });
    expect(build).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Other mod"), {
      target: { value: "Other mod" },
    });
    expect(build).toBeEnabled();
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
        onBuild={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Save ZIP…" })).toBeDisabled();
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
        onBuild={vi.fn()}
        onClose={onClose}
      />,
    );

    const first = screen.getByRole("button", { name: "Close ZIP preview" });
    await waitFor(() => expect(first).toHaveFocus());
    fireEvent.mouseDown(container.firstElementChild!);
    expect(onClose).not.toHaveBeenCalled();

    const last = screen.getByRole("button", { name: "Cancel" });
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
        onBuild={vi.fn()}
        onClose={onClose}
      />,
    );

    const dialog = screen.getByRole("dialog", {
      name: "Export translation ZIP",
    });
    expect(dialog).toHaveAttribute("aria-busy", "true");
    expect(
      screen.getByRole("button", { name: "Close ZIP preview" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByLabelText("Version")).toBeDisabled();
    expect(
      screen.getByLabelText(/I verified the advertised package version/),
    ).toBeDisabled();

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
