import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { vi } from "vitest";
import type {
  NexusArchive,
  NexusFile,
  ScannedMod,
  SkippedComponent,
} from "../tauri/commands";
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));
import { NexusDialog } from "./NexusDialog";
import type { NexusSearchState } from "./useNexusSearch";
const counts = {
  matched: 3,
  missing: 2,
  extra: 1,
  empty: 0,
  sourceEqual: 1,
  tokenInvalid: 1,
  conflicts: 1,
  importable: 1,
  notice: "Review against the installed source.",
};
const candidate = {
  modId: 30342,
  name: "German translation",
  version: "1.2",
  summary: "Translation evidence",
  updatedAt: "2026-01-01",
  relationshipTier: "possible-original-translation" as const,
};
const mods = [
  {
    uniqueId: "sample.mod",
    name: "Local mod",
    nexusId: 1,
    packageId: "sample",
    folderPath: "x/Sample",
    totalKeys: 3,
    translatedKeys: 0,
    diskTranslatedKeys: 0,
    stateDiskDifferences: 2,
    i18nFiles: [{ relativeDir: "i18n" }],
  },
  {
    uniqueId: "unrelated.mod",
    name: "Other mod",
    nexusId: 99,
    packageId: "other",
    folderPath: "x/Other",
    i18nFiles: [{ relativeDir: "i18n" }],
  },
] as ScannedMod[];
const search = {
  entries: [
    {
      modId: 99,
      localNames: ["Other mod"],
      result: {
        modId: 99,
        originalName: "No-result mod",
        candidates: [],
        limited: true,
        notice: "Limited search",
      },
    },
    {
      modId: 1,
      localNames: ["Local mod"],
      result: {
        modId: 1,
        originalName: "Canonical title",
        candidates: [candidate],
        limited: true,
        notice: "Limited search",
      },
    },
  ],
  running: false,
  completed: 2,
  total: 2,
  noId: 0,
  skippedComplete: 4,
  cancelled: false,
};
const file: NexusFile = {
  fileId: 7,
  name: "German translation",
  fileName: "german.zip",
  version: "1.2",
  uploadedAt: "2026-01-01",
  category: "MAIN",
  description: "German text",
};
let archive: NexusArchive;
function mount(
  options: {
    mods?: ScannedMod[];
    search?: NexusSearchState;
    method?: "folder" | "vortex";
    executable?: string | null;
    open?: boolean;
  } = {},
) {
  let data = options.mods ?? mods,
    results = options.search ?? search,
    method = options.method,
    executable =
      options.executable === undefined
        ? "C:/Tools/Vortex/Vortex.exe"
        : options.executable,
    open = options.open ?? true;
  let traversal: boolean | undefined = true,
    skipped: SkippedComponent[] = [];
  const onImported = vi.fn().mockResolvedValue(undefined),
    onSearch = vi.fn(),
    onCheckInstalled = vi.fn().mockResolvedValue(undefined),
    onOpenReview = vi.fn();
  const view = () => (
    <NexusDialog
      open={open}
      search={results}
      mods={data}
      targetLang="de"
      installationMethod={method}
      vortexExecutable={executable}
      traversalComplete={traversal}
      skippedComponents={skipped}
      onImported={onImported}
      onSearch={onSearch}
      onCheckInstalled={onCheckInstalled}
      onOpenReview={onOpenReview}
      onClose={() => {}}
      onConfigure={() => {}}
      onCancel={() => {}}
    />
  );
  const rendered = render(view());
  return {
    onImported,
    onSearch,
    onCheckInstalled,
    onOpenReview,
    unmount: rendered.unmount,
    setOpen: (next: boolean) => {
      open = next;
      rendered.rerender(view());
    },
    setMethod: (next: "folder" | "vortex") => {
      method = next;
      rendered.rerender(view());
    },
    setMods: (next: ScannedMod[]) => {
      data = next;
      rendered.rerender(view());
    },
    setTraversal: (next: boolean | undefined) => {
      traversal = next;
      rendered.rerender(view());
    },
    setSearch: (next: NexusSearchState) => {
      results = next;
      rendered.rerender(view());
    },
    setSkipped: (next: SkippedComponent[]) => {
      skipped = next;
      rendered.rerender(view());
    },
  };
}
function commandCalls(name: string) {
  return invoke.mock.calls
    .filter(([cmd]) => cmd === name)
    .map(([, args]) => args);
}
function translationRow() {
  return within(screen.getByRole("row", { name: "Canonical title" }));
}
async function download() {
  const button = screen.getByRole("button", {
    name: /^Download & (install|import) all/,
  });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}
