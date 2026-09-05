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
  onImported = vi.fn().mockResolvedValue(undefined),
  scanned = mods,
  initialSearch: NexusSearchState = search,
  vortexExecutable: string | null = "C:/Tools/Vortex/Vortex.exe",
) {
  let skipped: SkippedComponent[] = [];
  let traversalComplete: boolean | undefined = true;
  const onOpenReview = vi.fn();
  const onSearch = vi.fn();
  const onCheckInstalled = vi.fn().mockResolvedValue(undefined);
  const view = (open: boolean, data = initialSearch) => (
    <NexusDialog
      open={open}
      search={data}
      mods={scanned}
      skippedComponents={skipped}
      traversalComplete={traversalComplete}
      targetLang="de"
      onSearch={onSearch}
      vortexExecutable={vortexExecutable}
      onCheckInstalled={onCheckInstalled}
      onCancel={() => {}}
      onClose={() => {}}
      onConfigure={() => {}}
      onImported={onImported}
      onOpenReview={onOpenReview}
    />
  );
  const rendered = render(view(true));
  return {
    onImported,
    setTraversal: (next: boolean | undefined) => {
      traversalComplete = next;
      rendered.rerender(view(true));
    },
    setSkipped: (next: SkippedComponent[]) => {
      skipped = next;
      rendered.rerender(view(true));
    },
    onOpenReview,
    onSearch,
    onCheckInstalled,
    setMods: (next: ScannedMod[]) => {
      scanned = next;
      rendered.rerender(view(true));
    },
    unmount: rendered.unmount,
    setSearch: (data: NexusSearchState) => rendered.rerender(view(true, data)),
    setOpen: (open: boolean) => rendered.rerender(view(open)),
  };
}
function translationRow() {
  return within(screen.getByRole("row", { name: "Canonical title" }));
}
function importCandidate() {
  fireEvent.click(translationRow().getByText("Details & personal import"));
  fireEvent.click(
    translationRow().getByRole("button", { name: "Import to Review instead" }),
  );
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
  invoke.mockImplementation((cmd: string) => {
    if (cmd === "nexus_status")
      return Promise.resolve({
        configured: true,
        validated: true,
        premium: true,
      });
    if (cmd === "nexus_handoff_to_vortex")
      return Promise.resolve({
        modId: 30342,
        fileId: 7,
        status: "handoff-requested",
      });
    if (cmd === "nexus_list_files") return Promise.resolve([file]);
    if (cmd === "nexus_download_preflight") return Promise.resolve(archive);
    if (cmd === "nexus_preflight_import") return Promise.resolve(counts);
    if (cmd === "nexus_import_translation")
      return Promise.resolve({ ...counts, imported: 1 });
    return Promise.resolve(null);
  });
});
afterEach(() => vi.restoreAllMocks());

it("imports through explicit secondary personal details, validates before saving, and retains the inline receipt on reopen", async () => {
  const app = mount();
  expect(invoke).not.toHaveBeenCalled();
  expect(
    screen.getByText(/4 fully translated mod groups skipped/),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", {
      name: /View files|Choose source|Check import/,
    }),
  ).not.toBeInTheDocument();
  importCandidate();
  await waitFor(() => expect(app.onImported).toHaveBeenCalledOnce());
  expect(
    translationRow().getByText(
      /imported to Review this session|No new strings added/,
    ),
  ).toHaveTextContent(
    "1 imported to Review this session · 1 existing values kept · 1 token errors",
  );
  const commands = invoke.mock.calls.map(([cmd]) => cmd);
  expect(commands.indexOf("nexus_preflight_import")).toBeLessThan(
    commands.indexOf("nexus_import_translation"),
  );
  expect(invoke).toHaveBeenCalledWith("nexus_import_translation", {
    archiveId: "archive",
    archivePath: "i18n/de.json",
    modUniqueId: "sample.mod",
    relativeDir: "i18n",
  });
  expect(commands.some((cmd) => /export/.test(cmd))).toBe(false);
  app.setOpen(false);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  app.setOpen(true);
  expect(
    translationRow().getByText(
      /imported to Review this session|No new strings added/,
    ),
  ).toHaveTextContent("1 imported to Review");
  fireEvent.click(
    translationRow().getByRole("button", { name: "Open Review" }),
  );
  expect(app.onOpenReview).toHaveBeenCalledWith("sample.mod");
});

