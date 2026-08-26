import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { ScanDialog } from "./ScanDialog";
import type { ScanResult } from "../tauri/commands";

const RESULT: ScanResult = {
  mods: [],
  warnings: ["Skipped E:/Mods/Broken/manifest.json: invalid manifest JSON"],
  skippedComponents: [
    {
      packageId: "Sample Pack",
      componentUniqueId: "sample.broken",
      componentName: "Broken Component",
      relativeLocation: "Sample/Broken/manifest.json",
      reason: "invalid manifest JSON",
      restOfPackageLoaded: true,
    },
  ],
  extraKeys: [],
  modCount: 12,
  fileCount: 18,
};

describe("ScanDialog", () => {
  it("shows a spinner while scanning", () => {
    render(
      <ScanDialog scanning result={null} error={null} onClose={() => {}} />,
    );
    expect(screen.getByText("Scanning mods …")).toBeInTheDocument();
    expect(screen.getByText(/Reading manifests and i18n/)).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuetext",
      "Scanning; exact progress is unavailable",
    );
    // The accepted flow retains its action row but cannot close mid-scan.
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
  });

  it("shows structured skipped components alongside raw scanner warnings", () => {
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
      screen.getByText(/1 scanner warning was reported/),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/invalid manifest JSON/)).toHaveLength(2);
    expect(screen.getAllByText("Unavailable")).toHaveLength(3);
    const skippedMetric = screen
      .getByText("components skipped")
      .closest(".stv3-preflight-metric");
    expect(skippedMetric).toHaveTextContent("1components skipped");
    expect(screen.getByText(/component was skipped/)).toBeInTheDocument();
    expect(screen.getByText("Broken Component")).toBeInTheDocument();
    expect(screen.getByText("Package: Sample Pack")).toBeInTheDocument();
    expect(screen.getByText("Sample/Broken/manifest.json")).toBeInTheDocument();
    expect(screen.getByText("Rest of package loaded")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Review changed sources/ }),
    ).toBeDisabled();
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
      .closest(".stv3-preflight-metric");
    expect(skippedMetric).toHaveTextContent("0components skipped");
    expect(screen.getByText("No components were skipped.")).toBeInTheDocument();
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
      .closest(".stv3-preflight-metric");
    expect(skippedMetric).toHaveTextContent("Unavailablecomponents skipped");
    expect(
      screen.getByText(/Structured skipped-component details are unavailable/),
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

    const diagnostics = screen
      .getByText(/component was skipped/)
      .closest(".stv3-flow-callout");
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

  it("lists extra target keys as non-blocking diagnostics", () => {
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
    expect(screen.getByText(/Optional cleanup/)).toBeInTheDocument();
    expect(screen.getByText(/1 unused target key/)).toBeInTheDocument();
    expect(screen.getByText("Example Mod")).toBeInTheDocument();
    expect(
      screen.getByText("E:/Mods/Example/i18n/de.json"),
    ).toBeInTheDocument();
    expect(screen.getByText("removed-key")).toBeInTheDocument();
    expect(screen.getByText(/SMAPI ignores these keys/)).toBeInTheDocument();
    expect(screen.getByText(/do not affect progress/)).toBeInTheDocument();
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

  it("closes with Escape even while progress is indeterminate", () => {
    const onClose = vi.fn();
    render(
      <ScanDialog scanning result={null} error={null} onClose={onClose} />,
    );

    fireEvent.keyDown(screen.getByRole("dialog", { name: "Scan" }), {
      key: "Escape",
    });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
