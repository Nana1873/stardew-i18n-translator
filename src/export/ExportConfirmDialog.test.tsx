import { fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";
import { ExportConfirmDialog } from "./ExportConfirmDialog";

describe("ExportConfirmDialog", () => {
  it("describes a selected-mod overwrite and its backup", () => {
    render(
      <ExportConfirmDialog
        modName="Test Mod"
        files={1}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    const dialog = screen.getByRole("dialog", {
      name: "Confirm export overwrite",
    });
    expect(dialog).toHaveTextContent("replace 1 existing translation file");
    expect(dialog).toHaveTextContent(".json.bak");
  });

  it("reports affected mods for Export All", () => {
    render(
      <ExportConfirmDialog
        modName="All mods"
        files={4}
        mods={3}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(screen.getByText(/across/)).toHaveTextContent("3 mods");
  });

  it("calls the selected action", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ExportConfirmDialog
        modName="Test Mod"
        files={2}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Export and replace" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