beforeEach(() => {
  archive = {
    archiveId: "archive",
    files: [
      {
        path: "i18n/de.json",
        manifestUniqueId: "sample.mod",
        isDefault: false,
      },
    ],
    notice: "Inspected",
  };
  invoke.mockReset();
  invoke.mockImplementation(
    (cmd: string, args?: { modId?: number; fileId?: number }) => {
      if (cmd === "nexus_list_files") return Promise.resolve([file]);
      if (cmd === "nexus_status")
        return Promise.resolve({ configured: true, premium: true });
      if (cmd === "nexus_handoff_to_vortex")
        return Promise.resolve({ ...args, status: "handoff-requested" });
      if (cmd === "nexus_download_preflight") return Promise.resolve(archive);
      if (cmd === "nexus_preflight_import") return Promise.resolve(counts);
      if (cmd === "nexus_import_translation")
        return Promise.resolve({ ...counts, imported: 1 });
      return Promise.resolve(null);
    },
  );
});
afterEach(() => vi.restoreAllMocks());

it("loads only candidate metadata before any action, without selection checkboxes or destination controls", async () => {
  mount();
  await screen.findByRole("row", { name: "Canonical title" });
  expect(commandCalls("nexus_list_files")).toEqual([{ modId: 30342 }]);
  expect(invoke.mock.calls.map(([cmd]) => cmd)).toEqual(["nexus_list_files"]);
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  expect(screen.getAllByRole("columnheader").map((x) => x.textContent)).toEqual(
    ["Installed mod", "Translation file / version"],
  );
  expect(
    translationRow().getByText("v1.2 \u00b7 1 Jan 2026"),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Check installed files" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("Details")).not.toBeInTheDocument();
  expect(screen.queryByText("Ready")).not.toBeInTheDocument();
  fireEvent.click(
    translationRow().getByRole("button", { name: "Open Nexus Link" }),
  );
  expect(commandCalls("open_url")).toEqual([
    { url: "https://www.nexusmods.com/stardewvalley/mods/30342?tab=files" },
  ]);
});
it("includes all ready rows automatically and never redownloads a completed handoff", async () => {
  const app = mount();
  await download();
  await screen.findByText("1 sent to Vortex");
  expect(commandCalls("nexus_handoff_to_vortex")).toEqual([
    { modId: 30342, fileId: 7 },
  ]);
  expect(commandCalls("nexus_list_files")).toHaveLength(1);
  expect(commandCalls("nexus_status")).toHaveLength(0);
  expect(
    screen.getByRole("button", {
      name: "Download & install all with Vortex (0)",
    }),
  ).toBeDisabled();
  app.setOpen(false);
  app.setOpen(true);
  expect(screen.getByText("1 sent to Vortex")).toBeInTheDocument();
  expect(commandCalls("nexus_list_files")).toHaveLength(1);
});
it("routes an explicit folder installation to Review even if Vortex is configured", async () => {
  const app = mount({ method: "folder" });
  await download();
  await waitFor(() => expect(app.onImported).toHaveBeenCalledOnce());
  expect(commandCalls("nexus_download_preflight")).toEqual([
    { modId: 30342, fileId: 7 },
  ]);
  expect(commandCalls("nexus_handoff_to_vortex")).toHaveLength(0);
  expect(
    screen.getByRole("button", { name: "Download & import all (0)" }),
  ).toBeDisabled();
  expect(
    invoke.mock.calls.some(([cmd]) => /export|save_settings/.test(cmd)),
  ).toBe(false);
  expect(screen.getByRole("status")).toHaveTextContent("1 imported to Review");
});
it("defaults legacy installations without Vortex to folder import", async () => {
  const app = mount({ executable: null });
  await download();
  await waitFor(() => expect(app.onImported).toHaveBeenCalledOnce());
  expect(screen.queryByText("Destination")).not.toBeInTheDocument();
});
it("requires an inline choice for genuine variants and sends exactly that version without another file request", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((cmd: string, ...args: unknown[]) =>
    cmd === "nexus_list_files"
      ? Promise.resolve([
          { ...file, name: "German full" },
          {
            ...file,
            fileId: 8,
            name: "German lite",
            fileName: "german-lite.7z",
          },
        ])
      : original(cmd, ...args),
  );
  mount();
  const choice = await screen.findByRole("combobox", {
    name: "Translation file for Canonical title",
  });
  expect(choice).toHaveValue("");
  expect(choice.closest("details")).toBeNull();
  expect(
    screen.getByRole("button", {
      name: "Download & install all with Vortex (0)",
    }),
  ).toBeDisabled();
  fireEvent.change(choice, { target: { value: "30342:8" } });
  await download();
  await screen.findByText("1 sent to Vortex");
  expect(commandCalls("nexus_handoff_to_vortex")).toEqual([
    { modId: 30342, fileId: 8 },
  ]);
  expect(commandCalls("nexus_list_files")).toHaveLength(1);
  expect(commandCalls("nexus_download_preflight")).toHaveLength(0);
});
it("keeps current older versions selectable while recommending the newest same-series file", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((cmd: string, ...args: unknown[]) =>
    cmd === "nexus_list_files"
      ? Promise.resolve([
          file,
          { ...file, fileId: 8, version: "1.3", uploadedAt: "2026-02-01" },
        ])
      : original(cmd, ...args),
  );
  mount();
  const choice = await screen.findByRole("combobox", {
    name: "Translation file for Canonical title",
  });
  expect(choice).toHaveValue("30342:8");
  fireEvent.change(choice, { target: { value: "30342:7" } });
  await download();
  await screen.findByText("1 sent to Vortex");
  expect(commandCalls("nexus_handoff_to_vortex")).toEqual([
    { modId: 30342, fileId: 7 },
  ]);
});
it("combines candidates and files into one selector with candidate group labels", async () => {
  const alternate = {
    ...candidate,
    modId: 50,
    name: "Alternative German translation",
  };
  mount({
    search: {
      ...search,
      entries: [
        {
          ...search.entries[1],
          result: {
            ...search.entries[1].result,
            candidates: [candidate, alternate],
          },
        },
      ],
    },
  });
  const choice = await screen.findByRole("combobox", {
    name: "Translation file for Canonical title",
  });
  expect(choice.querySelectorAll("optgroup")).toHaveLength(2);
  fireEvent.change(choice, { target: { value: "50:7" } });
  await download();
  await screen.findByText("1 sent to Vortex");
  expect(commandCalls("nexus_handoff_to_vortex")).toEqual([
    { modId: 50, fileId: 7 },
  ]);
});
it("does not list candidates with no eligible files or original mods without translation candidates", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((cmd: string, ...args: unknown[]) =>
    cmd === "nexus_list_files"
      ? Promise.resolve([{ ...file, category: "ARCHIVED" }])
      : original(cmd, ...args),
  );
  mount();
  await screen.findByText("No suitable translation downloads found.");
  expect(screen.queryByRole("row")).not.toBeInTheDocument();
  expect(commandCalls("nexus_list_files")).toEqual([{ modId: 30342 }]);
  expect(commandCalls("nexus_handoff_to_vortex")).toHaveLength(0);
});
it("does not call failed or pending metadata downloadable and allows an explicit retry", async () => {
  const original = invoke.getMockImplementation()!;
  let failed = true;
  invoke.mockImplementation((cmd: string, ...args: unknown[]) =>
    cmd === "nexus_list_files" && failed
      ? Promise.reject(new Error("Metadata unavailable"))
      : original(cmd, ...args),
  );
  mount();
  await screen.findByText("No downloadable files could be confirmed.");
  expect(
    screen.getByRole("button", {
      name: "Download & install all with Vortex (0)",
    }),
  ).toBeDisabled();
  fireEvent.click(screen.getByText("Error details"));
  expect(screen.getByText(/Metadata unavailable/)).toBeInTheDocument();
  failed = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry file metadata" }));
  await screen.findByRole("row", { name: "Canonical title" });
  expect(commandCalls("nexus_handoff_to_vortex")).toHaveLength(0);
});
it("requires explicit retry after a failed action", async () => {
  const original = invoke.getMockImplementation()!;
  let failed = true;
  invoke.mockImplementation((cmd: string, ...args: unknown[]) =>
    cmd === "nexus_handoff_to_vortex" && failed
      ? Promise.reject(new Error("Launch failed"))
      : original(cmd, ...args),
  );
  mount();
  await download();
  expect(await screen.findByRole("alert")).toHaveTextContent("Launch failed");
  expect(
    screen.getByRole("button", {
      name: "Download & install all with Vortex (0)",
    }),
  ).toBeDisabled();
  failed = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("1 sent to Vortex");
  expect(commandCalls("nexus_handoff_to_vortex")).toHaveLength(2);
});
it("keeps default.json confirmation inline and never changes the English source", async () => {
  archive.files = [
    {
      path: "i18n/default.json",
      manifestUniqueId: "sample.mod",
      isDefault: true,
    },
  ];
  const app = mount({ method: "folder" });
  await download();
  const confirm = await screen.findByRole("checkbox", {
    name: /This default.json contains de translation text/,
  });
  expect(commandCalls("nexus_preflight_import")).toHaveLength(0);
  expect(
    screen.getByRole("button", { name: "Import selected text" }),
  ).toBeDisabled();
  fireEvent.click(confirm);
  fireEvent.click(screen.getByRole("button", { name: "Import selected text" }));
  await waitFor(() => expect(app.onImported).toHaveBeenCalledOnce());
  expect(commandCalls("nexus_import_translation")[0]).toMatchObject({
    archivePath: "i18n/default.json",
    modUniqueId: "sample.mod",
  });
});
it("shows zero new strings without saving when preflight finds no importable strings", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((cmd: string, ...args: unknown[]) =>
    cmd === "nexus_preflight_import"
      ? Promise.resolve({ ...counts, importable: 0 })
      : original(cmd, ...args),
  );
  mount({ method: "folder" });
  await download();
  await screen.findByText("0 imported to Review");
  expect(commandCalls("nexus_import_translation")).toHaveLength(0);
});
it("rechecks local disk without refreshing metadata or losing drafts and receipts", async () => {
  const app = mount();
  await download();
  await screen.findByText("1 sent to Vortex");
  app.setMods([{ ...mods[0], diskTranslatedKeys: 3 }, mods[1]]);
  fireEvent.click(
    screen.getByRole("button", { name: "Check installed files" }),
  );
  await screen.findByText("1 sent to Vortex · files rechecked");
  fireEvent.click(translationRow().getByText("Details"));
  expect(translationRow().getByText(/On disk: 3\/3 keys/)).toBeInTheDocument();
  expect(
    translationRow().getByText(/2 saved values differ from disk; drafts kept/),
  ).toBeInTheDocument();
  expect(commandCalls("nexus_list_files")).toHaveLength(1);
  expect(app.onSearch).not.toHaveBeenCalled();
});
it.each([false, undefined])(
  "does not claim complete coverage after a recheck with traversal %s",
  async (traversal) => {
    const app = mount();
    await download();
    await screen.findByText("1 sent to Vortex");
    app.setTraversal(traversal);
    app.setMods([{ ...mods[0], diskTranslatedKeys: 3 }, mods[1]]);
    fireEvent.click(
      screen.getByRole("button", { name: "Check installed files" }),
    );
    await screen.findByText("1 sent to Vortex · files rechecked");
    fireEvent.click(translationRow().getByText("Details"));
    expect(
      translationRow().getByText("Disk coverage unavailable"),
    ).toBeInTheDocument();
  },
);
const twoSources: NexusSearchState = {
  ...search,
  entries: [
    search.entries[1],
    {
      ...search.entries[0],
      result: {
        ...search.entries[0].result,
        candidates: [{ ...candidate, modId: 999, name: "Second translation" }],
      },
    },
  ],
};
it.each(["stop", "unmount", "method"])(
  "stops remaining batch actions after %s",
  async (mode) => {
    let finish!: (value: unknown) => void;
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation((cmd: string, ...args: unknown[]) =>
      cmd === "nexus_handoff_to_vortex"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : original(cmd, ...args),
    );
    const app = mount({ search: twoSources });
    await download();
    await waitFor(() =>
      expect(commandCalls("nexus_handoff_to_vortex")).toHaveLength(1),
    );
    if (mode === "unmount") app.unmount();
    else if (mode === "method") app.setMethod("folder");
    else
      fireEvent.click(
        screen.getByRole("button", { name: "Stop after current" }),
      );
    await act(async () => finish({ status: "handoff-requested" }));
    expect(commandCalls("nexus_handoff_to_vortex")).toHaveLength(1);
    expect(commandCalls("nexus_download_preflight")).toHaveLength(0);
  },
);
it("reloads eligible versions on method change and discards an invalid prior 7z selection", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((cmd: string, ...args: unknown[]) =>
    cmd === "nexus_list_files"
      ? Promise.resolve([
          { ...file, name: "German full", fileName: "german-full.7z" },
          {
            ...file,
            fileId: 8,
            name: "German lite",
            fileName: "german-lite.zip",
          },
        ])
      : original(cmd, ...args),
  );
  const app = mount();
  const choice = await screen.findByRole("combobox", {
    name: "Translation file for Canonical title",
  });
  fireEvent.change(choice, { target: { value: "30342:7" } });
  app.setMethod("folder");
  await waitFor(() =>
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument(),
  );
  await download();
  await waitFor(() => expect(app.onImported).toHaveBeenCalledOnce());
  expect(commandCalls("nexus_download_preflight")).toEqual([
    { modId: 30342, fileId: 8 },
  ]);
  expect(commandCalls("nexus_handoff_to_vortex")).toHaveLength(0);
});

