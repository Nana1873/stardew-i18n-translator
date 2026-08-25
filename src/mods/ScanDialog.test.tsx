import { render, screen, fireEvent } from "@testing-library/react";
import { vi } from "vitest";
import { ScanDialog } from "./ScanDialog";
import type { ScanResult } from "../tauri/commands";

const RESULT: ScanResult = {
  mods: [],
  warnings: ["Skipped E:/Mods/Broken/manifest.json: invalid manifest JSON"],
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

  it("shows raw scanner warnings without inventing a skipped-component count", () => {
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
    expect(screen.getByText(/invalid manifest JSON/)).toBeInTheDocument();
    expect(screen.getAllByText("Unavailable")).toHaveLength(4);
    expect(
      screen.getByText("components skipped").previousSibling,
    ).toHaveTextContent("Unavailable");
    expect(screen.queryByText(/component was skipped/)).toBeNull();
    expect(
      screen.getByRole("button", { name: /Review changed sources/ }),
    ).toBeDisabled();
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
