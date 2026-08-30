import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";

import type { LlmImportPreflight } from "../tauri/commands";
import { ImportBatchDialog } from "./ImportBatchDialog";

const READY_PREFLIGHT: LlmImportPreflight = {
  batchModUniqueId: "Test.Mod",
  batchTargetLang: "de",
  selectedModUniqueId: "Test.Mod",
  selectedTargetLang: "de",
  modMatches: true,
  languageMatches: true,
  snapshotResult: "matched",
  suppliedStrings: 2,
  matchedStrings: 2,
  preservedLocal: 0,
  skippedEmpty: 0,
  identicalToSource: 0,
  importable: 2,
  protectedTokenIssues: [],
  ready: true,
  blockingReason: null,
};

function preflight(
  overrides: Partial<LlmImportPreflight> = {},
): LlmImportPreflight {
  return { ...READY_PREFLIGHT, ...overrides };
}

function renderDialog(
  overrides: Partial<React.ComponentProps<typeof ImportBatchDialog>> = {},
) {
  const props: React.ComponentProps<typeof ImportBatchDialog> = {
    targetName: "Test Mod",
    targetLanguage: "German (de)",
    onChooseFile: vi.fn().mockResolvedValue(null),
    onPreflight: vi.fn().mockResolvedValue(READY_PREFLIGHT),
    onImport: vi.fn().mockResolvedValue(undefined),
    onClose: vi.fn(),
    ...overrides,
  };

  render(<ImportBatchDialog {...props} />);
  return props;
}

