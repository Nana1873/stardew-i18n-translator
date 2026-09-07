import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import type { ScannedMod } from "../tauri/commands";
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));
import { ManualTranslationImport } from "./ManualTranslationImport";

it("imports all secure ZIP components before closing and leaves unmatched files visible", async () => {
  const imported = vi.fn().mockResolvedValue(undefined),
    complete = vi.fn();
  invoke.mockImplementation(async (command: string) => {
    if (command === "nexus_pick_archive")
      return { archiveId: "bundle", files: [] };
    if (command === "nexus_resolve_archive")
      return {
        mappings: ["Code", "Content"].map((id) => ({
          archiveId: "bundle",
          archivePath: `${id}/i18n/de.json`,
          modUniqueId: id,
          relativeDir: "i18n",
        })),
        unresolved: [
          {
            archivePath: "Unknown/i18n/de.json",
            reason: "No installed component matches.",
          },
        ],
      };
    if (command === "nexus_preflight_import") return { importable: 1 };
    if (command === "nexus_import_translation")
      return { imported: 1, conflicts: 0 };
  });
  render(
    <ManualTranslationImport
      mod={
        {
          uniqueId: "Frontier",
          name: "Frontier Farm",
          i18nFiles: [{ relativeDir: "i18n" }],
        } as ScannedMod
      }
      language="de"
      context="fixture"
      disabled={false}
      onBusy={() => {}}
      onImported={imported}
      onComplete={complete}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Choose translation ZIP…" }),
  );
  await screen.findByText(/2 components imported. 1 files need attention/);
  expect(
    invoke.mock.calls
      .filter(([cmd]) => cmd === "nexus_import_translation")
      .map(([, args]) => args.modUniqueId),
  ).toEqual(["Code", "Content"]);
  await waitFor(() => expect(imported).toHaveBeenCalledOnce());
  expect(complete).not.toHaveBeenCalled();
  expect(invoke).toHaveBeenCalledWith("nexus_resolve_archive", {
    archiveId: "bundle",
    sourceModIds: ["Frontier"],
  });
  expect(screen.queryByRole("combobox")).toBeNull();
});
