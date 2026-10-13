import { fireEvent, render, screen, within } from "@testing-library/react";
import { vi } from "vitest";
import {
  ExportChooser,
  openingExportChoice,
  rememberedExportChoice,
  type ExportChoice,
} from "./ExportChooser";

describe("Remembered export choice", () => {
  it("keeps the user's scope when All mods was only the fallback", () => {
    // Opened without a selected mod: the dialog shows All mods, but the
    // remembered scope stays the user's real choice.
    const remembered: ExportChoice = { scope: "mod", output: "json" };
    const shown = openingExportChoice(remembered, false);
    expect(shown).toEqual({ scope: "all", output: "json" });
    const afterFallback = rememberedExportChoice(remembered, shown, false);
    expect(afterFallback).toEqual({ scope: "mod", output: "json" });

    // Changing the output without a mod is still remembered.
    const zip = rememberedExportChoice(
      afterFallback,
      { scope: "all", output: "zip" },
      false,
    );
    expect(zip).toEqual({ scope: "mod", output: "zip" });
    expect(openingExportChoice(zip, true)).toEqual({
      scope: "mod",
      output: "zip",
    });
  });

  it("starts on This mod and ZIP and remembers a real All mods choice", () => {
    expect(openingExportChoice(null, true)).toEqual({
      scope: "mod",
      output: "zip",
    });
    const all = rememberedExportChoice(
      null,
      { scope: "all", output: "json" },
      true,
    );
    expect(openingExportChoice(all, true)).toEqual({
      scope: "all",
      output: "json",
    });
  });
});

function show(
  choice: ExportChoice,
  options: { modAvailable?: boolean; busy?: boolean } = {},
) {
  const onChange = vi.fn();
  render(
    <ExportChooser
      choice={choice}
      modAvailable={options.modAvailable ?? true}
      busy={options.busy}
      onChange={onChange}
    />,
  );
  return onChange;
}

describe("Export choice", () => {
  it("asks for the mods and the output as two labelled radio groups", () => {
    show({ scope: "mod", output: "zip" });
    const mods = screen.getByRole("radiogroup", { name: "Mods" });
    const output = screen.getByRole("radiogroup", { name: "Output" });
    expect(within(mods).getByRole("radio", { name: "This mod" })).toBeChecked();
    expect(
      within(mods).getByRole("radio", { name: "All mods" }),
    ).not.toBeChecked();
    expect(within(output).getByRole("radio", { name: "ZIP" })).toBeChecked();
    expect(
      within(output).getByRole("radio", { name: "JSON" }),
    ).not.toBeChecked();
    // Only the checked option of each group is in the Tab order.
    expect(screen.getByRole("radio", { name: "This mod" })).toHaveAttribute(
      "tabindex",
      "0",
    );
    expect(screen.getByRole("radio", { name: "All mods" })).toHaveAttribute(
      "tabindex",
      "-1",
    );
    expect(
      screen.getByText(
        "Saves one installable ZIP for this mod — for MO2, Vortex or a Nexus Mods upload.",
      ),
    ).toBeVisible();
  });

  it("names all mods without repeating mod names, and leaves JSON to its preview", () => {
    const { unmount } = render(
      <ExportChooser
        choice={{ scope: "all", output: "zip" }}
        modAvailable
        onChange={vi.fn()}
      />,
    );
    expect(
      screen.getByText(
        "Saves one combined ZIP for all mods — for MO2, Vortex or a Nexus Mods upload.",
      ),
    ).toBeVisible();
    unmount();
    show({ scope: "all", output: "json" });
    expect(screen.queryByText(/Saves one/)).toBeNull();
  });

  it("switches by click and by arrow keys", () => {
    const onChange = show({ scope: "mod", output: "zip" });
    fireEvent.click(screen.getByRole("radio", { name: "JSON" }));
    expect(onChange).toHaveBeenLastCalledWith({ scope: "mod", output: "json" });
    fireEvent.keyDown(screen.getByRole("radio", { name: "This mod" }), {
      key: "ArrowRight",
    });
    expect(onChange).toHaveBeenLastCalledWith({ scope: "all", output: "zip" });
    // Choosing the checked option again does nothing.
    onChange.mockClear();
    fireEvent.click(screen.getByRole("radio", { name: "ZIP" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("offers only All mods when no mod is selected", () => {
    const onChange = show(
      { scope: "all", output: "zip" },
      { modAvailable: false },
    );
    expect(screen.getByRole("radio", { name: "This mod" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("radio", { name: "All mods" }), {
      key: "ArrowLeft",
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("waits while a preview loads", () => {
    const onChange = show({ scope: "mod", output: "zip" }, { busy: true });
    for (const group of screen.getAllByRole("radiogroup"))
      expect(group).toHaveAttribute("aria-busy", "true");
    fireEvent.click(screen.getByRole("radio", { name: "JSON" }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
