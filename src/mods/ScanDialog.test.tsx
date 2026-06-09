import { render, screen, fireEvent } from "@testing-library/react";
import { vi } from "vitest";
import { ScanDialog } from "./ScanDialog";
import type { ScanResult } from "../tauri/commands";

const RESULT: ScanResult = {
  mods: [],
  warnings: ["Skipped E:/Mods/Broken/manifest.json: invalid manifest JSON"],
  modCount: 12,
  fileCount: 18,
};

describe("ScanDialog", () => {
  it("shows a spinner while scanning", () => {
    render(<ScanDialog scanning result={null} error={null} onClose={() => {}} />);
    expect(screen.getByText("Scanning mods…")).toBeInTheDocument();
    expect(screen.getByText(/Reading your Mods folder/)).toBeInTheDocument();
    // No Close button while scanning.
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });

  it("summarizes counts and lists skipped mods on completion", () => {
    render(<ScanDialog scanning={false} result={RESULT} error={null} onClose={() => {}} />);
    expect(screen.getByText("Scan complete")).toBeInTheDocument();
    expect(screen.getByText(/12/)).toBeInTheDocument();
    expect(screen.getByText(/1 skipped:/)).toBeInTheDocument();
    expect(screen.getByText(/invalid manifest JSON/)).toBeInTheDocument();
  });

  it("shows the error message on failure", () => {
    render(
      <ScanDialog scanning={false} result={null} error="Mods folder not found" onClose={() => {}} />,
    );
    expect(screen.getByText("Scan failed")).toBeInTheDocument();
    expect(screen.getByText("Mods folder not found")).toBeInTheDocument();
  });

  it("calls onClose when Close is clicked", () => {
    const onClose = vi.fn();
    render(<ScanDialog scanning={false} result={RESULT} error={null} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });
});
