import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";

import { LlmBatchExportDialog } from "./LlmBatchExportDialog";

function renderDialog(
  overrides: Partial<React.ComponentProps<typeof LlmBatchExportDialog>> = {},
) {
  const props: React.ComponentProps<typeof LlmBatchExportDialog> = {
    eligibleCount: 2,
    modName: "Test Mod",
    suggestedFileName: "Test-Mod.de.llm-batch.json",
    onChooseDestination: vi.fn().mockResolvedValue(null),
    onSave: vi.fn().mockResolvedValue(true),
    onClose: vi.fn(),
    ...overrides,
  };

  render(<LlmBatchExportDialog {...props} />);
  return props;
}

describe("LlmBatchExportDialog", () => {
  it("confirms the real selection and closes after the native save succeeds", async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    const onClose = vi.fn();
    renderDialog({ onSave, onClose });

    expect(screen.getByText("2 eligible strings · Test Mod")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "File name" })).toHaveValue(
      "Test-Mod.de.llm-batch.json",
    );

    fireEvent.click(screen.getByRole("button", { name: "Save JSON batch" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(null));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps the dialog open and restores Save after an export error", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("save failed"));
    const onClose = vi.fn();
    renderDialog({ onSave, onClose });

    fireEvent.click(screen.getByRole("button", { name: "Save JSON batch" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Error: save failed",
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Save JSON batch" }),
    ).toBeEnabled();
  });

  it("stays open when the native Save dialog is cancelled", async () => {
    const onSave = vi.fn().mockResolvedValue(false);
    const onClose = vi.fn();
    renderDialog({ onSave, onClose });

    fireEvent.click(screen.getByRole("button", { name: "Save JSON batch" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(null));
    expect(onClose).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Save JSON batch" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("dialog", { name: "Save LLM batch" }),
    ).toBeVisible();
  });

  it("contains Escape while the native save is pending", async () => {
    let finishSave!: () => void;
    const onSave = vi.fn(
      () =>
        new Promise<boolean>((resolve) => (finishSave = () => resolve(true))),
    );
    const onClose = vi.fn();
    renderDialog({ onSave, onClose });

    fireEvent.click(screen.getByRole("button", { name: "Save JSON batch" }));
    const dialog = screen.getByRole("dialog", { name: "Save LLM batch" });
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    finishSave();
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("chooses and displays a real destination before saving to that path", async () => {
    const onChooseDestination = vi
      .fn()
      .mockResolvedValue("C:\\Temp\\Custom batch.json");
    const onSave = vi.fn().mockResolvedValue(true);
    renderDialog({ onChooseDestination, onSave });

    fireEvent.click(screen.getByRole("button", { name: "Change …" }));

    expect(
      await screen.findByText("C:\\Temp\\Custom batch.json"),
    ).toBeVisible();
    expect(screen.getByRole("textbox", { name: "File name" })).toHaveValue(
      "Custom batch.json",
    );
    fireEvent.click(screen.getByRole("button", { name: "Save JSON batch" }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith("C:\\Temp\\Custom batch.json"),
    );
  });

  it("keeps the current destination when Change is cancelled", async () => {
    const onChooseDestination = vi
      .fn()
      .mockResolvedValueOnce("C:\\Temp\\first.json")
      .mockResolvedValueOnce(null);
    renderDialog({ onChooseDestination });

    fireEvent.click(screen.getByRole("button", { name: "Change …" }));
    expect(await screen.findByText("C:\\Temp\\first.json")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Change …" }));
    await waitFor(() => expect(onChooseDestination).toHaveBeenCalledTimes(2));

    expect(screen.getByText("C:\\Temp\\first.json")).toBeVisible();
    expect(
      screen.getByRole("dialog", { name: "Save LLM batch" }),
    ).toBeVisible();
  });

  it("disables confirmation when no strings are eligible", () => {
    renderDialog({ eligibleCount: 0 });

    expect(
      screen.getByRole("button", { name: "Save JSON batch" }),
    ).toBeDisabled();
  });

  it("closes through Cancel without starting an export", () => {
    const onSave = vi.fn().mockResolvedValue(true);
    const onClose = vi.fn();
    renderDialog({ onSave, onClose });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("keeps Tab inside the modal and closes on Escape", async () => {
    const onClose = vi.fn();
    renderDialog({ onClose });

    const first = screen.getByRole("button", {
      name: "Cancel batch export",
    });
    await waitFor(() => expect(first).toHaveFocus());
    const last = screen.getByRole("button", { name: "Save JSON batch" });
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(first).toHaveFocus();

    fireEvent.keyDown(first, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
