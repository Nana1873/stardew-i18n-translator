import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { ScanDialog, scanAttentionCount } from "./ScanDialog";
import type { ScanResult } from "../tauri/commands";

const RESULT: ScanResult = {
  mods: [],
  warnings: ["Source comparison is unavailable for this scan."],
  skippedComponents: [
    {
      packageId: "Sample Pack",
      componentUniqueId: "sample.broken",
      componentName: "Broken Component",
      relativeLocation: "Sample/Broken/manifest.json",
      reason: "invalid manifest JSON",
      requiresAttention: true,
      restOfPackageLoaded: true,
    },
  ],
  extraKeys: [],
  modCount: 12,
  fileCount: 18,
  sourceDeltas: {
    sourcesChanged: 2,
    stringsAdded: 3,
    stringsRemoved: 1,
    addedStrings: [
      { modUniqueId: "sample.mod", relativeDir: "i18n", key: "new.key" },
    ],
    changedSources: [
      {
        modUniqueId: "sample.mod",
        relativeDir: "i18n",
        key: "changed.key",
      },
    ],
  },
};

describe("ScanDialog", () => {
  it("shows a spinner and focuses the dialog while scanning", async () => {
    render(
      <ScanDialog scanning result={null} error={null} onClose={() => {}} />,
    );
    const dialog = screen.getByRole("dialog", { name: /scan/i });
    expect(dialog).toHaveAccessibleName("Scanning mods…");
    expect(dialog).toHaveAttribute("tabindex", "-1");
    await waitFor(() => expect(dialog).toHaveFocus());
    expect(screen.getByText("Scanning mods…")).toBeInTheDocument();
    expect(screen.getByText(/Reading your mods/)).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuetext",
      "Scanning",
    );
    // The dialog retains its action row but cannot close mid-scan.
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
  });

  it("summarises skipped components and warnings in plain language", () => {
    render(
      <ScanDialog
        scanning={false}
        result={RESULT}
        error={null}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("Scan results")).toBeInTheDocument();
    expect(screen.getByText("2 items need a look")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Read 12 mods with 18 translation files. Your saved work is safe.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Since your last scan: 3 new and 2 changed texts to translate.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Change comparison")).toBeInTheDocument();
    expect(screen.getByText("Broken Component")).toBeInTheDocument();
    expect(
      screen.getByText(
        /Its manifest.json could not be read, so it was left out\./,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/The rest of this mod was loaded\./),
    ).toBeInTheDocument();
    // The technical reason and location stay folded under Details.
    expect(screen.getByText("invalid manifest JSON")).not.toBeVisible();
    fireEvent.click(screen.getByText("Details"));
    expect(screen.getByText("invalid manifest JSON")).toBeVisible();
    expect(screen.getByText("Sample/Broken/manifest.json")).toBeVisible();
    expect(
      screen.getByText("Source comparison is unavailable for this scan."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Unavailable")).toBeNull();
  });

  it("uses singular wording for a one-mod scan", () => {
    const singleResult: ScanResult = {
      ...RESULT,
      modCount: 1,
      fileCount: 1,
      warnings: [],
      skippedComponents: [],
      sourceDeltas: {
        sourcesChanged: 1,
        stringsAdded: 1,
        stringsRemoved: 0,
        addedStrings: RESULT.sourceDeltas!.addedStrings,
        changedSources: RESULT.sourceDeltas!.changedSources,
      },
    };

    render(
      <ScanDialog
        scanning={false}
        result={singleResult}
        error={null}
        onOpenAddedStrings={vi.fn()}
        onReviewChangedSources={vi.fn()}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("Everything is ready")).toBeInTheDocument();
    expect(
      screen.getByText("Read 1 mod with 1 translation file."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Since your last scan: 1 new and 1 changed texts to translate.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show new strings (1)" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Show changed strings (1)" }),
    ).toBeEnabled();
    expect(document.querySelector(".translator-sr-only")).toHaveTextContent(
      "Scan complete. 1 mod and 1 translation file found. Everything is ready.",
    );
  });

  it("counts only real problems and tolerates a missing skip list", () => {
    const { rerender } = render(
      <ScanDialog
        scanning={false}
        result={{ ...RESULT, skippedComponents: [] }}
        error={null}
        onClose={() => {}}
      />,
    );
    expect(screen.getAllByText(/1 item needs a look/)[0]).toBeInTheDocument();

    rerender(
      <ScanDialog
        scanning={false}
        result={{ ...RESULT, skippedComponents: undefined, sourceDeltas: null }}
        error={null}
        onClose={() => {}}
      />,
    );
    expect(screen.getAllByText(/1 item needs a look/)[0]).toBeInTheDocument();
    // Without a comparison the line says when changes are listed again.
    expect(
      screen.getByText(
        "New and changed texts are listed again once the problems below are fixed.",
      ),
    ).toBeInTheDocument();
  });

  it("focuses the real diagnostic block when opened from the skipped control", async () => {
    render(
      <ScanDialog
        scanning={false}
        result={RESULT}
        error={null}
        focusDiagnostics
        onClose={() => {}}
      />,
    );

    const diagnostics = document.querySelector("[data-scan-diagnostics]");
    await waitFor(() => expect(diagnostics).toHaveFocus());
  });

  it("distinguishes a retained scan result from a newly completed scan", () => {
    render(
      <ScanDialog
        scanning={false}
        result={RESULT}
        error={null}
        retainedResult
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("Latest scan")).toBeInTheDocument();
    expect(screen.queryByText("Scan results")).toBeNull();
  });

  it("labels a missing scan result as unavailable instead of retained", () => {
    render(
      <ScanDialog
        scanning={false}
        result={null}
        error={null}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("No scan yet")).toBeInTheDocument();
    expect(
      screen.getByText("No scan result yet. Click Scan to read your mods."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Latest scan")).toBeNull();
  });

  it("shows the error message on failure", () => {
    render(
      <ScanDialog
        scanning={false}
        result={null}
        error="Mods folder not found"
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("Scan failed")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Mods folder not found",
    );
  });

  it("explains target-language entries without matching source strings", () => {
    render(
      <ScanDialog
        scanning={false}
        result={{
          ...RESULT,
          warnings: [],
          skippedComponents: [],
          extraKeys: [
            {
              modName: "Example Mod",
              relativeDir: "i18n",
              targetPath: "E:/Mods/Example/i18n/de.json",
              key: "removed-key",
            },
          ],
        }}
        error={null}
        onClose={() => {}}
      />,
    );
    expect(
      screen.getByText(/1 translation entry without matching English source/),
    ).toBeInTheDocument();
    expect(screen.getByText("Example Mod")).toBeInTheDocument();
    expect(screen.getByText("i18n/de.json")).toBeInTheDocument();
    expect(
      screen.getByText("E:/Mods/Example/i18n/de.json"),
    ).toBeInTheDocument();
    expect(screen.getByText("Not found in English source")).toBeInTheDocument();
    expect(screen.getByText("removed-key")).toBeInTheDocument();
    expect(
      screen.getByText(/no longer in the English text, so export leaves/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/SMAPI ignores them/)).toBeNull();
    expect(
      screen.getByText(/don't count toward progress/i),
    ).toBeInTheDocument();
    const information = screen
      .getByText(/1 translation entry without matching English source/)
      .closest("details");
    expect(information).not.toHaveAttribute("open");
    expect(screen.getByText("removed-key")).not.toBeVisible();
    fireEvent.click(
      screen.getByText(/1 translation entry without matching English source/),
    );
    fireEvent.click(screen.getByText("i18n/de.json"));
    expect(screen.getByText("removed-key")).toBeVisible();
    expect(
      screen.getByText(/A folder export keeps the old file in a backup/),
    ).toBeInTheDocument();
    expect(document.querySelector("[data-scan-diagnostics]")).toBeNull();
  });

  it("retains warning tone when information accompanies a skipped component", () => {
    render(
      <ScanDialog
        scanning={false}
        result={{
          ...RESULT,
          warnings: [],
          extraKeys: [
            {
              modName: "Example Mod",
              relativeDir: "i18n",
              targetPath: "E:/Mods/Example/i18n/de.json",
              key: "removed-key",
            },
          ],
        }}
        error={null}
        onClose={() => {}}
      />,
    );

    const diagnostics = document.querySelector("[data-scan-diagnostics]");
    expect(diagnostics).toHaveClass("is-warning");
    expect(diagnostics).toHaveTextContent("Broken Component");
    const summary = screen.getByText(
      /1 translation entry without matching English source/,
    );
    expect(diagnostics).not.toContainElement(summary);
    expect(summary.closest("details")).not.toHaveAttribute("open");
  });

  it("groups many unmatched entries by translation file and keeps them collapsed", () => {
    render(
      <ScanDialog
        scanning={false}
        result={{
          ...RESULT,
          warnings: [],
          skippedComponents: [],
          extraKeys: ["one", "two", "three", "four"].map((key) => ({
            modName: "Example Mod",
            relativeDir: "i18n",
            targetPath: "E:/Mods/Example/i18n/de.json",
            key,
          })),
        }}
        error={null}
        onClose={() => {}}
      />,
    );

    expect(screen.getAllByText("Example Mod")).toHaveLength(1);
    const fileLabel = screen.getByText("i18n/de.json");
    expect(screen.getByText("4 entries")).toBeInTheDocument();
    expect(fileLabel.closest("details")).not.toHaveAttribute("open");
    expect(screen.getAllByText("E:/Mods/Example/i18n/de.json")).toHaveLength(1);
    for (const key of ["one", "two", "three", "four"]) {
      expect(screen.getByText(key)).toBeInTheDocument();
    }
  });

  it("names an i18n folder without a manifest instead of calling it a language pack", () => {
    render(
      <ScanDialog
        scanning={false}
        result={{
          ...RESULT,
          warnings: [],
          skippedComponents: [
            {
              packageId: null,
              componentUniqueId: null,
              componentName: null,
              relativeLocation: "Loose/i18n",
              reason:
                "No manifest.json in this folder or a parent folder, so SMAPI does not load these translations.",
              requiresAttention: false,
              restOfPackageLoaded: false,
            },
          ],
        }}
        error={null}
        onClose={() => {}}
      />,
    );

    expect(
      screen.getAllByText(
        /1 translation folder the game doesn't use was ignored/,
      )[0],
    ).toBeInTheDocument();
    expect(screen.queryByText(/community language pack/)).toBeNull();
    expect(screen.getByText("Loose/i18n")).toBeInTheDocument();
  });

  it("counts a mod folder the game doesn't load apart from translation folders", () => {
    const unowned = (relativeLocation: string, reason: string) => ({
      packageId: null,
      componentUniqueId: null,
      componentName: null,
      relativeLocation,
      reason,
      requiresAttention: false,
      restOfPackageLoaded: false,
    });
    render(
      <ScanDialog
        scanning={false}
        result={{
          ...RESULT,
          warnings: [],
          skippedComponents: [
            unowned(
              "Pkg/[CP] X/manifest.json",
              "Mods/Pkg/[CP] X has a manifest.json, but the game doesn't load it because Mods/Pkg already contains other files.",
            ),
            unowned(
              "Mod/optional/Manifest.json",
              "This manifest.json is inside another mod that has its own manifest.json, so the game does not load it.",
            ),
            unowned(
              "Loose/i18n",
              "No manifest.json in this folder or a parent folder, so SMAPI does not load these translations.",
            ),
          ],
        }}
        error={null}
        onClose={() => {}}
      />,
    );

    expect(
      screen.getAllByText(
        /2 mod folders the game doesn't load and 1 translation folder the game doesn't use were ignored/,
      )[0],
    ).toBeInTheDocument();
    expect(screen.getByText("Pkg/[CP] X/manifest.json")).toBeInTheDocument();
  });

  it("shows a duplicate mod ID as one card that names both folders", () => {
    const duplicateSkip = (folder: string) => ({
      packageId: folder,
      componentUniqueId: "Example.Same",
      componentName: "Example",
      relativeLocation: `${folder}/i18n/default.json`,
      reason:
        "Your saved translations for this mod could not be loaded, so it was left out.",
      requiresAttention: true,
      restOfPackageLoaded: false,
    });
    render(
      <ScanDialog
        scanning={false}
        result={{
          ...RESULT,
          warnings: [
            "2 installed mods have the same ID (Example.Same), so their translations were left out. Usually one folder is an old or duplicate copy; delete it or move it out of the Mods folder.",
          ],
          skippedComponents: [
            duplicateSkip("Example"),
            duplicateSkip("Example - Copy"),
          ],
        }}
        error={null}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("1 item needs a look")).toBeInTheDocument();
    expect(
      screen.getAllByRole("listitem", { name: undefined }).length,
    ).toBeGreaterThan(0);
    const affected = screen.getByRole("list", { name: "Affected mods" });
    expect(affected).toHaveTextContent("Mods/Example");
    expect(affected).toHaveTextContent("Mods/Example - Copy");
    expect(
      screen.queryByText(/saved translations could not be loaded/),
    ).toBeNull();
  });

  it("folds an expected language-pack exclusion into one quiet line", () => {
    render(
      <ScanDialog
        scanning={false}
        result={{
          ...RESULT,
          warnings: [],
          skippedComponents: [
            {
              packageId: "Stardew Valley - THAI",
              componentUniqueId: "example.thai",
              componentName: "Stardew Valley - THAI",
              relativeLocation: "Stardew Valley - THAI",
              reason: "This is a language pack, not a mod to translate.",
              requiresAttention: false,
              restOfPackageLoaded: false,
            },
          ],
        }}
        error={null}
        onClose={() => {}}
      />,
    );

    expect(
      screen.getAllByText(/1 community language pack was ignored/)[0],
    ).toBeInTheDocument();
    expect(screen.getByText("Everything is ready")).toBeInTheDocument();
    const line = screen
      .getAllByText(/1 community language pack was ignored/)[0]
      .closest("details");
    expect(line).not.toHaveAttribute("open");
    expect(screen.getAllByText("Stardew Valley - THAI")).toHaveLength(1);
    expect(document.querySelector("[data-scan-diagnostics]")).toBeNull();
  });

  it("names an expected exclusion with its reason", () => {
    render(
      <ScanDialog
        scanning={false}
        result={{
          ...RESULT,
          warnings: [],
          skippedComponents: [
            {
              packageId: "Stardew Valley - THAI",
              componentUniqueId: "example.thai",
              componentName: "Thai translation pack",
              relativeLocation: "Language Packs/Thai",
              reason: "This is a language pack, not a mod to translate.",
              requiresAttention: false,
              restOfPackageLoaded: false,
            },
          ],
        }}
        error={null}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("Thai translation pack")).toBeInTheDocument();
    expect(
      screen.getByText(/This is a language pack, not a mod to translate/),
    ).toBeInTheDocument();
  });

  it("keeps a clean scan to two short lines", () => {
    render(
      <ScanDialog
        scanning={false}
        result={{
          ...RESULT,
          warnings: [],
          skippedComponents: [],
          sourceDeltas: {
            sourcesChanged: 0,
            stringsAdded: 0,
            stringsRemoved: 0,
            addedStrings: [],
            changedSources: [],
          },
        }}
        error={null}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("Everything is ready")).toBeInTheDocument();
    expect(
      screen.getByText("No new or changed English text since your last scan."),
    ).toBeInTheDocument();
    expect(document.querySelector("[data-scan-diagnostics]")).toBeNull();
  });

  it("opens the exact added and changed scan subsets", () => {
    const onOpenAddedStrings = vi.fn();
    const onReviewChangedSources = vi.fn();
    render(
      <ScanDialog
        scanning={false}
        result={RESULT}
        error={null}
        onOpenAddedStrings={onOpenAddedStrings}
        onReviewChangedSources={onReviewChangedSources}
        onClose={() => {}}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Show new strings (3)" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Show changed strings (2)" }),
    );
    expect(onOpenAddedStrings).toHaveBeenCalledOnce();
    expect(onReviewChangedSources).toHaveBeenCalledOnce();
  });

  it("calls onClose when Close is clicked", () => {
    const onClose = vi.fn();
    render(
      <ScanDialog
        scanning={false}
        result={RESULT}
        error={null}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("ignores Escape while scan progress is indeterminate", () => {
    const onClose = vi.fn();
    render(
      <ScanDialog scanning result={null} error={null} onClose={onClose} />,
    );

    fireEvent.keyDown(screen.getByRole("dialog", { name: /scan/i }), {
      key: "Escape",
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("scanAttentionCount", () => {
  it("counts attention skips and warnings", () => {
    expect(scanAttentionCount(RESULT)).toBe(2);
  });

  it("still counts warnings when the scan has no skip list", () => {
    expect(
      scanAttentionCount({ ...RESULT, skippedComponents: undefined }),
    ).toBe(1);
    expect(
      scanAttentionCount({
        ...RESULT,
        warnings: [],
        skippedComponents: undefined,
      }),
    ).toBeNull();
  });
});