it("asks inline only when ZIP variants are genuinely ambiguous", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((cmd: string, ...args: unknown[]) =>
    cmd === "nexus_list_files"
      ? Promise.resolve([
          { ...file, name: "German full" },
          {
            ...file,
            fileId: 8,
            name: "German lite",
            fileName: "german-lite.zip",
          },
        ])
      : original(cmd, ...args),
  );
  mount();
  importCandidate();
  const choice = await screen.findByLabelText(
    "Archive variant for German translation",
  );
  expect(
    invoke.mock.calls.some(([cmd]) => cmd === "nexus_download_preflight"),
  ).toBe(false);
  fireEvent.change(choice, { target: { value: "8" } });
  fireEvent.click(
    screen.getByRole("button", { name: "Import selected ZIP to Review" }),
  );
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("nexus_download_preflight", {
      modId: 30342,
      fileId: 8,
    }),
  );
  await waitFor(() =>
    expect(
      translationRow().getByText(
        /imported to Review this session|No new strings added/,
      ),
    ).toHaveTextContent("1 imported to Review"),
  );
});

it("keeps translated default.json confirmation inline and does not save before it", async () => {
  archive.files = [
    {
      path: "i18n/default.json",
      manifestUniqueId: "sample.mod",
      isDefault: true,
    },
  ];
  mount();
  importCandidate();
  const confirm = await screen.findByRole("checkbox", {
    name: /This default.json contains de translation text/,
  });
  expect(
    invoke.mock.calls.some(([cmd]) => cmd === "nexus_preflight_import"),
  ).toBe(false);
  expect(
    screen.getByRole("button", { name: "Import selected text" }),
  ).toBeDisabled();
  fireEvent.click(confirm);
  fireEvent.click(screen.getByRole("button", { name: "Import selected text" }));
  await waitFor(() =>
    expect(
      translationRow().getByText(
        /imported to Review this session|No new strings added/,
      ),
    ).toHaveTextContent("1 imported to Review"),
  );
});

it("shows zero new strings without attempting a save when native preflight has nothing importable", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((cmd: string, ...args: unknown[]) =>
    cmd === "nexus_preflight_import"
      ? Promise.resolve({ ...counts, importable: 0 })
      : original(cmd, ...args),
  );
  mount();
  importCandidate();
  await waitFor(() =>
    expect(
      translationRow().getByText(
        /imported to Review this session|No new strings added/,
      ),
    ).toHaveTextContent("No new strings added · 1 existing values kept"),
  );
  expect(
    invoke.mock.calls.some(([cmd]) => cmd === "nexus_import_translation"),
  ).toBe(false);
});

it("retains confirmed partial imports if a later component fails", async () => {
  archive.files.push({
    path: "Second/i18n/de.json",
    manifestUniqueId: "sample.second",
    isDefault: false,
  });
  const second = {
    ...mods[0],
    uniqueId: "sample.second",
    name: "Second component",
    folderPath: "x/Second",
  };
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((cmd: string, args?: { modUniqueId?: string }) =>
    cmd === "nexus_preflight_import" && args?.modUniqueId === "sample.second"
      ? Promise.reject(new Error("Source changed"))
      : original(cmd, args),
  );
  mount(undefined, [...mods, second]);
  importCandidate();
  await waitFor(() =>
    expect(
      translationRow().getByText(
        /imported to Review this session|No new strings added/,
      ),
    ).toHaveTextContent(
      "1 imported to Review this session · 1 existing values kept · 1 token errors · 1 failed",
    ),
  );
  expect(translationRow().getByRole("alert")).toHaveTextContent(
    "Completed imports were kept",
  );
});

it("reports download failure inline without claiming text was imported", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((cmd: string, ...args: unknown[]) =>
    cmd === "nexus_download_preflight"
      ? Promise.reject(new Error("Network unavailable"))
      : original(cmd, ...args),
  );
  mount();
  importCandidate();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Network unavailable",
  );
  expect(
    invoke.mock.calls.some(([cmd]) => cmd === "nexus_import_translation"),
  ).toBe(false);
});

it("requires a new download when an unresolved inline choice expires", async () => {
  archive.files = [
    {
      path: "i18n/default.json",
      manifestUniqueId: "sample.mod",
      isDefault: true,
    },
  ];
  const app = mount();
  importCandidate();
  await screen.findByRole("checkbox", {
    name: /This default.json contains de translation text/,
  });
  app.setOpen(false);
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16 * 60_000);
  app.setOpen(true);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "temporary ZIP expired",
  );
  expect(
    translationRow().getByRole("button", { name: "Import to Review instead" }),
  ).toBeEnabled();
  expect(
    screen.queryByRole("button", { name: "Import selected text" }),
  ).not.toBeInTheDocument();
});

it("collapses no-candidate mods and retains an optional original-files import", async () => {
  mount();
  const hidden = screen.getByText("1 mods without candidates / search errors");
  expect(hidden.closest("details")).not.toHaveAttribute("open");
  fireEvent.click(hidden);
  const source = within(screen.getByRole("row", { name: "No-result mod" }));
  fireEvent.click(source.getByText("Details & personal import"));
  fireEvent.click(
    source.getByRole("button", { name: "Import to Review instead" }),
  );
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("nexus_list_files", { modId: 99 }),
  );
});

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

