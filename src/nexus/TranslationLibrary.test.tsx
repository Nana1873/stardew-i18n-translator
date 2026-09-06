import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { vi } from "vitest";
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));
import { TranslationLibrary } from "./TranslationLibrary";
import type { CommunityLibraryEntry, ScannedMod } from "../tauri/commands";
const mods = ["Orchard", "Workshop"].map((name, index) => ({
  uniqueId: name,
  name,
  packageId: name,
  version: "1",
  nexusId: null,
  folderPath: `fixture/${name}`,
  totalKeys: 3,
  translatedKeys: 0,
  reviewNeeded: 0,
  i18nFiles: [{ relativeDir: "i18n" }],
})) as ScannedMod[];
const entry = (name: string): CommunityLibraryEntry => ({
  modUniqueId: name,
  relativeDir: "i18n",
  archivePath: `${name}/i18n/de.json`,
  strings: 2,
  sourceUrl: null,
});
const openMod = vi.fn(),
  busy = vi.fn();
function Harness({ context = "fixture|de" }: { context?: string }) {
  const [id, setId] = useState("Orchard"),
    [revision, setRevision] = useState(0);
  return (
    <TranslationLibrary
      mods={mods}
      selectedId={id}
      onSelect={setId}
      onOpenMod={openMod}
      language="de"
      context={context}
      revision={revision}
      nexusOpen={false}
      onShowLibrary={() => {}}
      onShowNexus={() => {}}
      nexusPanel={null}
      busy={false}
      onBusy={busy}
      onImported={async () => setRevision((value) => value + 1)}
    />
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  invoke.mockImplementation(async (cmd: string) =>
    cmd === "list_community_library"
      ? [entry("Orchard"), entry("Workshop")]
      : null,
  );
});
it("highlights the selected mod without filtering the library and opens the full editor", async () => {
  render(<Harness />);
  const library = within(
    screen.getByRole("region", { name: "Translation library" }),
  );
  await library.findByText("Orchard");
  expect(library.getByText("Orchard").closest("article")).toHaveClass(
    "is-selected",
  );
  fireEvent.click(
    within(screen.getByRole("region", { name: "Overview mods" })).getByText(
      "Workshop",
    ),
  );
  expect(library.getByText("Orchard")).toBeVisible();
  expect(library.getByText("Workshop").closest("article")).toHaveClass(
    "is-selected",
  );
  fireEvent.click(library.getByText("Workshop"));
  expect(openMod).toHaveBeenCalledWith("Workshop");
});
it("imports a unique manual locale directly and immediately refreshes the library", async () => {
  let imported = false;
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "list_community_library")
      return imported ? [entry("Orchard")] : [];
    if (cmd === "nexus_pick_archive")
      return {
        archiveId: "manual",
        files: [
          {
            path: "i18n/de.json",
            manifestUniqueId: "Orchard",
            isDefault: false,
          },
        ],
        notice: "",
      };
    if (cmd === "nexus_preflight_import") return { importable: 2 };
    if (cmd === "nexus_import_translation") {
      imported = true;
      return { imported: 2, conflicts: 1 };
    }
    return null;
  });
  render(<Harness />);
  await screen.findByText(/No translations imported yet/);
  fireEvent.click(screen.getByText("Import downloaded ZIP"));
  await screen.findByText("2 library strings · i18n");
  expect(invoke).toHaveBeenCalledWith("nexus_import_translation", {
    archiveId: "manual",
    archivePath: "i18n/de.json",
    modUniqueId: "Orchard",
    relativeDir: "i18n",
    communityLibrary: true,
  });
  expect(screen.queryByText("Import selected translation")).toBeNull();
  expect(
    invoke.mock.calls.some(([cmd]) => /handoff|find_translations/.test(cmd)),
  ).toBe(false);
});
it("does not guess default-language or wrong-manifest ZIP content", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((cmd: string, ...args: unknown[]) =>
    cmd === "nexus_pick_archive"
      ? Promise.resolve({
          archiveId: "manual",
          files: [
            {
              path: "i18n/default.json",
              manifestUniqueId: "Orchard",
              isDefault: true,
            },
            {
              path: "i18n/de.json",
              manifestUniqueId: "Different.Mod",
              isDefault: false,
            },
          ],
        })
      : original(cmd, ...args),
  );
  render(<Harness />);
  fireEvent.click(screen.getByText("Import downloaded ZIP"));
  await screen.findByText(/No de.json file matches/);
  expect(
    invoke.mock.calls.some(([cmd]) => cmd === "nexus_import_translation"),
  ).toBe(false);
});
it("discards an old library response after context changes", async () => {
  let resolve!: (entries: CommunityLibraryEntry[]) => void;
  invoke.mockImplementationOnce(
    () =>
      new Promise<CommunityLibraryEntry[]>((done) => {
        resolve = done;
      }),
  );
  const view = render(<Harness />);
  view.rerender(<Harness context="another|de" />);
  await screen.findByText("2 library strings · i18n").catch(() => {});
  await act(async () => resolve([entry("Old context")]));
  expect(screen.queryByText("Old context")).toBeNull();
});
it("builds one combined ZIP and distinguishes creation from deployment", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((cmd: string, ...args: unknown[]) =>
    cmd === "pick_translation_zip_destination"
      ? Promise.resolve("fixture/output.zip")
      : cmd === "build_private_output"
        ? Promise.resolve({
            path: "fixture/output.zip",
            folder: "fixture",
            fileName: "output.zip",
            entries: 2,
            strings: 6,
          })
        : original(cmd, ...args),
  );
  render(<Harness />);
  fireEvent.click(screen.getByText("Build Stardew Translator Output"));
  await screen.findByText(/Created output.zip/);
  expect(invoke).toHaveBeenCalledWith("build_private_output", {
    destination: "fixture/output.zip",
    overwrite: false,
  });
  expect(screen.getByText(/deployment is unverified/)).toBeVisible();
  await waitFor(() => expect(busy).toHaveBeenLastCalledWith(false));
});
