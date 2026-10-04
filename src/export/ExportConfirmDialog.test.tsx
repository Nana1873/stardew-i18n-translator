import { fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";
import { ExportConfirmDialog } from "./ExportConfirmDialog";
function show(
  options: Partial<React.ComponentProps<typeof ExportConfirmDialog>> = {},
) {
  const props = {
    modName: "Test Mod",
    existingFiles: 1,
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    ...options,
  };
  render(<ExportConfirmDialog {...props} />);
  return props;
}
describe("JSON export confirmation", () => {
  it("warns about replacement and backup before confirmation", () => {
    show();
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Replaces 1 existing translation file",
    );
    expect(screen.getByRole("dialog")).toHaveTextContent(".json.bak");
  });
  it("reports affected mods and separates existing targets from new files", () => {
    show({
      mods: 3,
      newFiles: 2,
      existingTargetPaths: ["Mods/Test/i18n/de.json"],
      newTargetPaths: [
        "Mods/Test/assets/i18n/de.json",
        "Mods/Other/i18n/de.json",
      ],
    });
    fireEvent.click(screen.getByText("Details", { selector: "summary" }));
    expect(screen.getByText("3 mods included.")).toBeVisible();
    expect(
      screen.getByText("Files to replace").parentElement,
    ).toHaveTextContent("Mods/Test/i18n/de.json");
    expect(screen.getByText("New files").parentElement).toHaveTextContent(
      "Mods/Other/i18n/de.json",
    );
  });
  it("includes Review and Changed values while explaining omitted Open values", () => {
    show({
      willWrite: 8,
      openOmitted: 2,
      changedIncluded: 1,
      reviewIncluded: 2,
      blockingValidationAvailable: true,
    });
    expect(screen.getByLabelText("Export contents")).toHaveTextContent(
      "8 translations included",
    );
    expect(screen.getByLabelText("Export contents")).toHaveTextContent(
      "2 untranslated omitted",
    );
    expect(screen.getByText(/Includes 3 translations/)).toBeVisible();
    fireEvent.click(screen.getByText("Details", { selector: "summary" }));
    expect(screen.getByText(/2 in Review, 1 Changed/)).toBeVisible();
    expect(
      screen.getByText(/Counts reflect the current scan/),
    ).toHaveTextContent("Protected-token checks passed.");
  });
  it("does not invent counts or claim readiness when preflight data is missing", () => {
    show();
    expect(screen.getByText("Translation count unavailable")).toBeVisible();
    expect(
      screen.getByText("Review and Changed counts unavailable."),
    ).toBeVisible();
    expect(screen.queryByText(/Ready to export/)).toBeNull();
  });
  it("blocks writing and exposes the actual blocking string", () => {
    const props = show({
      blockingProblem: {
        key: "status.saved",
        reason: "is missing {{saveName}}",
      },
      acceptedMismatches: 1,
      onInspectProblem: vi.fn(),
    });
    expect(screen.getByRole("button", { name: "Export JSON" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("status.saved");
    fireEvent.click(screen.getByRole("button", { name: "Open string" }));
    expect(props.onInspectProblem).toHaveBeenCalledOnce();
    expect(props.onConfirm).not.toHaveBeenCalled();
  });
  it("calls only the selected action", () => {
    const props = show();
    fireEvent.click(screen.getByRole("button", { name: "Export and replace" }));
    expect(props.onConfirm).toHaveBeenCalledOnce();
    expect(props.onCancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.onCancel).toHaveBeenCalledOnce();
  });
  it("treats Escape as cancellation and leaves backdrop clicks inert", () => {
    const props = show();
    fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
    expect(props.onCancel).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(props.onCancel).toHaveBeenCalledOnce();
  });
});