function sendAll() {
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Select all available translations" }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: /Send selected to Vortex/ }),
  );
}
it("hands off original IDs without Premium validation or import, retaining receipt and disk comparison on reopen", async () => {
  const app = mount();
  expect(
    screen.queryByLabelText("Translation for Canonical title"),
  ).not.toBeInTheDocument();
  expect(screen.getAllByRole("columnheader").map((x) => x.textContent)).toEqual(
    ["", "Mod", "Translation / file", "Status"],
  );
  sendAll();
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("nexus_handoff_to_vortex", {
      modId: 30342,
      fileId: 7,
    }),
  );
  await screen.findByText("Handoff requested \u00b7 deployment not checked");
  expect(invoke.mock.calls.map(([cmd]) => cmd)).toEqual([
    "nexus_list_files",
    "nexus_handoff_to_vortex",
  ]);
  app.setOpen(false);
  app.setOpen(true);
  expect(
    screen.getByText("Handoff requested \u00b7 deployment not checked"),
  ).toBeInTheDocument();
  app.setMods([
    {
      ...mods[0],
      diskTranslatedKeys: 3,
      translatedKeys: 0,
      stateDiskDifferences: 2,
    },
    mods[1],
  ]);
  fireEvent.click(
    screen.getByRole("button", { name: "Check installed files" }),
  );
  await waitFor(() => expect(app.onCheckInstalled).toHaveBeenCalledOnce());
  await screen.findByText(/On disk: 3\/3 keys/);
  expect(
    screen.getByText(/2 saved values differ from disk; drafts kept/),
  ).toBeInTheDocument();
  expect(app.onSearch).not.toHaveBeenCalled();
  expect(
    screen.getByRole("row", { name: "Canonical title" }),
  ).toBeInTheDocument();
});
it("requires an explicit variant and hands off 7z while refusing a silent different ZIP personal import", async () => {
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
  sendAll();
  fireEvent.change(
    await screen.findByLabelText("Archive variant for German translation"),
    { target: { value: "8" } },
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Send selected to Vortex (1)" }),
  );
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("nexus_handoff_to_vortex", {
      modId: 30342,
      fileId: 8,
    }),
  );
  await screen.findByText("Handoff requested \u00b7 deployment not checked");
  importCandidate();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "selected archive is not a ZIP",
  );
  expect(
    invoke.mock.calls.some(([cmd]) => cmd === "nexus_download_preflight"),
  ).toBe(false);
});
it.each(["stop", "unmount"])(
  "keeps sequential handoff from continuing after %s",
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
    const app = mount(undefined, mods, twoSources);
    sendAll();
    await waitFor(() =>
      expect(
        invoke.mock.calls.filter(([cmd]) => cmd === "nexus_handoff_to_vortex"),
      ).toHaveLength(1),
    );
    if (mode === "unmount") app.unmount();
    else
      fireEvent.click(
        screen.getByRole("button", { name: "Stop after current" }),
      );
    await act(async () => finish({ status: "handoff-requested" }));
    expect(
      invoke.mock.calls.filter(([cmd]) => cmd === "nexus_list_files"),
    ).toHaveLength(1);
  },
);
it("reports failed launch without a successful handoff receipt", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((cmd: string, ...args: unknown[]) =>
    cmd === "nexus_handoff_to_vortex"
      ? Promise.reject(new Error("Vortex executable not found"))
      : original(cmd, ...args),
  );
  mount();
  sendAll();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Vortex executable not found",
  );
  expect(
    screen.queryByText("Handoff requested \u00b7 deployment not checked"),
  ).not.toBeInTheDocument();
});
it("passes explicit refresh and collection inclusion while clearing selection", () => {
  const app = mount();
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Select Canonical title" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Refresh search" }));
  expect(app.onSearch).toHaveBeenLastCalledWith({
    includeComplete: false,
    forceRefresh: true,
    retainIds: [],
  });
  expect(
    screen.getByRole("button", { name: "Send selected to Vortex (0)" }),
  ).toBeDisabled();
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "Include fully translated mods for Collection curation",
    }),
  );
  expect(app.onSearch).toHaveBeenLastCalledWith({
    includeComplete: true,
    forceRefresh: false,
    retainIds: [],
  });
});

it("keeps a partially scanned group visible and cannot prove complete deployment after recheck", async () => {
  const app = mount();
  sendAll();
  await screen.findByText(/Handoff requested.*deployment not checked/);
  app.setSkipped([
    {
      packageId: "sample",
      componentUniqueId: null,
      componentName: null,
      relativeLocation: "Sample",
      reason: "Malformed manifest",
      requiresAttention: true,
      restOfPackageLoaded: true,
    },
  ]);
  app.setMods([{ ...mods[0], diskTranslatedKeys: 3 }, mods[1]]);
  fireEvent.click(
    screen.getByRole("button", { name: "Check installed files" }),
  );
  await screen.findByText(/Handoff requested.*files rechecked/);
  expect(
    translationRow().getByText("Disk coverage unavailable"),
  ).toBeInTheDocument();
  expect(translationRow().queryByText(/On disk: 3/)).not.toBeInTheDocument();
  expect(app.onSearch).not.toHaveBeenCalled();
});

