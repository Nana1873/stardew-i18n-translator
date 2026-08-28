import { fireEvent, render, screen, within } from "@testing-library/react";
import { vi } from "vitest";
import type { ScanResult, ScannedMod } from "../tauri/commands";
import { Dashboard } from "./Dashboard";

function sampleMod(partial: Partial<ScannedMod> = {}): ScannedMod {
  return {
    uniqueId: "sample.mod",
    name: "Sample Mod",
    version: "1.0.0",
    nexusId: 123,
    packageId: "Sample Pack",
    folderPath: "E:/Fixtures/Mods/Sample",
    i18nFiles: [
      {
        relativeDir: "i18n",
        defaultPath: "E:/Fixtures/Mods/Sample/i18n/default.json",
        targetPath: "E:/Fixtures/Mods/Sample/i18n/de.json",
        targetExists: true,
        totalKeys: 10,
        translatedKeys: 7,
        reviewNeeded: 1,
      },
    ],
    totalKeys: 10,
    translatedKeys: 7,
    reviewNeeded: 1,
    progress: 0.7,
    status: "untranslated",
    statusCounts: {
      untranslated: 3,
      translated: 5,
      outdated: 1,
      "review-needed": 1,
    },
    ...partial,
  };
}

function sampleScan(mods = [sampleMod()]): ScanResult {
  return {
    mods,
    warnings: ["Skipped malformed optional component"],
    skippedComponents: [
      {
        packageId: "Sample Pack",
        componentUniqueId: "sample.optional",
        componentName: "Optional Component",
        relativeLocation: "Sample/Optional/manifest.json",
        reason: "invalid manifest JSON",
        requiresAttention: true,
        restOfPackageLoaded: true,
      },
    ],
    extraKeys: [],
    modCount: mods.length,
    fileCount: mods.reduce((sum, mod) => sum + mod.i18nFiles.length, 0),
  };
}

