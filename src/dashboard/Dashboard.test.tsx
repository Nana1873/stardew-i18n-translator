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
        onOpenAttention={vi.fn()}
        onBrowse={vi.fn()}
        lastOpened={{ "sample.mod": Date.now() - 60_000 }}
        onShowScanDetails={scanDetails}
        onOpenOverviewFilter={filter}
        lastExport={{
          label: "Last export · Sample Mod",
          path: "E:/Fixtures/Mods/Sample/i18n/de.json",
        }}
        onShowLastExport={lastExport}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Overview" }),
    ).toBeInTheDocument();
    const hasText = screen.getByRole("button", { name: /Has German text/ });
    expect(screen.getByText(/scanned 8 min ago/)).toBeInTheDocument();
    expect(hasText).toHaveTextContent("7 / 10 · 70%");
    expect(
      screen.getByRole("button", { name: /Reviewed & current/ }),
    ).toHaveTextContent("5 · 50%");
    expect(
      screen.getByRole("button", { name: /Needs attention/ }),
    ).toHaveTextContent("1 Review · 1 Changed");
    expect(screen.getByRole("button", { name: /^Open/ })).toHaveTextContent(
      "3 · 30%",
    );
    expect(
      screen.getByText(
        /skipped-component count and change, added, and removed deltas unavailable/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/1 scanner warning/)).toBeInTheDocument();
    expect(screen.queryByText(/1 skipped/)).toBeNull();
    expect(
      screen.getByText("E:/Fixtures/Mods/Sample/i18n/de.json"),
    ).toBeInTheDocument();

    fireEvent.click(hasText);
    expect(filter).toHaveBeenCalledWith("has-value");
    fireEvent.click(screen.getByRole("button", { name: "Show in folder" }));
    expect(lastExport).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: /Latest scan:/ }));
    expect(scanDetails).toHaveBeenCalledOnce();
  });

  it("uses portable recency only for navigation and opens real attention queues", () => {
    const openMod = vi.fn();
    const openAttention = vi.fn();
    render(
      <Dashboard
        scan={sampleScan()}
        scanning={false}
        lastScanAt={Date.now()}
        languageLine="German (de)"
        onScan={vi.fn()}
        scanEnabled
        onOpenMod={openMod}
        onOpenAttention={openAttention}
        onBrowse={vi.fn()}
        lastOpened={{ "sample.mod": Date.now() }}
      />,
    );

    const recentTable = screen.getByRole("table");
    fireEvent.click(
      within(recentTable).getByRole("button", { name: "Sample Mod" }),
    );
    expect(openMod).toHaveBeenCalledWith("sample.mod");
    expect(within(recentTable).getByText("Unavailable")).toBeInTheDocument();
    expect(within(recentTable).queryByText(/ago$/)).toBeNull();
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

    fireEvent.click(
      screen.getByRole("button", {
        name: /Sample Mod · 1.*Changed source.*Update assistant · Unavailable/,
      }),
    );
    expect(openAttention).toHaveBeenCalledWith("sample.mod", "outdated");
    fireEvent.click(
      screen.getByRole("button", {
        name: /Sample Mod · 1.*AI suggestions awaiting review/,
      }),
    );
    expect(openAttention).toHaveBeenCalledWith("sample.mod", "review-needed");
  });

  it("does not invent all-mod status or result history", () => {
    const withoutStatusCounts = sampleMod({ statusCounts: undefined });
    render(
      <Dashboard
        scan={sampleScan([withoutStatusCounts])}
        scanning={false}
        lastScanAt={null}
        languageLine="German (de)"
        onScan={vi.fn()}
        scanEnabled
        onOpenMod={vi.fn()}
        onOpenAttention={vi.fn()}
        onBrowse={vi.fn()}
        lastOpened={{}}
      />,
    );

    expect(
      screen.getByRole("button", { name: /Reviewed & current/ }),
    ).toHaveTextContent("Unavailable");
    expect(
      screen.getByRole("button", { name: /Needs attention/ }),
    ).toHaveTextContent("1 Review · Changed unavailable");
    expect(
      screen.getByText(/Last export · Unavailable in this session/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show in folder" }),
    ).toBeDisabled();
    expect(screen.getByText(/scan time unavailable/)).toBeInTheDocument();
  });

  it("shows known Changed rows without presenting a partial Changed total as complete", () => {
    const known = sampleMod({
      uniqueId: "known.mod",
      name: "Known Mod",
      reviewNeeded: 0,
      statusCounts: {
        untranslated: 6,
        translated: 1,
        outdated: 3,
        "review-needed": 0,
      },
    });
    const unknown = sampleMod({
      uniqueId: "unknown.mod",
      name: "Unknown Mod",
      reviewNeeded: 2,
      statusCounts: undefined,
    });
    render(
      <Dashboard
        scan={sampleScan([known, unknown])}
        scanning={false}
        lastScanAt={Date.now()}
        languageLine="German (de)"
        onScan={vi.fn()}
        scanEnabled
        onOpenMod={vi.fn()}
        onOpenAttention={vi.fn()}
        onBrowse={vi.fn()}
        lastOpened={{}}
      />,
    );

    expect(
      screen.getByRole("button", { name: /Needs attention/ }),
    ).toHaveTextContent("2 Review · Changed unavailable");
    expect(
      screen.getByRole("button", {
        name: /Known Mod · 3.*Changed source.*Update assistant · Unavailable/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /View all attention.*2 Review · Changed unavailable/,
      }),
    ).toBeInTheDocument();
  });
});