it("provides the primary Review workflow without Vortex and never writes Mods automatically", async () => {
  const app = mount(undefined, mods, search, null);
  expect(screen.getByLabelText("Destination")).toHaveValue("review");
  expect(
    screen.queryByRole("button", { name: "Check installed files" }),
  ).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Select Canonical title" }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Import selected to Review (1)" }),
  );
  await waitFor(() => expect(app.onImported).toHaveBeenCalledOnce());
  expect(
    screen.getByText(/1 imported to Review this session/).closest("details"),
  ).toBeNull();
  expect(invoke.mock.calls.some(([cmd]) => /handoff|export/.test(cmd))).toBe(
    false,
  );
  fireEvent.change(screen.getByLabelText("Destination"), {
    target: { value: "vortex" },
  });
  expect(
    screen.getByRole("button", { name: "Send selected to Vortex (1)" }),
  ).toBeDisabled();
});
it("freezes selected candidate IDs and destination throughout a Review batch", async () => {
  let finish!: () => void;
  const onImported = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(undefined);
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((cmd: string, args?: { modId?: number }) =>
    cmd === "nexus_download_preflight" && args?.modId === 999
      ? Promise.resolve({
          ...archive,
          files: [
            {
              path: "i18n/de.json",
              manifestUniqueId: "unrelated.mod",
              isDefault: false,
            },
          ],
        })
      : original(cmd, args),
  );
  mount(onImported, mods, twoSources, null);
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Select all available translations" }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Import selected to Review (2)" }),
  );
  await waitFor(() => expect(onImported).toHaveBeenCalledOnce());
  expect(screen.getByLabelText("Destination")).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Destination"), {
    target: { value: "vortex" },
  });
  await act(async () => finish());
  await waitFor(() => expect(onImported).toHaveBeenCalledTimes(2));
  expect(
    invoke.mock.calls
      .filter(([cmd]) => cmd === "nexus_download_preflight")
      .map(([, args]) => args),
  ).toEqual([
    { modId: 30342, fileId: 7 },
    { modId: 999, fileId: 7 },
  ]);
  expect(
    invoke.mock.calls.some(([cmd]) => cmd === "nexus_handoff_to_vortex"),
  ).toBe(false);
});

it("shows one readable single-candidate title and concise dates while leaving details collapsed", () => {
  mount();
  const row = translationRow();
  expect(row.getAllByText(candidate.name, { exact: true })).toHaveLength(1);
  expect(row.getByText("v1.2 \u00b7 1 Jan 2026")).toBeInTheDocument();
  expect(row.queryByRole("combobox")).not.toBeInTheDocument();
  expect(
    row.getByText("Details & personal import").closest("details"),
  ).not.toHaveAttribute("open");
  expect(
    row.queryByText("Latest suitable archive resolved when sending"),
  ).not.toBeInTheDocument();
});
it("exposes alternatives directly with a full title and preserves candidate selection", async () => {
  const alternate = {
    ...candidate,
    modId: 30343,
    name: "German translation for the expanded edition",
  };
  mount(undefined, mods, {
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
  });
  const row = translationRow();
  const choice = row.getByRole("combobox", {
    name: "Translation for Canonical title",
  });
  expect(choice.closest("details")).toBeNull();
  expect(choice).toHaveAttribute("title", candidate.name);
  fireEvent.change(choice, { target: { value: "30343" } });
  expect(choice).toHaveAttribute("title", alternate.name);
  expect(choice).toHaveValue("30343");
  sendAll();
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("nexus_handoff_to_vortex", {
      modId: 30343,
      fileId: 7,
    }),
  );
});
it.each([false, undefined])(
  "does not claim disk coverage after recheck without confirmed traversal (%s)",
  async (complete) => {
    const app = mount();
    sendAll();
    await screen.findByText(/Handoff requested.*deployment not checked/);
    app.setTraversal(complete);
    app.setMods([{ ...mods[0], diskTranslatedKeys: 3 }, mods[1]]);
    fireEvent.click(
      screen.getByRole("button", { name: "Check installed files" }),
    );
    await screen.findByText(/Handoff requested.*files rechecked/);
    expect(
      translationRow().getByText("Disk coverage unavailable"),
    ).toBeInTheDocument();
    expect(translationRow().queryByText(/On disk:/)).not.toBeInTheDocument();
    expect(app.onSearch).not.toHaveBeenCalled();
  },
);
