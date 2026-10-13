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
    fireEvent.click(
      screen.getByText("Details", { selector: ".desktop-xd-section-title" }),
    );
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
      "2 not translated yet",
    );
    expect(screen.getByText(/Includes 3 translations/)).toBeVisible();
    fireEvent.click(
      screen.getByText("Details", { selector: ".desktop-xd-section-title" }),
    );
    expect(screen.getByText(/2 in Review, 1 Changed/)).toBeVisible();
    expect(
      screen.getByText(/Counts reflect the current scan/),
    ).toHaveTextContent("Tokens checked.");
  });
  it("does not invent counts or claim readiness when preflight data is missing", () => {
    show();
    expect(screen.getByText("Count not available yet")).toBeVisible();
    expect(screen.queryByText(/Ready to export/)).toBeNull();
  });
  it("exports everything else and names the strings that stay English", () => {
    const props = show({
      omitted: [
        {
          modUniqueId: "test.mod",
          modName: "Test Mod",
          relativeDir: "i18n",
          key: "status.saved",
          reason: "# is missing from the translation.",
        },
      ],
      acceptedMismatches: 1,
      onInspectProblem: vi.fn(),
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(/1 string stays in English/)).toBeVisible();
    const omitted = screen.getByRole("list", {
      name: "Strings left out of the export",
    });
    expect(omitted).toHaveTextContent("status.saved");
    fireEvent.click(screen.getByRole("button", { name: "Open status.saved" }));
    expect(props.onInspectProblem).toHaveBeenCalledWith(
      expect.objectContaining({ key: "status.saved" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Replace in Mods folder" }),
    );
    expect(props.onConfirm).toHaveBeenCalledOnce();
  });
  it("calls only the selected action", () => {
    const props = show();
    fireEvent.click(
      screen.getByRole("button", { name: "Replace in Mods folder" }),
    );
    expect(props.onConfirm).toHaveBeenCalledOnce();
    expect(props.onCancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.onCancel).toHaveBeenCalledOnce();
  });
  it("says the files go straight into the Mods folder", () => {
    show({
      modsRoot: "E:/SDV/Mods",
      existingTargetPaths: ["E:/SDV/Mods/Test/i18n/de.json"],
    });
    const dialog = screen.getByRole("dialog", { name: "Export translations" });
    expect(dialog).toHaveTextContent("Writes directly into your Mods folder");
    expect(screen.getByText("Mods/Test/i18n/de.json")).toBeVisible();
    expect(dialog).toHaveTextContent(
      "The game uses it on the next start. The existing de.json is backed up first (.json.bak).",
    );
    expect(
      screen.getByRole("button", { name: "Replace in Mods folder" }),
    ).toBeEnabled();
  });
  it("labels a write without replaced files and makes no backup claim", () => {
    show({
      existingFiles: 0,
      newFiles: 1,
      newTargetPaths: ["Mods/Test/i18n/de.json"],
    });
    expect(screen.getByRole("dialog")).not.toHaveTextContent("backed up");
    expect(
      screen.getByRole("button", { name: "Export to Mods folder" }),
    ).toBeEnabled();
  });
  it("shows the first target of several and expands the rest", () => {
    show({
      mods: 3,
      existingFiles: 1,
      newFiles: 2,
      modsRoot: "E:/SDV/Mods",
      existingTargetPaths: ["E:/SDV/Mods/A/i18n/de.json"],
      newTargetPaths: [
        "E:/SDV/Mods/B/i18n/de.json",
        "E:/SDV/Mods/C/i18n/de.json",
      ],
    });
    expect(screen.getByRole("dialog")).toHaveTextContent("into 3 mod folders");
    expect(screen.getByText("Mods/A/i18n/de.json")).toBeVisible();
    expect(screen.queryByText("Mods/C/i18n/de.json")).toBeNull();
    const more = screen.getByRole("button", { name: "+2 more" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(more);
    expect(screen.getByText("Mods/C/i18n/de.json")).toBeVisible();
    expect(screen.getByRole("button", { name: "Show fewer" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });
  it("marks left-out strings as errors and hides empty counts", () => {
    show({
      willWrite: 4,
      openOmitted: 0,
      omitted: [
        {
          modUniqueId: "test.mod",
          modName: "Test Mod",
          relativeDir: "i18n",
          key: "status.saved",
          reason: "# is missing from the translation.",
        },
      ],
    });
    const counts = screen.getByLabelText("Export contents");
    expect(counts).toHaveTextContent("4 translations included");
    expect(counts).toHaveTextContent("1 left out");
    expect(counts).not.toHaveTextContent("not translated yet");
    expect(screen.getByText("left out").parentElement).toHaveClass("is-danger");
  });
  it("names the mod of a left-out string when several mods are exported", () => {
    show({
      mods: 2,
      omitted: [
        {
          modUniqueId: "a",
          modName: "Alpha",
          relativeDir: "i18n",
          key: "same.key",
          reason: "# is missing from the translation.",
        },
        {
          modUniqueId: "b",
          modName: "Beta",
          relativeDir: "i18n",
          key: "same.key",
          reason: "# is missing from the translation.",
        },
      ],
      onInspectProblem: vi.fn(),
    });
    expect(
      screen.getByRole("button", { name: "Open same.key in Alpha" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Open same.key in Beta" }),
    ).toBeEnabled();
  });
  it("holds every action while another choice loads", () => {
    const props = show({
      switching: true,
      omitted: [
        {
          modUniqueId: "test.mod",
          modName: "Test Mod",
          relativeDir: "i18n",
          key: "status.saved",
          reason: "# is missing from the translation.",
        },
      ],
      onInspectProblem: vi.fn(),
    });
    expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Open status.saved" }),
    ).toBeDisabled();
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
