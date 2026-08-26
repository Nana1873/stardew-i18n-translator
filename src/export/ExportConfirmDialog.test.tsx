import { fireEvent, render, screen, within } from "@testing-library/react";
import { vi } from "vitest";
import { ExportConfirmDialog } from "./ExportConfirmDialog";

describe("ExportConfirmDialog", () => {
  it("describes a selected-mod overwrite and its backup", () => {
    render(
      <ExportConfirmDialog
        modName="Test Mod"
        existingFiles={1}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    const dialog = screen.getByRole("dialog", {
      name: "Confirm export overwrite",
    });
    expect(dialog).toHaveTextContent("replaces 1 existing translation file");
    expect(dialog).toHaveTextContent(".json.bak");
  });

  it("reports affected mods for Export All", () => {
    render(
      <ExportConfirmDialog
        modName="All mods"
        existingFiles={4}
        mods={3}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(screen.getByText(/across/)).toHaveTextContent("3 mods");
  });

  it("separates existing backups from newly created targets", () => {
    render(
      <ExportConfirmDialog
        modName="Test Mod"
        existingFiles={1}
        newFiles={2}
        existingTargetPaths={["E:/Fixtures/Mods/Test/i18n/de.json"]}
        newTargetPaths={[
          "E:/Fixtures/Mods/Test/assets/i18n/de.json",
          "E:/Fixtures/Mods/Test/optional/i18n/de.json",
        ]}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(screen.getByText(/This export replaces/)).toHaveTextContent(
      "replaces 1 existing translation file and creates 2 new translation files",
    );
    const existingTargets = screen
      .getByText("Existing target · backed up as .json.bak")
      .closest(".stv3-result-path");
    const newTargets = screen
      .getByText("New targets · created by this export")
      .closest(".stv3-result-path");
    expect(existingTargets).not.toBeNull();
    expect(newTargets).not.toBeNull();
    expect(
      within(existingTargets as HTMLElement).getByText(/Test\/i18n\/de.json/),
    ).toBeVisible();
    expect(
      within(existingTargets as HTMLElement).queryByText(
        /assets\/i18n\/de.json/,
      ),
    ).toBeNull();
    expect(
      within(newTargets as HTMLElement).getAllByText(/i18n\/de.json/),
    ).toHaveLength(2);
  });

  it("labels supplied counts as current-scan aggregates", () => {
    render(
      <ExportConfirmDialog
        modName="Test Mod"
        existingFiles={1}
        willWrite={8}
        openOmitted={2}
        changedIncluded={1}
        reviewIncluded={2}
        acceptedMismatches={0}
        existingTargetPaths={["E:/Fixtures/Mods/Test/i18n/de.json"]}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(screen.getByLabelText("Export readiness")).toHaveTextContent(
      "8currently eligible",
    );
    expect(screen.getByLabelText("Export readiness")).toHaveTextContent(
      "2currently open",
    );
    expect(screen.getByLabelText("Export readiness")).toHaveTextContent(
      "1currently changed",
    );
    expect(screen.getByLabelText("Export readiness")).toHaveTextContent(
      "2currently in review",
    );
    expect(
      screen.getByText("E:/Fixtures/Mods/Test/i18n/de.json"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /3 included strings are not Done: 1 Changed and 2 in Review/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/blocker preflight is unavailable/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Counts above describe the current scan/),
    ).toBeInTheDocument();
    expect(screen.queryByText("Unavailable before export")).toBeNull();
  });

  it("keeps unavailable current-scan aggregates explicit", () => {
    render(
      <ExportConfirmDialog
        modName="Test Mod"
        existingFiles={1}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(screen.getAllByText("Unavailable")).toHaveLength(5);
    expect(screen.getByText("Unavailable before export")).toBeInTheDocument();
    expect(screen.getByText(/aggregates are unavailable/)).toBeInTheDocument();
  });

  it("does not claim Ready while protected-token preflight is unavailable", () => {
    render(
      <ExportConfirmDialog
        modName="Test Mod"
        existingFiles={0}
        newFiles={1}
        willWrite={8}
        openOmitted={0}
        changedIncluded={0}
        reviewIncluded={0}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(screen.queryByText(/Ready to export/)).toBeNull();
    expect(
      screen.getByText(/Export readiness · Unavailable/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export" })).toBeEnabled();
  });

  it("blocks export and opens a supplied backend validation problem", () => {
    const inspect = vi.fn();
    const confirm = vi.fn();
    render(
      <ExportConfirmDialog
        modName="Test Mod"
        existingFiles={1}
        blockingProblem={{
          key: "status.saved",
          reason: "is missing {{saveName}}",
        }}
        onInspectProblem={inspect}
        onConfirm={confirm}
        onCancel={() => {}}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Export and replace" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Open issue" }));
    expect(inspect).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("calls the selected action", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ExportConfirmDialog
        modName="Test Mod"
        existingFiles={2}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Export and replace" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("closes with Escape without treating the backdrop as an action", () => {
    const onCancel = vi.fn();
    const { container } = render(
      <ExportConfirmDialog
        modName="Test Mod"
        existingFiles={0}
        onConfirm={() => {}}
        onCancel={onCancel}
      />,
    );

    fireEvent.mouseDown(container.querySelector(".stv3-flow-overlay")!);
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.keyDown(
      screen.getByRole("dialog", { name: "Confirm export overwrite" }),
      { key: "Escape" },
    );
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