describe("ImportBatchDialog", () => {
  it("keeps the current empty state when the native picker is cancelled", async () => {
    const onChooseFile = vi.fn().mockResolvedValue(null);
    renderDialog({ onChooseFile });

    const choose = screen.getByRole("button", { name: /Choose file/ });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Cancel import" }),
      ).toHaveFocus(),
    );
    expect(screen.getByRole("button", { name: "Import file" })).toBeDisabled();

    fireEvent.click(choose);

    await waitFor(() => expect(onChooseFile).toHaveBeenCalledOnce());
    expect(screen.getByText("No file selected")).toBeVisible();
    expect(screen.getByRole("button", { name: "Import file" })).toBeDisabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the chosen native path and imports that exact file", async () => {
    const path = "C:\\Temp\\Test Mod.de.llm-result.json";
    const onChooseFile = vi.fn().mockResolvedValue(path);
    const onPreflight = vi.fn().mockResolvedValue(READY_PREFLIGHT);
    const onImport = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    renderDialog({ onChooseFile, onPreflight, onImport, onClose });

    fireEvent.click(screen.getByRole("button", { name: /Choose file/ }));
    expect(
      await screen.findByText("Test Mod.de.llm-result.json"),
    ).toBeVisible();
    expect(screen.getByText(path)).toBeVisible();
    expect(await screen.findByText("Ready to import")).toBeVisible();
    expect(onPreflight).toHaveBeenCalledWith(path);
    expect(screen.getByText("2 / 2")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Import file" }));

    await waitFor(() => expect(onImport).toHaveBeenCalledWith(path));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows a dropped invalid path inline and keeps confirmation disabled", () => {
    const onImport = vi.fn();
    const path = "C:\\Temp\\result.txt";
    const { container } = render(
      <ImportBatchDialog
        targetName="Test Mod"
        targetLanguage="German (de)"
        initialPath={path}
        initialError="Invalid file type. Exactly one JSON batch file is required."
        onChooseFile={vi.fn().mockResolvedValue(null)}
        onPreflight={vi.fn().mockResolvedValue(READY_PREFLIGHT)}
        onImport={onImport}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText(path)).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("Invalid file type");
    expect(screen.getByRole("button", { name: "Import file" })).toBeDisabled();
    expect(
      container.querySelector("[data-import-valid='false']"),
    ).not.toBeNull();
    expect(onImport).not.toHaveBeenCalled();
  });

  it("keeps the dialog open and reports a native picker error", async () => {
    const onChooseFile = vi.fn().mockRejectedValue(new Error("picker failed"));
    const onClose = vi.fn();
    renderDialog({ onChooseFile, onClose });

    fireEvent.click(screen.getByRole("button", { name: /Choose file/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Error: picker failed",
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Import file" })).toBeDisabled();
  });

  it("reports an import error without closing and restores the actions", async () => {
    const onImport = vi.fn().mockRejectedValue(new Error("invalid batch"));
    const onClose = vi.fn();
    renderDialog({
      initialPath: "C:\\Temp\\invalid.llm-result.json",
      onImport,
      onClose,
    });

    expect(await screen.findByText("Ready to import")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Import file" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Error: invalid batch",
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Import file" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("contains Escape while the confirmed import is pending", async () => {
    let finishImport!: () => void;
    const onImport = vi.fn(
      () => new Promise<void>((resolve) => (finishImport = resolve)),
    );
    const onClose = vi.fn();
    renderDialog({
      initialPath: "C:\\Temp\\batch.json",
      onImport,
      onClose,
    });

    expect(await screen.findByText("Ready to import")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Import file" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Import LLM batch",
    });
    expect(screen.getByRole("button", { name: "Importing…" })).toBeDisabled();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    finishImport();
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("closes without importing from both cancel controls", () => {
    const onImport = vi.fn();
    const onClose = vi.fn();
    const { unmount } = render(
      <ImportBatchDialog
        targetName="Test Mod"
        targetLanguage="German (de)"
        initialPath="C:\\Temp\\batch.json"
        onChooseFile={vi.fn().mockResolvedValue(null)}
        onPreflight={vi.fn().mockResolvedValue(READY_PREFLIGHT)}
        onImport={onImport}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onImport).not.toHaveBeenCalled();

    unmount();
    renderDialog({ onImport, onClose });
    fireEvent.click(screen.getByRole("button", { name: "Cancel import" }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onImport).not.toHaveBeenCalled();
  });

  it("traps focus, contains keyboard events, closes on Escape, and restores focus", async () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const bubbled = vi.fn();
    document.body.addEventListener("keydown", bubbled);
    const onClose = vi.fn();
    const { unmount } = render(
      <ImportBatchDialog
        targetName="Test Mod"
        targetLanguage="German (de)"
        initialPath="C:\\Temp\\batch.json"
        onChooseFile={vi.fn().mockResolvedValue(null)}
        onPreflight={vi.fn().mockResolvedValue(READY_PREFLIGHT)}
        onImport={vi.fn().mockResolvedValue(undefined)}
        onClose={onClose}
      />,
    );

    expect(await screen.findByText("Ready to import")).toBeVisible();
    const first = screen.getByRole("button", { name: "Cancel import" });
    const last = screen.getByRole("button", { name: "Import file" });
    await waitFor(() => expect(first).toHaveFocus());
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(first).toHaveFocus();
    expect(bubbled).not.toHaveBeenCalled();

    fireEvent.keyDown(first, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    unmount();
    expect(trigger).toHaveFocus();

    document.body.removeEventListener("keydown", bubbled);
    trigger.remove();
  });

  it("offers the exact matching mod only when canSwitchToMatchingMod allows it", async () => {
    const path = "C:\\Temp\\other-mod.llm-result.json";
    const onChooseFile = vi.fn().mockResolvedValue(path);
    const canSwitchToMatchingMod = vi.fn(
      (modUniqueId: string) => modUniqueId === "Author.MatchingMod",
    );
    const onSwitchToMatchingMod = vi.fn();
    renderDialog({
      onChooseFile,
      onPreflight: vi.fn().mockResolvedValue(
        preflight({
          batchModUniqueId: "Author.MatchingMod",
          selectedModUniqueId: "Author.CurrentMod",
          modMatches: false,
          ready: false,
          blockingReason: "This batch belongs to another mod.",
        }),
      ),
      canSwitchToMatchingMod,
      onSwitchToMatchingMod,
    });

    fireEvent.click(screen.getByRole("button", { name: /Choose file/ }));

    expect(await screen.findByText("Import blocked")).toBeVisible();
    expect(canSwitchToMatchingMod).toHaveBeenCalledWith("Author.MatchingMod");
    expect(screen.getByRole("button", { name: "Import file" })).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", { name: "Switch to matching mod" }),
    );
    expect(onSwitchToMatchingMod).toHaveBeenCalledWith("Author.MatchingMod");
  });

  it("does not offer a switch when the exact batch mod is unavailable", async () => {
    const canSwitchToMatchingMod = vi.fn().mockReturnValue(false);
    renderDialog({
      initialPath: "C:\\Temp\\missing-mod.llm-result.json",
      onPreflight: vi.fn().mockResolvedValue(
        preflight({
          batchModUniqueId: "Author.NotInstalled",
          selectedModUniqueId: "Author.CurrentMod",
          modMatches: false,
          ready: false,
          blockingReason: "This batch belongs to another mod.",
        }),
      ),
      canSwitchToMatchingMod,
      onSwitchToMatchingMod: vi.fn(),
    });

    expect(await screen.findByText("Import blocked")).toBeVisible();
    expect(canSwitchToMatchingMod).toHaveBeenCalledWith("Author.NotInstalled");
    expect(
      screen.queryByRole("button", { name: "Switch to matching mod" }),
    ).not.toBeInTheDocument();
  });
});