it("waits for discovery to finish before enabling Download all", async () => {
  const app = mount({ search: { ...search, running: true } });
  await screen.findByRole("row", { name: "Canonical title" });
  expect(
    screen.getByRole("button", {
      name: "Download & install all with Vortex (1)",
    }),
  ).toBeDisabled();
  app.setSearch(search);
  await download();
  await screen.findByText("1 sent to Vortex");
});
it("treats a whitespace executable as unconfigured and offers no per-action routing override", async () => {
  mount({ executable: "   " });
  await screen.findByRole("row", { name: "Canonical title" });
  expect(
    screen.getByRole("button", { name: "Download & import all (1)" }),
  ).toBeEnabled();
  expect(
    screen.queryByRole("button", { name: "Import to Review instead" }),
  ).not.toBeInTheDocument();
});

it("can explicitly redownload an expired mapping confirmation without changing the selected file", async () => {
  archive.files = [
    {
      path: "i18n/default.json",
      manifestUniqueId: "sample.mod",
      isDefault: true,
    },
  ];
  const app = mount({ method: "folder" });
  await download();
  await screen.findByRole("checkbox", {
    name: /This default.json contains de translation text/,
  });
  app.setOpen(false);
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16 * 60_000);
  app.setOpen(true);
  fireEvent.click(
    await screen.findByRole("button", { name: "Download again" }),
  );
  await waitFor(() =>
    expect(commandCalls("nexus_download_preflight")).toHaveLength(2),
  );
  expect(commandCalls("nexus_download_preflight")).toEqual([
    { modId: 30342, fileId: 7 },
    { modId: 30342, fileId: 7 },
  ]);
  expect(commandCalls("nexus_import_translation")).toHaveLength(0);
});

