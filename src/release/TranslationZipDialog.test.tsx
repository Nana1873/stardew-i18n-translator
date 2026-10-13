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
  it("keeps ZIP settings open while a folder is typed", () => {
    render(
      <TranslationZipDialog
        preview={{ ...PREVIEW, versionConflicts: [] }}
        error={null}
        building={false}
        onInspect={vi.fn()}
        onBuild={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const settings = screen
      .getByText("ZIP settings")
      .closest("details") as HTMLDetailsElement;
    expect(settings.open).toBe(false);
    // An empty folder needs attention and opens the settings; a valid one
    // must not close them again under the user's cursor.
    const folder = screen.getAllByRole("textbox").at(-1)!;
    fireEvent.change(folder, { target: { value: "" } });
    expect(settings.open).toBe(true);
    fireEvent.change(folder, { target: { value: "Fixed" } });
    expect(settings.open).toBe(true);
  });
  it("previews included paths, omissions and version conflicts", () => {
    render(
      <TranslationZipDialog
        preview={PREVIEW}
        error={null}
        building={false}
        onInspect={vi.fn()}
        onBuild={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("[CP] Sample/i18n/de.json")).toBeInTheDocument();
    const dialog = screen.getByRole("dialog", {
      name: "Export translations",
    });
    expect(dialog).toHaveTextContent(PREVIEW.packageName);
    // Named by its visible heading; focusable itself as the focus fallback.
    expect(dialog).toHaveAttribute("aria-labelledby", "translator-zip-title");
    expect(dialog).not.toHaveAttribute("aria-label");
    expect(dialog).toHaveAttribute("tabindex", "-1");
    expect(screen.getByText(/Framework/)).toBeInTheDocument();
    expect(screen.getByText(/Component versions differ/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save ZIP…" })).toBeDisabled();
  });

  it("shows regional file hints as plain information that blocks nothing", () => {
    const hint =
      "The original mod has its own Mods/Sample Pack/[CP] Sample/i18n/de-DE.json, which the game prefers over de.json. Tell players to delete it after installing this ZIP, for example on your mod page.";
    const { rerender } = render(
      <TranslationZipDialog
        preview={{
          ...PREVIEW,
          versionConflicts: [],
          warnings: [],
          regionalFileHints: [hint],
        }}
        error={null}
        building={false}
        onInspect={vi.fn()}
        onBuild={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const shown = screen.getByText(hint);
    expect(shown).toBeVisible();
    expect(shown.closest(".is-warning, .is-error")).toBeNull();
    expect(screen.getByRole("button", { name: "Save ZIP…" })).toBeEnabled();

    rerender(
      <TranslationZipDialog
        preview={{ ...PREVIEW, versionConflicts: [], warnings: [] }}
        error={null}
        building={false}
        onInspect={vi.fn()}
        onBuild={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByText(/The original mod has its own/)).toBeNull();
  });

  it("updates the safe filename when the package version is corrected", () => {
    const build = vi.fn();
    render(
      <TranslationZipDialog
        preview={PREVIEW}
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
        error={null}
        building={false}
        onInspect={vi.fn()}
        onBuild={build}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByText("Details", { selector: ".desktop-xd-section-title" }),
    );
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
        error={null}
        building={false}
        onInspect={vi.fn()}
        onBuild={build}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByText("Details", { selector: ".desktop-xd-section-title" }),
    );
    expect(
      container.querySelector(".desktop-xd-details code")?.textContent,
    ).toBe(" [CP] Sample/i18n/de.json");
    fireEvent.click(screen.getByRole("button", { name: "Save ZIP…" }));
    expect(build).toHaveBeenLastCalledWith(PREVIEW.defaultFileName, []);
    fireEvent.change(screen.getByLabelText("Install folder"), {
      target: { value: " Original Package\\[CP] Sample" },
    });
    expect(
      container.querySelector(".desktop-xd-details code")?.textContent,
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

  it("builds without the strings that stay English and links them", () => {
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
        preview={{ ...PREVIEW, versionConflicts: [], problems: [problem] }}
        error={null}
        building={false}
        onInspect={inspect}
        onBuild={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/1 string stays in English/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Save ZIP…" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Open hello" }));
    expect(inspect).toHaveBeenCalledWith(problem);
  });

  it("uses explicit close semantics and keeps Tab inside the ZIP preview", async () => {
    const onClose = vi.fn();
    const { container } = render(
      <TranslationZipDialog
        preview={PREVIEW}
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
        error={null}
        building
        onInspect={vi.fn()}
        onBuild={vi.fn()}
        onClose={onClose}
      />,
    );

    const dialog = screen.getByRole("dialog", {
      name: "Export translations",
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
