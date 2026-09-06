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
  InstalledNexusTranslation,
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
    installed?: InstalledNexusTranslation[];
    stamp?: () => Promise<string | null>;
    observe?: boolean;
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
  let installed = options.installed;
  let deploymentStamp = "initial";
  const onDeploymentStamp = options.stamp ?? vi.fn(async () => deploymentStamp);
  let blocked = false,
    workspaceKey = "mods",
    targetLang = "de";
  const onImported = vi.fn().mockResolvedValue(undefined),
    onSearch = vi.fn(),
    onCheckInstalled = vi.fn().mockResolvedValue(undefined),
    onOpenReview = vi.fn();
  const view = () => (
    <NexusDialog
      open={open}
      search={results}
      mods={data}
      targetLang={targetLang}
      workspaceKey={workspaceKey}
      recheckBlocked={blocked}
      onDeploymentStamp={
        options.observe === false ? undefined : onDeploymentStamp
      }
      installationMethod={method}
      vortexExecutable={executable}
      traversalComplete={traversal}
      skippedComponents={skipped}
      installedNexusTranslations={installed}
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
    onDeploymentStamp,
    setStamp: (value: string) => {
      deploymentStamp = value;
    },
    changeDeployment: async () => {
      deploymentStamp += "-changed";
      vi.useFakeTimers({ now: Date.now() - 2000 });
      try {
        fireEvent.focus(window);
        for (const duration of [250, 1500, 250])
          await act(async () => {
            await vi.advanceTimersByTimeAsync(duration);
          });
      } finally {
        vi.useRealTimers();
      }
    },
    setBlocked: (next: boolean) => {
      blocked = next;
      rendered.rerender(view());
    },
    setContext: (root: string, language: string) => {
      workspaceKey = root;
      targetLang = language;
      rendered.rerender(view());
    },
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
    setInstalled: (next: InstalledNexusTranslation[] | undefined) => {
      installed = next;
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
  const button = await screen.findByRole("button", {
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
        return Promise.resolve({
          configured: true,
          premium: true,
          validated: true,
        });
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
  expect(
    invoke.mock.calls
      .filter(([cmd]) => cmd !== "nexus_status")
      .map(([cmd]) => cmd),
  ).toEqual(["nexus_list_files"]);
  expect(
    commandCalls("nexus_status").every((args) => args.forceRefresh === false),
  ).toBe(true);
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
it("shows exact local coverage even when saved translations are complete", async () => {
  mount({
    mods: [
      {
        ...mods[0],
        totalKeys: 1000,
        translatedKeys: 1000,
        diskTranslatedKeys: 999,
      },
    ],
  });
  await screen.findByRole("row", { name: "Canonical title" });
  expect(
    translationRow().getByText(
      "Local translation: 999/1000 strings · 1 missing",
    ),
  ).toBeInTheDocument();
  expect(screen.queryByText(/100%|1000\/1000/)).not.toBeInTheDocument();
  expect(commandCalls("nexus_handoff_to_vortex")).toHaveLength(0);
});
it("can recheck an external installation before any handoff without refreshing Nexus", async () => {
  const app = mount();
  await screen.findByRole("row", { name: "Canonical title" });
  app.onCheckInstalled.mockImplementation(async () => {
    app.setMods([{ ...mods[0], diskTranslatedKeys: 3 }]);
  });
  await app.changeDeployment();
  await waitFor(() => expect(app.onCheckInstalled).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(
      screen.queryByRole("row", { name: "Canonical title" }),
    ).not.toBeInTheDocument(),
  );
  expect(commandCalls("nexus_handoff_to_vortex")).toHaveLength(0);
  expect(commandCalls("nexus_list_files")).toHaveLength(1);
  expect(app.onSearch).not.toHaveBeenCalled();
});
it("keeps unknown local coverage distinct from zero or installed before any action", async () => {
  const app = mount();
  app.setTraversal(false);
  await screen.findByRole("row", { name: "Canonical title" });
  expect(
    translationRow().getByText("Local translation coverage unavailable"),
  ).toBeInTheDocument();
  expect(
    translationRow().queryByText(/0\/3|0 missing|installed/i),
  ).not.toBeInTheDocument();
});
const installedFile = { sourceNexusId: 1, modId: 30342, fileId: 7 };
it("excludes a positively deployed exact file despite incomplete local coverage", async () => {
  mount({
    mods: [{ ...mods[0], totalKeys: 1000, diskTranslatedKeys: 999 }],
    installed: [installedFile],
  });
  await screen.findByText("Available translation files are already installed.");
  expect(
    screen.queryByRole("row", { name: "Canonical title" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", {
      name: "Download & install all with Vortex (0)",
    }),
  ).toBeDisabled();
  expect(
    screen.getByText("No download needed").parentElement,
  ).toHaveTextContent("5");
  expect(
    screen.getByText("No suitable download found").parentElement,
  ).toHaveTextContent("1");
  expect(commandCalls("nexus_handoff_to_vortex")).toHaveLength(0);
});
it.each([
  undefined,
  [],
  [{ ...installedFile, sourceNexusId: 99 }],
  [{ ...installedFile, modId: 99 }],
  [{ ...installedFile, fileId: 99 }],
])(
  "keeps the download without exact positive evidence (%j)",
  async (installed) => {
    mount({ installed });
    await screen.findByRole("row", { name: "Canonical title" });
    expect(
      screen.getByRole("button", {
        name: "Download & install all with Vortex (1)",
      }),
    ).toBeEnabled();
    expect(
      screen.queryByText("Available translation files are already installed."),
    ).not.toBeInTheDocument();
  },
);
it("does not filter Review imports using Vortex evidence", async () => {
  mount({ method: "folder", installed: [installedFile] });
  await screen.findByRole("row", { name: "Canonical title" });
  expect(
    screen.getByRole("button", { name: "Download & import all (1)" }),
  ).toBeEnabled();
});
it.each([7, 8])(
  "keeps newer files available without automatically downgrading installed file %i",
  async (installedId) => {
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation((cmd: string, ...args: unknown[]) =>
      cmd === "nexus_list_files"
        ? Promise.resolve([
            file,
            { ...file, fileId: 8, version: "1.3", uploadedAt: "2026-02-01" },
          ])
        : original(cmd, ...args),
    );
    mount({ installed: [{ ...installedFile, fileId: installedId }] });
    await screen.findByRole("row", { name: "Canonical title" });
    const button = screen.getByRole("button", {
      name: /^Download & install all/,
    });
    if (installedId === 8) {
      expect(button).toBeDisabled();
      const choice = screen.getByRole("combobox", {
        name: "Translation file for Canonical title",
      });
      expect(choice).toHaveValue("");
      fireEvent.change(choice, { target: { value: "30342:7" } });
    } else expect(button).toBeEnabled();
    await download();
    await screen.findByText("1 sent to Vortex");
    expect(commandCalls("nexus_handoff_to_vortex")).toEqual([
      { modId: 30342, fileId: installedId === 8 ? 7 : 8 },
    ]);
  },
);
it("replaces deployment evidence on recheck and preserves unknown results", async () => {
  const app = mount();
  await screen.findByRole("row", { name: "Canonical title" });
  app.onCheckInstalled.mockImplementation(async () =>
    app.setInstalled([installedFile]),
  );
  await app.changeDeployment();
  await screen.findByText("Available translation files are already installed.");
  app.setInstalled(undefined);
  await screen.findByRole("row", { name: "Canonical title" });
  expect(
    screen.getByRole("button", {
      name: "Download & install all with Vortex (1)",
    }),
  ).toBeEnabled();
  expect(commandCalls("nexus_list_files")).toHaveLength(1);
  expect(commandCalls("nexus_handoff_to_vortex")).toHaveLength(0);
});
it("does not replace a selected installed file with a different download after recheck", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((cmd: string, ...args: unknown[]) =>
    cmd === "nexus_list_files"
      ? Promise.resolve([
          file,
          { ...file, fileId: 8, version: "1.3", uploadedAt: "2026-02-01" },
        ])
      : original(cmd, ...args),
  );
  const app = mount();
  const choice = await screen.findByRole("combobox", {
    name: "Translation file for Canonical title",
  });
  fireEvent.change(choice, { target: { value: "30342:7" } });
  app.onCheckInstalled.mockImplementation(async () =>
    app.setInstalled([installedFile]),
  );
  await app.changeDeployment();
  const refreshedChoice = await screen.findByRole("combobox", {
    name: "Translation file for Canonical title",
  });
  expect(refreshedChoice).toHaveValue("");
  expect(
    screen.getByRole("button", {
      name: "Download & install all with Vortex (0)",
    }),
  ).toBeDisabled();
  expect(commandCalls("nexus_handoff_to_vortex")).toHaveLength(0);
  fireEvent.change(refreshedChoice, { target: { value: "30342:8" } });
  await download();
  await screen.findByText("1 sent to Vortex");
  expect(commandCalls("nexus_handoff_to_vortex")).toEqual([
    { modId: 30342, fileId: 8 },
  ]);
});
it("applies scan evidence only in Vortex and accepts a replacement scan without evidence", async () => {
  const app = mount({ method: "folder", installed: [installedFile] });
  await screen.findByRole("row", { name: "Canonical title" });
  app.setMethod("vortex");
  await screen.findByText("Available translation files are already installed.");
  app.setInstalled(undefined);
  await screen.findByRole("row", { name: "Canonical title" });
  expect(
    screen.getByRole("button", {
      name: "Download & install all with Vortex (1)",
    }),
  ).toBeEnabled();
});
it("includes all ready rows automatically and never redownloads a completed handoff", async () => {
  const app = mount();
  await download();
  await screen.findByText("1 sent to Vortex");
  expect(commandCalls("nexus_handoff_to_vortex")).toEqual([
    { modId: 30342, fileId: 7 },
  ]);
  expect(commandCalls("nexus_list_files")).toHaveLength(1);
  expect(commandCalls("nexus_status").some((args) => args.forceRefresh)).toBe(
    false,
  );
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
  expect(screen.getByText("1 imported to Review")).toBeInTheDocument();
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
  app.setMods([{ ...mods[0], diskTranslatedKeys: 2 }, mods[1]]);
  await app.changeDeployment();
  await screen.findByText("1 sent to Vortex · files rechecked");
  fireEvent.click(translationRow().getByText("Details"));
  expect(
    translationRow().getByText("Local translation: 2/3 strings · 1 missing"),
  ).toBeInTheDocument();
  expect(
    translationRow().getByText("+2 strings on disk since handoff"),
  ).toBeInTheDocument();
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
    await app.changeDeployment();
    await screen.findByText("1 sent to Vortex · files rechecked");
    fireEvent.click(translationRow().getByText("Details"));
    expect(
      translationRow().getByText("Local translation coverage unavailable"),
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
  expect(metric("No download needed")).toBe("4");
  expect(metric("Mods without Nexus ID")).toBe("2");
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

it("labels no-text-needed sources separately from physical local strings", async () => {
  mount({
    mods: [
      {
        ...mods[0],
        totalKeys: 3,
        diskTranslatedKeys: 0,
        diskNoTranslationNeededKeys: 2,
      },
    ],
  });
  await screen.findByRole("row", { name: "Canonical title" });
  expect(
    translationRow().getByText(
      "Local translation: 0/3 strings · 2 need no translation text · 1 missing",
    ),
  ).toBeInTheDocument();
  expect(
    screen.queryByText("Available translation files are already installed."),
  ).not.toBeInTheDocument();
});

it.each(["free", "unknown", "invalid"] as const)(
  "offers manual links before any failed direct import for %s accounts",
  async (accountStatus) => {
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation((cmd: string, ...args: unknown[]) =>
      cmd === "nexus_status"
        ? Promise.resolve({
            configured: true,
            premium: false,
            validated: accountStatus === "free",
            accountStatus,
          })
        : original(cmd, ...args),
    );
    mount({ method: "folder" });
    await screen.findByRole("row", { name: "Canonical title" });
    expect(
      screen.queryByRole("button", { name: /^Download & import all/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open Nexus Link" }),
    ).toBeEnabled();
    expect(commandCalls("open_url")).toHaveLength(0);
    expect(commandCalls("nexus_download_preflight")).toHaveLength(0);
    expect(
      commandCalls("nexus_status").every((args) => !args.forceRefresh),
    ).toBe(true);
  },
);

it("uses account access updated by explicit search without a refresh button", async () => {
  let premium = false;
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((cmd: string, ...args: unknown[]) =>
    cmd === "nexus_status"
      ? Promise.resolve({ configured: true, validated: premium, premium })
      : original(cmd, ...args),
  );
  const app = mount({ method: "folder" });
  await screen.findByRole("row", { name: "Canonical title" });
  expect(screen.queryByRole("button", { name: "Refresh account" })).toBeNull();
  expect(
    screen.queryByRole("button", { name: /Download & import all/ }),
  ).toBeNull();
  premium = true;
  app.setSearch({ ...search, completed: 3 });
  expect(
    await screen.findByRole("button", { name: "Download & import all (1)" }),
  ).toBeEnabled();
  expect(commandCalls("nexus_status").every((args) => !args.forceRefresh)).toBe(
    true,
  );
});

it("keeps Vortex handoff independent of the API key's Free membership", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((cmd: string, ...args: unknown[]) =>
    cmd === "nexus_status"
      ? Promise.resolve({
          configured: true,
          premium: false,
          validated: true,
          accountStatus: "free",
        })
      : original(cmd, ...args),
  );
  mount();
  await download();
  await screen.findByText("1 sent to Vortex");
  expect(commandCalls("nexus_handoff_to_vortex")).toHaveLength(1);
  expect(commandCalls("nexus_download_preflight")).toHaveLength(0);
});

it("does not fetch newly visible metadata during a local installed-files recheck", async () => {
  const app = mount({ mods: [{ ...mods[0], diskTranslatedKeys: 3 }, mods[1]] });
  await waitFor(() => expect(commandCalls("nexus_list_files")).toHaveLength(1));
  app.setMods([{ ...mods[0], diskTranslatedKeys: 0 }, mods[1]]);
  await app.changeDeployment();
  await waitFor(() => expect(app.onCheckInstalled).toHaveBeenCalledOnce());
  await screen.findByRole("row", { name: "Canonical title" });
  expect(commandCalls("nexus_list_files")).toHaveLength(1);
  expect(commandCalls("nexus_status").some((args) => args.forceRefresh)).toBe(
    false,
  );
});

it("discards a delayed account snapshot after newer search progress", async () => {
  const snapshots: ((value: unknown) => void)[] = [];
  invoke.mockImplementation((cmd: string) => {
    if (cmd === "nexus_status")
      return new Promise((resolve) => snapshots.push(resolve));
    if (cmd === "nexus_list_files") return Promise.resolve([file]);
    return Promise.resolve(null);
  });
  const app = mount({ method: "folder" });
  await act(async () => {});
  const old = [...snapshots];
  app.setSearch({ ...search, completed: 3 });
  await act(async () =>
    snapshots.at(-1)!({ configured: true, validated: true, premium: true }),
  );
  await act(async () =>
    old.forEach((resolve) =>
      resolve({ configured: true, validated: true, premium: false }),
    ),
  );
  expect(
    screen.getByRole("button", { name: /Download & import all/ }),
  ).toBeInTheDocument();
});

it("does not claim no matches when account validation stopped discovery", async () => {
  mount({
    search: {
      ...search,
      entries: [],
      completed: 0,
      stoppedReason: "Nexus rate limit reached (HTTP 429).",
    },
  });
  expect(
    await screen.findByText("No downloadable files could be confirmed."),
  ).toBeInTheDocument();
  expect(
    screen.queryByText("No suitable translation downloads found."),
  ).toBeNull();
  expect(screen.getByRole("alert")).toHaveTextContent("HTTP 429");
});

it("observes a late deployment hint without repeatedly scanning or redownloading", async () => {
  let value = "before";
  const stamp = vi.fn(async () => value);
  const app = mount({ stamp });
  const button = await screen.findByRole("button", {
    name: "Download & install all with Vortex (1)",
  });
  await waitFor(() => expect(button).toBeEnabled());
  vi.useFakeTimers();
  try {
    await act(async () => {
      fireEvent.click(button);
    });
    expect(screen.getByText("1 sent to Vortex")).toBeInTheDocument();
    expect(stamp.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(app.onCheckInstalled).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(app.onCheckInstalled).not.toHaveBeenCalled();
    value = "deployed";
    app.onCheckInstalled.mockImplementation(async (current: () => boolean) => {
      if (current())
        app.setInstalled([{ sourceNexusId: 1, modId: 30342, fileId: 7 }]);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(app.onCheckInstalled).toHaveBeenCalledOnce();
    expect(
      screen.getByText("Available translation files are already installed."),
    ).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150000);
    });
    const reads = stamp.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(stamp).toHaveBeenCalledTimes(reads);
    expect(app.onCheckInstalled).toHaveBeenCalledOnce();
    expect(commandCalls("nexus_handoff_to_vortex")).toHaveLength(1);
    expect(commandCalls("nexus_list_files")).toHaveLength(1);
  } finally {
    app.unmount();
    vi.useRealTimers();
  }
});

it("deduplicates changed hints, waits for busy UI, and ignores unchanged returns", async () => {
  const app = mount();
  await download();
  await screen.findByText("1 sent to Vortex");
  app.setBlocked(true);
  vi.useFakeTimers();
  try {
    fireEvent.focus(window);
    fireEvent.focus(window);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(app.onCheckInstalled).not.toHaveBeenCalled();
    app.setStamp("deployed");
    fireEvent.focus(window);
    fireEvent(document, new Event("visibilitychange"));
    for (const duration of [250, 1500, 250])
      await act(async () => {
        await vi.advanceTimersByTimeAsync(duration);
      });
    expect(app.onCheckInstalled).not.toHaveBeenCalled();
    app.setBlocked(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(app.onCheckInstalled).toHaveBeenCalledOnce();
    fireEvent.focus(window);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(app.onCheckInstalled).toHaveBeenCalledOnce();
    expect(commandCalls("nexus_handoff_to_vortex")).toHaveLength(1);
  } finally {
    app.unmount();
    vi.useRealTimers();
  }
});

it.each(["close", "root", "language", "method", "unmount"])(
  "invalidates an in-flight local result after %s",
  async (change) => {
    const app = mount();
    await screen.findByRole("row", { name: "Canonical title" });
    let finish!: () => void;
    let current!: () => boolean;
    app.onCheckInstalled.mockImplementation((guard: () => boolean) => {
      current = guard;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    await app.changeDeployment();
    await waitFor(() => expect(app.onCheckInstalled).toHaveBeenCalledOnce());
    expect(current()).toBe(true);
    if (change === "close") app.setOpen(false);
    if (change === "root") app.setContext("other", "de");
    if (change === "language") app.setContext("mods", "fr");
    if (change === "method") app.setMethod("folder");
    if (change === "unmount") app.unmount();
    expect(current()).toBe(false);
    await act(async () => finish());
    expect(screen.queryByText(/files rechecked/)).toBeNull();
  },
);

it("stops observation on close and compares the retained baseline on reopen", async () => {
  const app = mount();
  await download();
  await screen.findByText("1 sent to Vortex");
  vi.useFakeTimers();
  try {
    app.setOpen(false);
    const reads = vi.mocked(app.onDeploymentStamp).mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000);
    });
    expect(app.onDeploymentStamp).toHaveBeenCalledTimes(reads);
    app.setOpen(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(app.onCheckInstalled).not.toHaveBeenCalled();
    app.setOpen(false);
    app.setStamp("deployed while closed");
    app.setOpen(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(app.onCheckInstalled).toHaveBeenCalledOnce();
    expect(
      commandCalls("nexus_status").every((args) => !args.forceRefresh),
    ).toBe(true);
  } finally {
    app.unmount();
    vi.useRealTimers();
  }
});

it("removes fully covered handoffs from downloads and retained search IDs while keeping the receipt", async () => {
  const app = mount();
  await download();
  await screen.findByText("1 sent to Vortex");
  app.onCheckInstalled.mockImplementation(async () =>
    app.setMods([{ ...mods[0], diskTranslatedKeys: 3 }, mods[1]]),
  );
  await app.changeDeployment();
  expect(screen.queryByRole("row", { name: "Canonical title" })).toBeNull();
  expect(screen.getByText(/1 sent to Vortex/)).toBeInTheDocument();
  expect(
    screen.getByText("No missing translation text in the checked mods."),
  ).toBeInTheDocument();
  expect(
    screen.queryByText("Available translation files are already installed."),
  ).toBeNull();
  const metrics = within(
    screen.getByRole("region", { name: "Translation search results" }),
  );
  expect(
    metrics.getByText("Mods with downloads").parentElement,
  ).toHaveTextContent("0");
  expect(
    metrics.getByText("No download needed").parentElement,
  ).toHaveTextContent("5");
  fireEvent.click(screen.getByRole("button", { name: "Search again" }));
  expect(app.onSearch).toHaveBeenCalledWith(
    expect.objectContaining({ retainIds: [] }),
  );
  app.setSearch({
    ...search,
    entries: [search.entries[0]],
    skippedComplete: 5,
  });
  expect(screen.getByText(/1 sent to Vortex/)).toBeInTheDocument();
  expect(
    metrics.getByText("No download needed").parentElement,
  ).toHaveTextContent("5");
  expect(commandCalls("nexus_handoff_to_vortex")).toHaveLength(1);
});

const sharedArchiveSources = {
  ...twoSources,
  entries: twoSources.entries.map((entry) => ({
    ...entry,
    result: { ...entry.result!, candidates: [candidate] },
  })),
};
const sharedArchiveMods = [
  mods[0],
  { ...mods[0], uniqueId: "second.mod", nexusId: 99, packageId: "second" },
];

it("hands one shared Vortex archive off once and preserves each original's coverage receipt", async () => {
  const app = mount({ search: sharedArchiveSources, mods: sharedArchiveMods });
  const button = await screen.findByRole("button", {
    name: "Download & install all with Vortex (1)",
  });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  fireEvent.click(button);
  await screen.findByText("1 sent to Vortex");
  expect(commandCalls("nexus_handoff_to_vortex")).toEqual([
    { modId: 30342, fileId: 7 },
  ]);
  expect(button).toBeDisabled();
  expect(screen.getAllByText(/Vortex launch was requested/)).toHaveLength(2);
  app.onCheckInstalled.mockImplementation(async () =>
    app.setMods([
      { ...sharedArchiveMods[0], diskTranslatedKeys: 1 },
      { ...sharedArchiveMods[1], diskTranslatedKeys: 2 },
    ]),
  );
  await app.changeDeployment();
  expect(
    screen.getByText(/\+1 strings on disk since handoff/),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/\+2 strings on disk since handoff/),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Search again" }));
  expect(app.onSearch).toHaveBeenCalledWith(
    expect.objectContaining({ retainIds: [1, 99] }),
  );
  app.setSearch({ ...sharedArchiveSources });
  expect(button).toBeDisabled();
  expect(commandCalls("nexus_handoff_to_vortex")).toHaveLength(1);
});

it("does not merge equal file IDs from different Nexus mods", async () => {
  mount({ search: twoSources });
  await download();
  await screen.findByText("2 sent to Vortex");
  expect(commandCalls("nexus_handoff_to_vortex")).toEqual([
    { modId: 30342, fileId: 7 },
    { modId: 999, fileId: 7 },
  ]);
});

it("shares a failed Vortex handoff and one explicit retry across its original groups", async () => {
  const original = invoke.getMockImplementation()!;
  let fail = true;
  invoke.mockImplementation((cmd: string, ...args: unknown[]) =>
    cmd === "nexus_handoff_to_vortex" && fail
      ? Promise.reject(new Error("Launch failed"))
      : original(cmd, ...args),
  );
  mount({ search: sharedArchiveSources, mods: sharedArchiveMods });
  await download();
  await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(2));
  expect(
    screen
      .getAllByRole("alert")
      .every((alert) => alert.textContent?.includes("Launch failed")),
  ).toBe(true);
  expect(
    screen.getByRole("button", {
      name: "Download & install all with Vortex (0)",
    }),
  ).toBeDisabled();
  expect(commandCalls("nexus_handoff_to_vortex")).toHaveLength(1);
  fail = false;
  fireEvent.click(screen.getAllByRole("button", { name: "Retry" })[0]);
  await screen.findByText("1 sent to Vortex");
  expect(commandCalls("nexus_handoff_to_vortex")).toHaveLength(2);
  expect(screen.queryAllByRole("alert")).toHaveLength(0);
  expect(screen.getAllByText(/Vortex launch was requested/)).toHaveLength(2);
  expect(
    screen.getByRole("button", {
      name: "Download & install all with Vortex (0)",
    }),
  ).toBeDisabled();
});

it("imports shared archive mappings separately for each original in Review", async () => {
  archive.files.push({
    path: "Second/i18n/de.json",
    manifestUniqueId: "second.mod",
    isDefault: false,
  });
  mount({
    method: "folder",
    search: sharedArchiveSources,
    mods: sharedArchiveMods,
  });
  await download();
  await screen.findByText("2 imported to Review");
  expect(commandCalls("nexus_download_preflight")).toHaveLength(2);
  expect(
    commandCalls("nexus_import_translation").map((call) => call.modUniqueId),
  ).toEqual(["sample.mod", "second.mod"]);
  expect(commandCalls("nexus_handoff_to_vortex")).toHaveLength(0);
});

async function advance(...durations: number[]) {
  for (const duration of durations)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(duration);
    });
}

it("requires a settled hint and revalidates a blocked hint before scanning", async () => {
  const app = mount();
  await screen.findByRole("row", { name: "Canonical title" });
  vi.useFakeTimers();
  try {
    app.setBlocked(true);
    app.setStamp("deploying-1");
    fireEvent.focus(window);
    await advance(250);
    app.setStamp("deploying-2");
    await advance(1500);
    expect(app.onCheckInstalled).not.toHaveBeenCalled();
    await advance(1500);
    // The settled hint is now queued, but deployment changes while the UI is busy.
    app.setStamp("deployed");
    app.setBlocked(false);
    await advance(250);
    expect(app.onCheckInstalled).not.toHaveBeenCalled();
    await advance(250, 1500, 250);
    expect(app.onCheckInstalled).toHaveBeenCalledOnce();
  } finally {
    app.unmount();
    vi.useRealTimers();
  }
});

it("does not scan for unavailable hints or the first known hint after an unknown baseline", async () => {
  let value: string | null = null;
  const app = mount({ stamp: async () => value });
  await screen.findByRole("row", { name: "Canonical title" });
  vi.useFakeTimers();
  try {
    fireEvent.focus(window);
    await advance(3000);
    value = "first known";
    fireEvent.focus(window);
    await advance(250, 1500, 250);
    expect(app.onCheckInstalled).not.toHaveBeenCalled();
    value = null;
    fireEvent.focus(window);
    await advance(3000);
    expect(app.onCheckInstalled).not.toHaveBeenCalled();
    value = "changed";
    fireEvent.focus(window);
    await advance(250, 1500, 250);
    expect(app.onCheckInstalled).toHaveBeenCalledOnce();
  } finally {
    app.unmount();
    vi.useRealTimers();
  }
});

it("suppresses retries for the same failed hint until a new deployment hint arrives", async () => {
  const app = mount();
  await download();
  await screen.findByText("1 sent to Vortex");
  app.onCheckInstalled.mockRejectedValueOnce(new Error("Local scan failed"));
  vi.useFakeTimers();
  try {
    app.setStamp("failed deployment");
    fireEvent.focus(window);
    await advance(250, 1500, 250);
    expect(app.onCheckInstalled).toHaveBeenCalledOnce();
    expect(screen.getByRole("alert")).toHaveTextContent("Local scan failed");
    expect(
      screen.getByRole("row", { name: "Canonical title" }),
    ).toBeInTheDocument();
    fireEvent.focus(window);
    await advance(30000);
    app.setOpen(false);
    app.setOpen(true);
    await advance(3000);
    expect(app.onCheckInstalled).toHaveBeenCalledOnce();
    app.setStamp("new deployment");
    fireEvent.focus(window);
    await advance(250, 1500, 250);
    expect(app.onCheckInstalled).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(commandCalls("nexus_handoff_to_vortex")).toHaveLength(1);
  } finally {
    app.unmount();
    vi.useRealTimers();
  }
});

function expectInstalledPresentationPending() {
  expect(
    screen.getByText("Checking installed translations…"),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("table", { name: "Translation downloads" }),
  ).toBeNull();
  expect(screen.queryByRole("button", { name: /^Download &/ })).toBeNull();
  expect(screen.queryByText("Mods with downloads")).toBeNull();
  expect(
    screen.queryByText(
      /^(No suitable translation downloads found\.|No missing translation text in the checked mods\.|Available translation files are already installed\.|No downloadable files could be confirmed\.)$/,
    ),
  ).toBeNull();
  expect(
    screen.getByRole("button", { name: "Close Nexus translations" }),
  ).toBeEnabled();
}

it("withholds initial offers and holds reopened results through settling and the fresh scan", async () => {
  let resolveHint!: (value: string) => void;
  let hint = new Promise<string>((resolve) => {
    resolveHint = resolve;
  });
  const app = mount({ stamp: () => hint });
  expectInstalledPresentationPending();
  await act(async () => resolveHint("before"));
  await screen.findByRole("row", { name: "Canonical title" });
  expect(app.onCheckInstalled).not.toHaveBeenCalled();
  app.setOpen(false);
  hint = new Promise<string>((resolve) => {
    resolveHint = resolve;
  });
  let finishScan!: () => void;
  app.onCheckInstalled.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finishScan = resolve;
      }),
  );
  vi.useFakeTimers();
  try {
    app.setOpen(true);
    expectInstalledPresentationPending();
    await act(async () => resolveHint("deployed"));
    expectInstalledPresentationPending();
    await advance(1500);
    expectInstalledPresentationPending();
    expect(app.onCheckInstalled).not.toHaveBeenCalled();
    await advance(250);
    expect(app.onCheckInstalled).toHaveBeenCalledOnce();
    expectInstalledPresentationPending();
    app.setMods([{ ...mods[0], diskTranslatedKeys: 3 }, mods[1]]);
    expectInstalledPresentationPending();
    await act(async () => finishScan());
    expect(screen.queryByText("Checking installed translations…")).toBeNull();
    expect(screen.queryByRole("row", { name: "Canonical title" })).toBeNull();
    expect(
      screen.getByText("No missing translation text in the checked mods."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Mods with downloads").parentElement,
    ).toHaveTextContent("0");
    expect(commandCalls("nexus_list_files")).toHaveLength(1);
    expect(app.onSearch).not.toHaveBeenCalled();
  } finally {
    app.unmount();
    vi.useRealTimers();
  }
});

it("keeps an open table visible during unchanged polls and a slow ordinary focus hint", async () => {
  let hint: Promise<string> = Promise.resolve("unchanged");
  const app = mount({ stamp: () => hint });
  const button = await screen.findByRole("button", {
    name: "Download & install all with Vortex (1)",
  });
  await waitFor(() => expect(button).toBeEnabled());
  vi.useFakeTimers();
  try {
    await act(async () => fireEvent.click(button));
    await advance(9000);
    const row = screen.getByRole("row", { name: "Canonical title" });
    expect(screen.queryByText("Checking installed translations…")).toBeNull();
    let resolveHint!: (value: string) => void;
    hint = new Promise((resolve) => {
      resolveHint = resolve;
    });
    fireEvent.focus(window);
    await advance(250);
    expect(row).toBeInTheDocument();
    expect(screen.queryByText("Checking installed translations…")).toBeNull();
    await act(async () => resolveHint("unchanged"));
    expect(row).toBeInTheDocument();
    expect(app.onCheckInstalled).not.toHaveBeenCalled();
    expect(commandCalls("nexus_list_files")).toHaveLength(1);
    expect(commandCalls("nexus_handoff_to_vortex")).toHaveLength(1);
    expect(app.onSearch).not.toHaveBeenCalled();
  } finally {
    app.unmount();
    vi.useRealTimers();
  }
});

it.each(["unknown", "rejected", "timeout"])(
  "releases initial presentation for a %s hint without claiming a fresh scan",
  async (mode) => {
    let resolveHint!: (value: string | null) => void;
    let rejectHint!: (reason: Error) => void;
    const hint = new Promise<string | null>((resolve, reject) => {
      resolveHint = resolve;
      rejectHint = reject;
    });
    vi.useFakeTimers();
    const app = mount({ stamp: () => hint });
    try {
      expectInstalledPresentationPending();
      if (mode === "timeout") {
        await advance(4999);
        expectInstalledPresentationPending();
        await advance(1);
      } else
        await act(async () => {
          if (mode === "unknown") resolveHint(null);
          else rejectHint(new Error("Hint unavailable"));
        });
      expect(
        screen.getByRole("row", { name: "Canonical title" }),
      ).toBeInTheDocument();
      expect(screen.queryByText("Checking installed translations…")).toBeNull();
      expect(
        screen.queryByText(
          /files rechecked|Available translation files are already installed/,
        ),
      ).toBeNull();
      expect(app.onCheckInstalled).not.toHaveBeenCalled();
      expect(app.onSearch).not.toHaveBeenCalled();
    } finally {
      app.unmount();
      vi.useRealTimers();
    }
  },
);

it.each(["reopen", "root", "language"])(
  "does not let an obsolete hint release the new %s presentation",
  async (change) => {
    const replies: ((value: string) => void)[] = [];
    const app = mount({
      stamp: () => new Promise((resolve) => replies.push(resolve)),
    });
    expectInstalledPresentationPending();
    if (change === "reopen") {
      app.setOpen(false);
      app.setOpen(true);
    } else
      app.setContext(
        change === "root" ? "other" : "mods",
        change === "language" ? "fr" : "de",
      );
    expectInstalledPresentationPending();
    await act(async () => replies[0]("old"));
    expectInstalledPresentationPending();
    await act(async () => replies.at(-1)!("current"));
    expect(
      screen.queryByText("Checking installed translations\u2026"),
    ).toBeNull();
    expect(screen.getByText("Mods with downloads")).toBeInTheDocument();
    expect(app.onCheckInstalled).not.toHaveBeenCalled();
  },
);

it("releases presentation when a changing deployment exhausts the settling window", async () => {
  const app = mount();
  await screen.findByRole("row", { name: "Canonical title" });
  vi.useFakeTimers();
  try {
    app.setStamp("changing");
    fireEvent.focus(window);
    await advance(250);
    expectInstalledPresentationPending();
    for (let index = 0; index < 7; index++) {
      app.setStamp(`changing-${index}`);
      await advance(1500);
    }
    expect(
      screen.getByRole("row", { name: "Canonical title" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Checking installed translations…")).toBeNull();
    expect(app.onCheckInstalled).not.toHaveBeenCalled();
  } finally {
    app.unmount();
    vi.useRealTimers();
  }
});

it.each([{ method: "folder" as const }, { observe: false }])(
  "does not add a local freshness gate without Vortex observation: %j",
  async (options) => {
    const app = mount(options);
    expect(screen.queryByText("Checking installed translations…")).toBeNull();
    await screen.findByRole("row", { name: "Canonical title" });
    expect(app.onDeploymentStamp).not.toHaveBeenCalled();
  },
);

it("releases a hanging final pre-scan hint and ignores its late response", async () => {
  const stamp = vi.fn(async () => "before");
  const app = mount({ stamp });
  await screen.findByRole("row", { name: "Canonical title" });
  let finishHint!: (value: string) => void;
  stamp
    .mockResolvedValue("after")
    .mockResolvedValueOnce("after")
    .mockResolvedValueOnce("after")
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishHint = resolve;
        }),
    );
  vi.useFakeTimers();
  try {
    fireEvent.focus(window);
    await advance(250, 1500, 250);
    expectInstalledPresentationPending();
    expect(app.onCheckInstalled).not.toHaveBeenCalled();
    await advance(4999);
    expectInstalledPresentationPending();
    await advance(1);
    expect(
      screen.getByRole("row", { name: "Canonical title" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Deployment information is unavailable",
    );
    expect(screen.queryByText("Checking installed translations…")).toBeNull();
    await act(async () => finishHint("after"));
    fireEvent.focus(window);
    await advance(3000);
    expect(app.onCheckInstalled).not.toHaveBeenCalled();
    expect(
      screen.getByRole("row", { name: "Canonical title" }),
    ).toBeInTheDocument();
    expect(commandCalls("nexus_list_files")).toHaveLength(1);
    expect(app.onSearch).not.toHaveBeenCalled();
  } finally {
    app.unmount();
    vi.useRealTimers();
  }
});

it("checks presentation again after returning to a previously resolved workspace", async () => {
  const stamp = vi.fn(async () => "before");
  const app = mount({ stamp });
  await screen.findByRole("row", { name: "Canonical title" });
  const replies: ((value: string) => void)[] = [];
  stamp.mockImplementation(
    () => new Promise((resolve) => replies.push(resolve)),
  );
  app.setContext("other", "de");
  app.setContext("mods", "de");
  expectInstalledPresentationPending();
  await act(async () => replies[0]("other"));
  expectInstalledPresentationPending();
  await act(async () => replies[1]("current"));
  expect(
    screen.getByRole("row", { name: "Canonical title" }),
  ).toBeInTheDocument();
  expect(app.onCheckInstalled).not.toHaveBeenCalled();
});
