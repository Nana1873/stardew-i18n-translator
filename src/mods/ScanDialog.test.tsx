import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { ScanDialog } from "./ScanDialog";
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
    const dialog = screen.getByRole("dialog", { name: "Scan" });
    expect(dialog).toHaveAttribute("tabindex", "-1");
    await waitFor(() => expect(dialog).toHaveFocus());
    expect(screen.getByText("Scanning mods …")).toBeInTheDocument();
    expect(screen.getByText(/Reading manifests and i18n/)).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuetext",
      "Scanning; exact progress is unavailable",
    );
    // The accepted flow retains its action row but cannot close mid-scan.
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
  });

  it("shows structured skipped components alongside independent scanner warnings", () => {
    render(
      <ScanDialog
        scanning={false}
        result={RESULT}
        error={null}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("Scan completed")).toBeInTheDocument();
    expect(
      screen.getByText(/Read 12 mods and 18 i18n files/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/1 scanner warning · 1 component skipped/),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/invalid manifest JSON/)).toHaveLength(1);
    expect(
      screen.getByText("Source comparison is unavailable for this scan."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Unavailable")).toBeNull();
    expect(
      screen
        .getByText("English strings changed")
        .closest(".translator-preflight-metric"),
    ).toHaveTextContent("2English strings changed");
    expect(
      screen.getByText("strings added").closest(".translator-preflight-metric"),
    ).toHaveTextContent("3strings added");
    expect(
      screen
        .getByText("string removed")
        .closest(".translator-preflight-metric"),
    ).toHaveTextContent("1string removed");
    const skippedMetric = screen
      .getByText("component skipped")
      .closest(".translator-preflight-metric");
    expect(skippedMetric).toHaveTextContent("1component skipped");
    expect(screen.getByText("Broken Component")).toBeInTheDocument();
    expect(screen.getByText("Package: Sample Pack")).toBeInTheDocument();
    expect(screen.getByText("Sample/Broken/manifest.json")).toBeInTheDocument();
    expect(screen.getByText("Rest of package loaded")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Review changed strings/ }),
    ).toBeDisabled();
  });

  it("uses singular count labels for a one-mod scan", () => {
    const singleResult: ScanResult = {
      ...RESULT,
      modCount: 1,
      fileCount: 1,
      warnings: [],
      skippedComponents: [RESULT.skippedComponents![0]],
      sourceDeltas: {
        sourcesChanged: 1,
        stringsAdded: 1,
        stringsRemoved: 1,
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

    expect(
      screen.getByText("mod found").closest(".translator-preflight-metric"),
    ).toHaveTextContent("1mod found");
    expect(
      screen.getByText("i18n file").closest(".translator-preflight-metric"),
    ).toHaveTextContent("1i18n file");
    expect(
      screen
        .getByText("English string changed")
        .closest(".translator-preflight-metric"),
    ).toHaveTextContent("1English string changed");
    expect(
      screen.getByText("string added").closest(".translator-preflight-metric"),
    ).toHaveTextContent("1string added");
    expect(
      screen
        .getByText("string removed")
        .closest(".translator-preflight-metric"),
    ).toHaveTextContent("1string removed");
    expect(
      screen
        .getByText("component skipped")
        .closest(".translator-preflight-metric"),
    ).toHaveTextContent("1component skipped");
    expect(
      screen.getByRole("button", { name: "Open new string · 1" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Review changed string · 1" }),
    ).toBeEnabled();
    expect(document.querySelector(".translator-sr-only")).toHaveTextContent(
      "Scan complete. 1 mod and 1 i18n file found.",
    );
  });

  it("distinguishes a known zero skipped count from an unavailable field", () => {
    const { rerender } = render(
      <ScanDialog
        scanning={false}
        result={{ ...RESULT, skippedComponents: [] }}
        error={null}
        onClose={() => {}}
      />,
    );

    let skippedMetric = screen
      .getByText("components skipped")
      .closest(".translator-preflight-metric");
    expect(skippedMetric).toHaveTextContent("0components skipped");
    expect(screen.queryByText("No components were skipped.")).toBeNull();
    expect(
      screen.queryByText(
        /Structured skipped-component details are unavailable/,
      ),
    ).toBeNull();

    rerender(
      <ScanDialog
        scanning={false}
        result={{ ...RESULT, skippedComponents: undefined }}
        error={null}
        onClose={() => {}}
      />,
    );

    skippedMetric = screen
      .getByText("components skipped")
      .closest(".translator-preflight-metric");
    expect(skippedMetric).toHaveTextContent("Unavailablecomponents skipped");
    expect(
      screen.getByText(/Skipped-component details unavailable/),
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
    expect(screen.queryByText("Scan completed")).toBeNull();
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

    expect(screen.getByText("Scan unavailable")).toBeInTheDocument();
    expect(screen.getByText("Scan result unavailable.")).toBeInTheDocument();
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
      screen.getByText(/1 translation entry has no matching English source/),
    ).toBeInTheDocument();
    expect(screen.getByText("Example Mod")).toBeInTheDocument();
    expect(screen.getByText("i18n/de.json")).toBeInTheDocument();
    expect(
      screen.getByText("E:/Mods/Example/i18n/de.json"),
    ).toBeInTheDocument();
    expect(screen.getByText("Not found in English source")).toBeInTheDocument();
    expect(screen.getByText("removed-key")).toBeInTheDocument();
    expect(
      screen.getByText(/not in the mod's English source file \(default.json\)/),
    ).toBeInTheDocument();
    expect(screen.getByText(/removed or renamed/)).toBeInTheDocument();
    expect(
      screen.getByText(/do not count toward progress/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/No action is required/)).toBeInTheDocument();
    expect(
      screen.getByText(/retains the original file in its backup/),
    ).toBeInTheDocument();
    expect(document.querySelector("[data-scan-diagnostics]")).not.toHaveClass(
      "is-warning",
    );
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
    expect(
      diagnostics?.querySelector(".translator-scan-warning-section"),
    ).toBeInTheDocument();
    expect(diagnostics).toHaveTextContent("1 component skipped");
    expect(
      screen.getByText(/1 translation entry has no matching English source/),
    ).toBeInTheDocument();
    expect(diagnostics?.querySelectorAll(":scope > section")).toHaveLength(2);
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

  it("shows an expected language-pack exclusion as information, not a skipped problem", () => {
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
              reason:
                "Detected as a community language pack, not a translation target.",
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
      screen.getByText(/1 community language pack was ignored/),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Stardew Valley - THAI")).toHaveLength(1);
    expect(screen.queryByText("Package: Stardew Valley - THAI")).toBeNull();
    expect(screen.getByText("No action needed")).toBeInTheDocument();
    expect(screen.queryByText(/1 component skipped/)).toBeNull();
    expect(
      screen
        .getByText("components skipped")
        .closest(".translator-preflight-metric"),
    ).toHaveTextContent("0components skipped");
    expect(document.querySelector("[data-scan-diagnostics]")).not.toHaveClass(
      "is-warning",
    );
  });

  it("keeps distinct language-pack package and path details", () => {
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
              reason:
                "Detected as a community language pack, not a translation target.",
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
      screen.getByText("Package: Stardew Valley - THAI"),
    ).toBeInTheDocument();
    expect(screen.getByText("Language Packs/Thai")).toBeInTheDocument();
  });

  it("uses one diagnostics box and keeps redundant zero-state prose out", () => {
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

    expect(
      screen.getAllByText("No scanner warnings were reported."),
    ).toHaveLength(1);
    expect(document.querySelectorAll("[data-scan-diagnostics]")).toHaveLength(
      1,
    );
    expect(screen.queryByText(/No components were skipped/)).toBeNull();
    expect(screen.queryByText(/No scan history is invented/)).toBeNull();
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
      screen.getByRole("button", { name: "Open new strings · 3" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Review changed strings · 2" }),
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

    fireEvent.keyDown(screen.getByRole("dialog", { name: "Scan" }), {
      key: "Escape",
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});