it("counts failed original groups once and never counts pending metadata as no suitable download", async () => {
  const original = invoke.getMockImplementation()!;
  let finish!: (files: NexusFile[]) => void;
  invoke.mockImplementation((cmd: string, args: { modId?: number }) => {
    if (cmd !== "nexus_list_files") return original(cmd, args);
    if (args.modId === 30342)
      return new Promise<NexusFile[]>((resolve) => {
        finish = resolve;
      });
    return Promise.reject(new Error("Metadata unavailable"));
  });
  mount({
    search: {
      ...search,
      completed: 3,
      total: 5,
      cancelled: true,
      noId: 2,
      entries: [
        ...search.entries,
        {
          modId: 2,
          localNames: ["Failed group"],
          result: {
            ...search.entries[1].result,
            modId: 2,
            candidates: [
              { ...candidate, modId: 44 },
              { ...candidate, modId: 45 },
            ],
          },
        },
      ],
    },
  });
  const metric = (label: string) =>
    within(screen.getByRole("region", { name: "Translation search results" }))
      .getByText(label)
      .parentElement?.querySelector("strong")?.textContent;
  await waitFor(() => expect(metric("Checks failed")).toBe("1"));
  expect(metric("No suitable download found")).toBe("1");
  expect(metric("Mods with downloads")).toBe("0");
  expect(metric("IDs checked")).toBe("3/5");
  expect(metric("Fully translated groups skipped")).toBe("4");
  expect(metric("Components without Nexus ID")).toBe("2");
  expect(
    screen.getByText("Search cancelled · results are partial."),
  ).toBeInTheDocument();
  expect(screen.queryByText("No-result mod")).not.toBeInTheDocument();
  await act(async () => finish([file, { ...file, fileId: 8, version: "1.1" }]));
  expect(metric("Mods with downloads")).toBe("1");
  expect(metric("No suitable download found")).toBe("1");
});

it("keeps link failures separate from download eligibility and successful receipts", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((cmd: string, ...args: unknown[]) =>
    cmd === "open_url"
      ? Promise.reject(new Error("Browser unavailable"))
      : original(cmd, ...args),
  );
  mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "Open Nexus Link" }),
  );
  await screen.findByText(/Could not open Nexus Link/);
  expect(
    screen.getByRole("button", {
      name: "Download & install all with Vortex (1)",
    }),
  ).toBeEnabled();
  await download();
  await screen.findByText("1 sent to Vortex");
  fireEvent.click(screen.getByRole("button", { name: "Open Nexus Link" }));
  await screen.findByText(/Could not open Nexus Link/);
  expect(screen.getByText("1 sent to Vortex")).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Retry" }),
  ).not.toBeInTheDocument();
  expect(commandCalls("nexus_handoff_to_vortex")).toHaveLength(1);
});