describe("Dashboard", () => {
  it("renders the accepted Overview from real counts and explicit unavailable deltas", () => {
    const filter = vi.fn();
    const scanDetails = vi.fn();
    const lastExport = vi.fn();
    render(
      <Dashboard
        scan={sampleScan()}
        scanning={false}
        lastScanAt={Date.now() - 8 * 60_000}
        languageLine="German (de)"
        onScan={vi.fn()}
        scanEnabled
        onOpenMod={vi.fn()}
        onBrowse={vi.fn()}
        lastOpened={{ "sample.mod": Date.now() - 60_000 }}
        onShowScanDetails={scanDetails}
        onOpenOverviewFilter={filter}
        lastExport={{
          label: "Last export · Sample Mod",
          path: "E:/Fixtures/Mods/Sample/i18n/de.json",
          folder: "E:/Fixtures/Mods/Sample/i18n",
        }}
        onShowLastExport={lastExport}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Overview" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/German \(de\) · 1 mod/)).toBeInTheDocument();
    const hasText = screen.getByRole("button", { name: /Has German text/ });
    expect(screen.getByText(/scanned 8 min ago/)).toBeInTheDocument();
    expect(hasText).toHaveTextContent("7 / 10 · 70%");
    expect(
      screen.getByRole("button", { name: /Reviewed & current/ }),
    ).toHaveTextContent("5 · 50%");
    expect(screen.getByRole("button", { name: /^Open/ })).toHaveTextContent(
      "3 · 30%",
    );
    expect(screen.queryByText("Needs attention")).not.toBeInTheDocument();
    expect(
      screen.getByText(
        /1 component skipped · change, added, and removed deltas unavailable/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/1 scanner warning/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Latest scan:/ }),
    ).toHaveTextContent("Latest scan: 1 mod · 1 i18n file");
    expect(
      screen.getByText("E:/Fixtures/Mods/Sample/i18n/de.json"),
    ).toBeInTheDocument();

    fireEvent.click(hasText);
    expect(filter).toHaveBeenCalledWith("has-value");
    fireEvent.click(screen.getByRole("button", { name: /Reviewed & current/ }));
    expect(filter).toHaveBeenCalledWith("translated");
    fireEvent.click(screen.getByRole("button", { name: /^Open/ }));
    expect(filter).toHaveBeenCalledWith("untranslated");
    fireEvent.click(screen.getByRole("button", { name: "Show in folder" }));
    expect(lastExport).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: /Latest scan:/ }));
    expect(scanDetails).toHaveBeenCalledOnce();
  });

  it("shows real zero source deltas from the latest scan", () => {
    const scan = sampleScan();
    scan.sourceDeltas = {
      sourcesChanged: 0,
      stringsAdded: 0,
      stringsRemoved: 0,
      addedStrings: [],
      changedSources: [],
    };

    render(
      <Dashboard
        scan={scan}
        scanning={false}
        lastScanAt={Date.now()}
        languageLine="German (de)"
        onScan={vi.fn()}
        scanEnabled
        onOpenMod={vi.fn()}
        onBrowse={vi.fn()}
        lastOpened={{}}
        onShowScanDetails={vi.fn()}
      />,
    );

    const latestScan = screen.getByRole("button", { name: /Latest scan:/ });
    expect(latestScan).toHaveTextContent(
      "0 English strings changed · 0 strings added · 0 strings removed",
    );
    expect(latestScan).not.toHaveTextContent("deltas unavailable");
  });

  it("shows portable last-opened activity and uses it for navigation", () => {
    const openMod = vi.fn();
    const lastOpenedAt = Date.now() - 12 * 60_000;
    render(
      <Dashboard
        scan={sampleScan()}
        scanning={false}
        lastScanAt={Date.now()}
        languageLine="German (de)"
        onScan={vi.fn()}
        scanEnabled
        onOpenMod={openMod}
        onBrowse={vi.fn()}
        lastOpened={{ "sample.mod": lastOpenedAt }}
      />,
    );

    const recentTable = screen.getByRole("table");
    fireEvent.click(
      within(recentTable).getByRole("button", { name: "Sample Mod" }),
    );
    expect(openMod).toHaveBeenCalledWith("sample.mod");
    expect(screen.getByText("Recently opened")).toBeInTheDocument();
    expect(within(recentTable).getByText("12 min ago")).toBeInTheDocument();
    expect(within(recentTable).queryByText("Unavailable")).toBeNull();
    const recentStatus = within(recentTable).getByText("1 changed");
    expect(recentStatus).toHaveAttribute(
      "aria-description",
      "The English source changed after this German translation was saved. The existing translation may be outdated and should be reviewed.",
    );
    fireEvent.pointerEnter(recentStatus);
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "The English source changed after this German translation was saved.",
    );
    fireEvent.pointerLeave(recentStatus);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(screen.queryByText("Needs attention")).not.toBeInTheDocument();
  });

  it("offers a rescan for incomplete legacy status data", () => {
    const withoutStatusCounts = sampleMod({ statusCounts: undefined });
    const scanWithoutStructuredSkips = sampleScan([withoutStatusCounts]);
    const rescan = vi.fn();
    delete scanWithoutStructuredSkips.skippedComponents;
    render(
      <Dashboard
        scan={scanWithoutStructuredSkips}
        scanning={false}
        lastScanAt={null}
        languageLine="German (de)"
        onScan={rescan}
        scanEnabled
        onOpenMod={vi.fn()}
        onBrowse={vi.fn()}
        lastOpened={{}}
      />,
    );

    expect(
      screen.getByRole("button", { name: /Reviewed & current/ }),
    ).toHaveTextContent("Scan again");
    expect(
      screen.getByText("Run a scan to calculate current status"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Reviewed & current/ }));
    expect(rescan).toHaveBeenCalledOnce();
    expect(screen.queryByText("Needs attention")).not.toBeInTheDocument();
    expect(
      screen.getByText(/Last export · Unavailable in this session/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/skipped-component count unavailable/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show in folder" }),
    ).toBeDisabled();
    expect(screen.getByText(/scan time unavailable/)).toBeInTheDocument();
    expect(
      screen.getByText("No recently opened mods yet."),
    ).toBeInTheDocument();
  });
});
