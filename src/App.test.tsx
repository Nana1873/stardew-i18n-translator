import { StrictMode } from "react";
import {
  act,
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { vi } from "vitest";

const invokeMock = vi.fn();
let backendHistory: OperationHistoryEntry[] = [];
let fileDropHandler:
  | ((
      event:
        | { type: "enter"; paths: string[] }
        | { type: "over" }
        | { type: "drop"; paths: string[] }
        | { type: "leave" },
    ) => void)
  | null = null;
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => {
    const mocked = invokeMock(cmd, args);
    if (cmd === "list_operation_history") {
      return Promise.resolve(mocked).then((value) =>
        Array.isArray(value) ? value : backendHistory,
      );
    }
    if (cmd === "codex_cli_status") {
      return Promise.resolve(mocked).then(
        (value) =>
          value ?? {
            installed: false,
            authenticated: false,
            error: "Codex CLI is unavailable in this test.",
          },
      );
    }
    return mocked;
  },
}));
vi.mock("./llm-batch/dragDrop", () => ({
  listenForFileDrops: vi.fn(
    (handler: NonNullable<typeof fileDropHandler>): Promise<() => void> => {
      fileDropHandler = handler;
      return Promise.resolve(() => {
        fileDropHandler = null;
      });
    },
  ),
}));

// jsdom has no layout — the real virtualizer measures 0px forever. Render
// every item instead (same mock as StringTable.test).
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 30,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        key: index,
        index,
        start: index * 30,
        size: 30,
      })),
    measure: () => {},
    scrollToIndex: () => {},
  }),
}));

import { App } from "./App";
import type {
  AiRunResult,
  LlmImportPreflight,
  OperationHistoryEntry,
  OperationKind,
} from "./tauri/commands";

const CONFIGURED = {
  stardewPath: "E:/SDV",
  modsPath: "E:/SDV/Mods",
  sourceLang: "default",
  targetLang: "de",
  diagnosticLogging: true,
};

function historyEntry(
  kind: OperationKind,
  overrides: Partial<OperationHistoryEntry> = {},
): OperationHistoryEntry {
  return {
    id: `${kind}-operation`,
    kind,
    outcome: "success",
    title: `${kind} completed`,
    summary: `${kind} result from the backend`,
    itemCount: 1,
    warnings: [],
    details: [],
    canUndo: false,
    completedAtEpochMs: 1_780_000_000_000,
    ...overrides,
  };
}

function exportHistory(
  overrides: Partial<OperationHistoryEntry> = {},
): OperationHistoryEntry {
  return historyEntry("export", {
    id: "export-1",
    title: "Export completed",
    summary: "1 target file written",
    path: "x/i18n/de.json",
    fileName: "de.json",
    details: [{ label: "Component", value: "Test Mod" }],
    ...overrides,
  });
}

function importHistory(
  overrides: Partial<OperationHistoryEntry> = {},
): OperationHistoryEntry {
  return historyEntry("import", {
    id: "import-1",
    title: "LLM batch imported",
    summary: "1 value saved to Review",
    path: "C:/results/test.llm-result.json",
    fileName: "test.llm-result.json",
    details: [{ label: "Component", value: "a.b" }],
    ...overrides,
  });
}

function aiHistory(
  overrides: Partial<OperationHistoryEntry> = {},
): OperationHistoryEntry {
  return historyEntry("ai", {
    id: "ai-1",
    outcome: "cancelled",
    title: "AI translation cancelled",
    summary: "1 of 2 suggestions saved to Review",
    ...overrides,
  });
}

function batchEditHistory(
  overrides: Partial<OperationHistoryEntry> = {},
): OperationHistoryEntry {
  return historyEntry("batch-edit", {
    id: "batch-edit-1",
    title: "Batch edit saved",
    summary: "1 string updated",
    canUndo: true,
    ...overrides,
  });
}

function batchExportHistory(
  overrides: Partial<OperationHistoryEntry> = {},
): OperationHistoryEntry {
  return historyEntry("batch-export", {
    id: "batch-export-1",
    title: "LLM batch exported",
    summary: "1 source string exported",
    path: "C:/out/test.llm-batch.json",
    fileName: "test.llm-batch.json",
    ...overrides,
  });
}

const READY_IMPORT_PREFLIGHT: LlmImportPreflight = {
  batchModUniqueId: "a.b",
  batchTargetLang: "de",
  selectedModUniqueId: "a.b",
  selectedTargetLang: "de",
  modMatches: true,
  languageMatches: true,
  snapshotResult: "matched",
  suppliedStrings: 1,
  matchedStrings: 1,
  preservedLocal: 0,
  skippedEmpty: 0,
  identicalToSource: 0,
  importable: 1,
  protectedTokenIssues: [],
  ready: true,
  blockingReason: null,
};

beforeEach(() => {
  invokeMock.mockReset();
  backendHistory = [];
  fileDropHandler = null;
  localStorage.clear();
});

const EMPTY_SCAN = {
  mods: [],
  warnings: [],
  extraKeys: [],
  skippedComponents: [],
  modCount: 0,
  fileCount: 0,
};

const EXPORT_RESULT = {
  files: [
    {
      relativeDir: "i18n",
      targetPath: "x/i18n/de.json",
      written: true,
      removed: false,
      backedUp: false,
      writtenKeys: 1,
      untranslated: 0,
      outdated: 0,
      reviewNeeded: 0,
      orphanKeys: [],
    },
  ],
  skipped: [],
  filesWritten: 1,
  filesRemoved: 0,
  totalWrittenKeys: 1,
  totalUntranslated: 0,
  totalOutdated: 0,
  totalReviewNeeded: 0,
  totalOrphanKeys: 0,
  blocked: false,
};

function exportScan(targetExists: boolean) {
  return {
    mods: [
      {
        uniqueId: "a.b",
        name: "Test Mod",
        version: "1.0",
        nexusId: null,
        packageId: "Test Mod",
        folderPath: "x",
        i18nFiles: [
          {
            relativeDir: "i18n",
            defaultPath: "x/i18n/default.json",
            targetPath: "x/i18n/de.json",
            targetExists,
            totalKeys: 1,
            translatedKeys: 1,
            reviewNeeded: 0,
          },
        ],
        totalKeys: 1,
        translatedKeys: 1,
        reviewNeeded: 0,
        progress: 1,
        status: "translated",
      },
    ],
    warnings: [],
    extraKeys: [],
    skippedComponents: [],
    modCount: 1,
    fileCount: 1,
  };
}

function mockExportConfigured(targetExists: boolean) {
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
    if (cmd === "load_glossary") return Promise.resolve(null);
    if (cmd === "scan_mods") return Promise.resolve(exportScan(targetExists));
    if (cmd === "load_strings") return Promise.resolve([]);
    if (cmd === "export_mod") {
      backendHistory = [exportHistory()];
      return Promise.resolve(EXPORT_RESULT);
    }
    return Promise.resolve(null);
  });
}

function mockConfigured(scanResult: unknown = EMPTY_SCAN) {
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
    if (cmd === "scan_mods") return Promise.resolve(scanResult);
    if (cmd === "load_glossary") return Promise.resolve(null);
    if (cmd === "load_strings") return Promise.resolve([]);
    return Promise.resolve(null);
  });
}

function chooseToolbarAction(menuName: "Export actions", actionName: string) {
  fireEvent.click(screen.getByRole("button", { name: menuName }));
  fireEvent.click(screen.getByRole("menuitem", { name: actionName }));
}

function openWorkspace() {
  fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
}

describe("App shell", () => {
  it("renders Overview first and opens the complete V3 workspace on demand", async () => {
    mockConfigured();
    render(<App />);

    expect(screen.getByRole("button", { name: "Overview" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      await screen.findByRole("main", { name: "Overview" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    expect(
      screen
        .getByRole("region", { name: "Translation workspace" })
        .querySelector(".stv3-workbench"),
    ).toHaveStyle({ "--stv3-mod-pane-width": "340px" });
    expect(
      screen.getByRole("region", { name: "Mod list" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("searchbox", { name: "Search strings" }),
    ).toBeInTheDocument();
    const paneResizer = screen.getByRole("separator", {
      name: "Resize mod list",
    });
    expect(paneResizer).toHaveAttribute("aria-valuenow", "340");
    fireEvent.keyDown(paneResizer, { key: "ArrowRight" });
    expect(paneResizer).toHaveAttribute("aria-valuenow", "356");
    fireEvent.keyDown(paneResizer, { key: "ArrowLeft", shiftKey: true });
    expect(paneResizer).toHaveAttribute("aria-valuenow", "340");
    fireEvent.keyDown(paneResizer, { key: "End" });
    expect(paneResizer).toHaveAttribute("aria-valuenow", "340");

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Scan mods" })).toBeEnabled(),
    );
    expect(screen.getByPlaceholderText("Filter mods …")).toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "Setup" }),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("scan_mods", {
        modsPath: "E:/SDV/Mods",
        targetLang: "de",
      }),
    );
    expect(screen.queryByRole("dialog", { name: "Scan" })).toBeNull();
  });

  it("shows the current scan's real skipped-component count", async () => {
    mockConfigured();
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    const skipped = await screen.findByRole("button", {
      name: "0 skipped components; open scan diagnostics",
    });
    expect(skipped).toHaveTextContent("Skipped · 0");
    expect(within(skipped).getByText("0")).toHaveClass("stv3-pane-count");
    fireEvent.click(skipped);

    const dialog = await screen.findByRole("dialog", { name: "Scan" });
    expect(dialog).toHaveTextContent("Latest scan");
    expect(dialog).toHaveTextContent("No components were skipped");
  });

  it("loads dashboard resume history from portable settings", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings")
        return Promise.resolve({
          ...CONFIGURED,
          lastOpened: { "a.b": Date.now() - 60_000 },
        });
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "scan_mods") return Promise.resolve(exportScan(false));
      return Promise.resolve(null);
    });

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Overview" }));
    const overview = await screen.findByRole("main", { name: "Overview" });
    expect(overview).toHaveTextContent("Recently edited");
    expect(screen.queryByText(/no mod has been opened/i)).toBeNull();
    const recentRow = within(overview)
      .getByRole("button", { name: "Test Mod" })
      .closest("tr");
    expect(recentRow).not.toBeNull();
    expect(within(recentRow!).getByText("Unavailable")).toBeInTheDocument();
    expect(within(recentRow!).queryByText(/ago$/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue Test Mod" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("save_settings", {
        settings: expect.objectContaining({
          lastOpened: { "a.b": expect.any(Number) },
        }),
      }),
    );
  });

  it("hydrates the last-export folder from backend operation history", async () => {
    backendHistory = [
      exportHistory({
        path: "C:/canonical/i18n/de.json",
        fileName: "de.json",
      }),
    ];
    mockConfigured(exportScan(false));

    render(<App />);

    const overview = await screen.findByRole("main", { name: "Overview" });
    expect(overview).toHaveTextContent("Last export · Test Mod · this session");
    expect(overview).toHaveTextContent("C:/canonical/i18n/de.json");
    fireEvent.click(
      within(overview).getByRole("button", { name: "Show in folder" }),
    );
    expect(invokeMock).toHaveBeenCalledWith("open_folder", {
      path: "C:/canonical/i18n",
    });
  });

  it("migrates legacy resume history into portable settings once", async () => {
    localStorage.setItem("sit:lastOpened", JSON.stringify({ "a.b": 1234 }));
    mockConfigured(exportScan(false));

    render(<App />);

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("save_settings", {
        settings: { ...CONFIGURED, lastOpened: { "a.b": 1234 } },
      }),
    );
    await waitFor(() =>
      expect(localStorage.getItem("sit:lastOpened")).toBeNull(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Overview" }));
    expect(screen.getByRole("main", { name: "Overview" })).toHaveTextContent(
      "Recently edited",
    );
    expect(
      screen.getByRole("button", { name: "Continue Test Mod" }),
    ).toBeInTheDocument();
  });

  it("discards invalid legacy resume timestamps instead of migrating them", async () => {
    localStorage.setItem(
      "sit:lastOpened",
      JSON.stringify({ fractional: 1.5, unsafe: Number.MAX_SAFE_INTEGER + 1 }),
    );
    mockConfigured(exportScan(false));

    render(<App />);

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("scan_mods", {
        modsPath: "E:/SDV/Mods",
        targetLang: "de",
      }),
    );
    expect(invokeMock).not.toHaveBeenCalledWith(
      "save_settings",
      expect.anything(),
    );
    expect(localStorage.getItem("sit:lastOpened")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Overview" }));
    expect(screen.getByText(/no mod has been opened/i)).toBeInTheDocument();
  });

  it("starts only one automatic scan under React StrictMode", async () => {
    mockConfigured();
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("scan_mods", {
        modsPath: "E:/SDV/Mods",
        targetLang: "de",
      }),
    );
    expect(
      invokeMock.mock.calls.filter(([cmd]) => cmd === "scan_mods"),
    ).toHaveLength(1);
  });

  it("the V3 navigation switches between Workspace and Overview", async () => {
    mockConfigured();
    render(<App />);

    expect(
      await screen.findByRole("main", { name: "Overview" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Overview" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    expect(
      await screen.findByRole("region", { name: "Translation workspace" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Overview" }));
    expect(
      await screen.findByRole("main", { name: "Overview" }),
    ).toBeInTheDocument();
  });

  it("hydrates and persists the portable workspace preferences", async () => {
    const workspace = {
      selectedModId: "a.b",
      modSearch: "Test",
      stringSearch: "Hallo",
      stringScope: "mod" as const,
      statusFilter: "review-needed" as const,
      issuesOnly: true,
      sort: { column: "target" as const, direction: "desc" as const },
      modPaneWidth: 412,
      columnWidths: {
        mod: 150,
        file: 120,
        status: 110,
        key: 170,
        source: 250,
        target: 280,
      },
    };
    const settings = { ...CONFIGURED, workspace };
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(settings);
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "scan_mods") return Promise.resolve(exportScan(true));
      if (cmd === "load_strings")
        return Promise.resolve([
          {
            key: "greeting",
            source: "Hello {{name}}",
            target: "Hallo",
            targetPresent: true,
            status: "review-needed",
          },
        ]);
      return Promise.resolve(null);
    });

    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Settings" })).toBeEnabled(),
    );
    openWorkspace();

    expect(await screen.findByText("greeting")).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Filter mods" })).toHaveValue(
      "Test",
    );
    expect(
      screen.getByRole("searchbox", { name: "Search strings" }),
    ).toHaveValue("Hallo");
    expect(screen.getByRole("button", { name: "This mod" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: /^Review\b/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.getByRole("button", { name: /^Validation issues\b/ }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("separator", { name: "Resize mod list" }),
    ).toHaveAttribute("aria-valuenow", "412");
    expect(
      screen.getByRole("columnheader", { name: /German translation/ }),
    ).toHaveAttribute("aria-sort", "descending");
    expect(
      screen.getByRole("separator", { name: "Resize status column" }),
    ).toHaveAttribute("aria-valuenow", "110");
    expect(
      screen.getByRole("separator", { name: "Resize key column" }),
    ).toHaveAttribute("aria-valuenow", "170");
    expect(
      screen.getByRole("separator", { name: "Resize English source column" }),
    ).toHaveAttribute("aria-valuenow", "250");
    expect(
      screen.getByRole("separator", {
        name: "Resize German translation column",
      }),
    ).toHaveAttribute("aria-valuenow", "280");

    fireEvent.change(screen.getByRole("searchbox", { name: "Filter mods" }), {
      target: { value: "Test Mod" },
    });
    await waitFor(
      () =>
        expect(invokeMock).toHaveBeenCalledWith("save_settings", {
          settings: {
            ...settings,
            workspace: { ...workspace, modSearch: "Test Mod" },
          },
        }),
      { timeout: 2_500 },
    );
  });

  it("shows the actionable no-mod card in the work view", async () => {
    mockConfigured();
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    expect(
      await screen.findByText("No translatable strings"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Overview" }));
    expect(
      await screen.findByRole("main", { name: "Overview" }),
    ).toBeInTheDocument();
  });

  it("shows partially translated mods in the mod-panel header", async () => {
    mockConfigured({
      mods: [
        {
          uniqueId: "partial.mod",
          name: "Partial Mod",
          version: "1.0",
          nexusId: null,
          packageId: "Partial Mod",
          folderPath: "x",
          i18nFiles: [],
          totalKeys: 10,
          translatedKeys: 4,
          reviewNeeded: 0,
          progress: 0.4,
          status: "untranslated",
        },
      ],
      warnings: [],
      modCount: 1,
      fileCount: 0,
    });
    render(<App />);
    openWorkspace();

    expect(await screen.findByText("1 in progress")).toBeInTheDocument();
  });

  it("asks before replacing an existing selected-mod translation", async () => {
    mockExportConfigured(true);
    render(<App />);
    openWorkspace();

    expect(await screen.findAllByText("Test Mod")).not.toHaveLength(0);
    chooseToolbarAction("Export actions", "Export current mod");

    expect(
      screen.getByRole("dialog", { name: "Confirm export overwrite" }),
    ).toHaveTextContent("1 existing translation file");
    expect(
      invokeMock.mock.calls.filter(([cmd]) => cmd === "export_mod"),
    ).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.queryByRole("dialog", { name: "Confirm export overwrite" }),
    ).toBeNull();
  });

  it("separates existing and new component targets without narrowing export", async () => {
    const base = exportScan(true);
    const mod = base.mods[0];
    const existingFile = mod.i18nFiles[0];
    const newFile = {
      ...existingFile,
      relativeDir: "assets/i18n",
      defaultPath: "x/assets/i18n/default.json",
      targetPath: "x/assets/i18n/de.json",
      targetExists: false,
    };
    const scan = {
      ...base,
      mods: [{ ...mod, i18nFiles: [existingFile, newFile] }],
      fileCount: 2,
    };
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "scan_mods") return Promise.resolve(scan);
      if (cmd === "load_strings") return Promise.resolve([]);
      if (cmd === "export_mod") return Promise.resolve(EXPORT_RESULT);
      return Promise.resolve(null);
    });
    render(<App />);
    openWorkspace();

    expect(await screen.findAllByText("Test Mod")).not.toHaveLength(0);
    chooseToolbarAction("Export actions", "Export current mod");

    const preflight = screen.getByRole("dialog", {
      name: "Confirm export overwrite",
    });
    expect(preflight).toHaveTextContent(
      "replaces 1 existing translation file and creates 1 new translation file",
    );
    expect(
      within(preflight).getByText("Existing target · backed up as .json.bak"),
    ).toBeInTheDocument();
    expect(
      within(preflight).getByText("New target · created by this export"),
    ).toBeInTheDocument();

    fireEvent.click(
      within(preflight).getByRole("button", { name: "Export and replace" }),
    );
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("export_mod", {
        modUniqueId: "a.b",
        files: [existingFile, newFile].map((file) => ({
          relativeDir: file.relativeDir,
          defaultPath: file.defaultPath,
          targetPath: file.targetPath,
        })),
      }),
    );
  });

  it("continues an overwrite only after confirmation", async () => {
    mockExportConfigured(true);
    render(<App />);
    openWorkspace();

    expect(await screen.findAllByText("Test Mod")).not.toHaveLength(0);
    chooseToolbarAction("Export actions", "Export current mod");
    fireEvent.click(screen.getByRole("button", { name: "Export and replace" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("export_mod", {
        modUniqueId: "a.b",
        files: [
          {
            relativeDir: "i18n",
            defaultPath: "x/i18n/default.json",
            targetPath: "x/i18n/de.json",
          },
        ],
      }),
    );
    expect(
      await screen.findByRole("complementary", {
        name: "Latest operation result",
      }),
    ).toHaveTextContent("Export completed");
  });

  it("shows the complete preflight for a new target and reopens the latest result", async () => {
    mockExportConfigured(false);
    render(<App />);
    openWorkspace();

    expect(await screen.findAllByText("Test Mod")).not.toHaveLength(0);
    chooseToolbarAction("Export actions", "Export current mod");

    const preflight = screen.getByRole("dialog", {
      name: "Confirm export overwrite",
    });
    expect(preflight).toHaveTextContent("creates 1 new translation file");
    expect(
      within(preflight).getByLabelText("Export readiness"),
    ).toHaveTextContent("1currently eligible");
    expect(preflight).toHaveTextContent("0currently open");
    expect(preflight).toHaveTextContent("Unavailableaccepted mismatches");
    expect(preflight).toHaveTextContent(
      "Protected-token blocker preflight is also unavailable",
    );
    expect(preflight).not.toHaveTextContent("Ready to export");
    expect(preflight).toHaveTextContent("x/i18n/de.json");
    expect(invokeMock).not.toHaveBeenCalledWith(
      "export_mod",
      expect.anything(),
    );

    fireEvent.click(within(preflight).getByRole("button", { name: "Export" }));
    expect(
      await screen.findByRole("complementary", {
        name: "Latest operation result",
      }),
    ).toHaveTextContent("x/i18n/de.json");

    fireEvent.click(screen.getByRole("button", { name: "Collapse result" }));
    expect(screen.getByRole("button", { name: "Expand result" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Hide result" }));
    expect(
      screen.queryByRole("complementary", { name: "Latest operation result" }),
    ).toBeNull();
    const latestResult = screen.getByRole("button", { name: "Latest result" });
    await waitFor(() => expect(latestResult).toHaveFocus());
    fireEvent.click(latestResult);
    expect(
      screen.getByRole("complementary", { name: "Latest operation result" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Collapse result" }),
      ).toHaveFocus(),
    );
  });

  it("retains the last successful export independently and opens its real folder", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "scan_mods") return Promise.resolve(exportScan(false));
      if (cmd === "load_strings") return Promise.resolve([]);
      if (cmd === "export_mod") {
        backendHistory = [exportHistory()];
        return Promise.resolve(EXPORT_RESULT);
      }
      if (cmd === "preflight_llm_batch_path")
        return Promise.resolve(READY_IMPORT_PREFLIGHT);
      if (cmd === "import_llm_batch_path") {
        backendHistory = [importHistory(), exportHistory()];
        return Promise.resolve({
          imported: 1,
          skippedTranslated: 0,
          unmatched: 0,
          identicalToSource: 0,
          totalInFile: 1,
        });
      }
      return Promise.resolve(null);
    });
    render(<App />);

    let overview = await screen.findByRole("main", { name: "Overview" });
    expect(overview).toHaveTextContent(
      "Last export · Unavailable in this session",
    );
    expect(
      within(overview).getByRole("button", { name: "Show in folder" }),
    ).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    chooseToolbarAction("Export actions", "Export current mod");
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(
      await screen.findByRole("complementary", {
        name: "Latest operation result",
      }),
    ).toHaveTextContent("Export completed");

    fireEvent.click(screen.getByRole("button", { name: "Overview" }));
    overview = await screen.findByRole("main", { name: "Overview" });
    expect(overview).toHaveTextContent("Last export · Test Mod · this session");
    expect(overview).toHaveTextContent("x/i18n/de.json");
    fireEvent.click(
      within(overview).getByRole("button", { name: "Show in folder" }),
    );
    expect(invokeMock).toHaveBeenCalledWith("open_folder", {
      path: "x/i18n",
    });

    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    await waitFor(() => expect(fileDropHandler).not.toBeNull());
    act(() => {
      fileDropHandler?.({
        type: "drop",
        paths: ["C:/results/test.llm-result.json"],
      });
    });
    const importDialog = await screen.findByRole("dialog", {
      name: "Import LLM batch",
    });
    expect(
      await within(importDialog).findByText("Ready to import"),
    ).toBeVisible();
    fireEvent.click(
      within(importDialog).getByRole("button", { name: "Import file" }),
    );
    expect(
      await screen.findByRole("complementary", {
        name: "Latest operation result",
      }),
    ).toHaveTextContent("LLM batch imported");

    fireEvent.click(screen.getByRole("button", { name: "Overview" }));
    overview = await screen.findByRole("main", { name: "Overview" });
    expect(overview).toHaveTextContent("Last export · Test Mod · this session");
    expect(overview).toHaveTextContent("x/i18n/de.json");
  });

  it("keeps the result tray collapsed after a top-level dialog closes", async () => {
    mockExportConfigured(false);
    render(<App />);
    openWorkspace();

    expect(await screen.findAllByText("Test Mod")).not.toHaveLength(0);
    chooseToolbarAction("Export actions", "Export current mod");
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(
      await screen.findByRole("button", { name: "Collapse result" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const settingsDialog = await screen.findByRole("dialog", {
      name: "Settings",
    });
    fireEvent.click(
      within(settingsDialog).getByRole("button", { name: "Close settings" }),
    );

    expect(
      await screen.findByRole("button", { name: "Expand result" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Collapse result" }),
    ).toBeNull();
  });

  it("does not confirm again after an export removes the target file", async () => {
    const removedResult = {
      ...EXPORT_RESULT,
      files: EXPORT_RESULT.files.map((file) => ({
        ...file,
        written: false,
        removed: true,
        writtenKeys: 0,
      })),
      filesWritten: 0,
      filesRemoved: 1,
      totalWrittenKeys: 0,
    };
    let exports = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "scan_mods") return Promise.resolve(exportScan(true));
      if (cmd === "load_strings") return Promise.resolve([]);
      if (cmd === "export_mod") {
        exports += 1;
        return Promise.resolve(removedResult);
      }
      return Promise.resolve(null);
    });
    render(<App />);
    openWorkspace();

    expect(await screen.findAllByText("Test Mod")).not.toHaveLength(0);
    chooseToolbarAction("Export actions", "Export current mod");
    fireEvent.click(screen.getByRole("button", { name: "Export and replace" }));
    await waitFor(() => expect(exports).toBe(1));
    expect(
      screen.getByRole("complementary", { name: "Latest operation result" }),
    ).toHaveTextContent("1 target file written or removed");
    expect(
      screen.getByRole("complementary", { name: "Latest operation result" }),
    ).toHaveTextContent("Removed");
    fireEvent.click(screen.getByRole("button", { name: "Hide result" }));

    chooseToolbarAction("Export actions", "Export current mod");
    const secondPreflight = screen.getByRole("dialog", {
      name: "Confirm export overwrite",
    });
    expect(secondPreflight).toHaveTextContent("creates 1 new translation file");
    fireEvent.click(
      within(secondPreflight).getByRole("button", { name: "Export" }),
    );
    await waitFor(() => expect(exports).toBe(2));
  });

  it("exports all mods through one atomic backend command", async () => {
    const base = exportScan(false).mods[0];
    const scan = {
      ...exportScan(false),
      mods: [
        {
          ...base,
          uniqueId: "a.first",
          name: "First Mod",
          i18nFiles: base.i18nFiles.map((file) => ({
            ...file,
            targetExists: true,
          })),
        },
        {
          ...base,
          uniqueId: "b.second",
          name: "Second Mod",
          i18nFiles: base.i18nFiles.map((file) => ({
            ...file,
            defaultPath: "y/i18n/default.json",
            targetPath: "y/i18n/de.json",
          })),
        },
        {
          ...base,
          uniqueId: "c.third",
          name: "Third Mod",
          i18nFiles: base.i18nFiles.map((file) => ({
            ...file,
            defaultPath: "z/i18n/default.json",
            targetPath: "z/i18n/de.json",
          })),
        },
      ],
      modCount: 3,
      fileCount: 3,
    };
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "scan_mods") return Promise.resolve(scan);
      if (cmd === "export_all_mods") {
        backendHistory = [
          exportHistory({
            id: "export-all-1",
            title: "All-mod export completed",
            summary: "3 target files written",
            itemCount: 3,
            path: "x/i18n",
            fileName: undefined,
            details: [],
          }),
        ];
        return Promise.resolve({
          mods: scan.mods.map((mod) => ({
            modUniqueId: mod.uniqueId,
            modName: mod.name,
            result: EXPORT_RESULT,
          })),
          modsChanged: 3,
          filesWritten: 3,
          filesRemoved: 0,
          totalWrittenKeys: 3,
          totalUntranslated: 0,
          totalOutdated: 0,
          totalReviewNeeded: 0,
          totalOrphanKeys: 0,
          blocked: false,
        });
      }
      return Promise.resolve(null);
    });
    render(<App />);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Export actions" }),
      ).toBeEnabled(),
    );
    chooseToolbarAction("Export actions", "Export all mods …");
    const preflight = screen.getByRole("dialog", {
      name: "Confirm export overwrite",
    });
    expect(preflight).toHaveTextContent("Export all mods?");
    expect(preflight).toHaveTextContent(
      "replaces 1 existing translation file and creates 2 new translation files across 3 mods",
    );
    expect(preflight).toHaveTextContent(
      "Existing target · backed up as .json.bak",
    );
    expect(preflight).toHaveTextContent("New targets · created by this export");
    expect(preflight).toHaveTextContent("3currently eligible");
    fireEvent.click(
      within(preflight).getByRole("button", { name: "Export all mods" }),
    );

    const tray = await screen.findByRole("complementary", {
      name: "Latest operation result",
    });
    await waitFor(() => expect(tray).toHaveTextContent("All mods exported"));
    expect(tray).toHaveTextContent("3 target files written or removed");
    expect(invokeMock).toHaveBeenCalledWith("export_all_mods", {
      mods: scan.mods.map((mod) => ({
        modUniqueId: mod.uniqueId,
        modName: mod.name,
        files: mod.i18nFiles.map((file) => ({
          relativeDir: file.relativeDir,
          defaultPath: file.defaultPath,
          targetPath: file.targetPath,
        })),
      })),
    });
    expect(
      invokeMock.mock.calls.filter(([cmd]) => cmd === "export_mod"),
    ).toHaveLength(0);
  });

  it("offers one-session undo for a real bulk edit", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "scan_mods") return Promise.resolve(exportScan(false));
      if (cmd === "load_strings")
        return Promise.resolve([
          {
            key: "greeting",
            source: "Hello",
            target: "",
            targetPresent: false,
            status: "untranslated",
          },
        ]);
      if (cmd === "save_string_groups_with_undo") {
        const entry = batchEditHistory({ title: "Kept original text" });
        backendHistory = [entry];
        return Promise.resolve(entry);
      }
      if (cmd === "undo_batch_edit") {
        const entry = historyEntry("batch-undo", {
          id: "batch-undo-1",
          title: "Batch edit undone",
          summary: "1 string restored",
        });
        backendHistory = [entry];
        return Promise.resolve(entry);
      }
      return Promise.resolve(null);
    });
    render(<App />);
    openWorkspace();

    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Select greeting" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "1 selected" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Keep original" }));

    const result = await screen.findByRole("complementary", {
      name: "Latest operation result",
    });
    expect(result).toHaveTextContent("Kept original text");
    expect(invokeMock).toHaveBeenCalledWith("save_string_groups_with_undo", {
      title: "Kept original text",
      groups: [
        {
          modUniqueId: "a.b",
          entries: [
            {
              relativeDir: "i18n",
              key: "greeting",
              target: "Hello",
              status: "translated",
              source: "Hello",
            },
          ],
        },
      ],
    });

    fireEvent.click(
      within(result).getByRole("button", {
        name: "Undo the latest batch edit",
      }),
    );
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("undo_batch_edit", {
        operationId: "batch-edit-1",
      }),
    );
    expect(
      invokeMock.mock.calls.filter(([cmd]) => cmd === "save_strings"),
    ).toHaveLength(0);
    await waitFor(() =>
      expect(
        within(result).getAllByText("Batch edit undone").length,
      ).toBeGreaterThan(0),
    );
  });

  it("restores an accepted Review token mismatch during bulk undo", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "scan_mods") return Promise.resolve(exportScan(false));
      if (cmd === "load_strings")
        return Promise.resolve([
          {
            key: "greeting",
            source: "Hello {{name}}",
            target: "Hallo",
            targetPresent: true,
            status: "review-needed",
            tokenMismatchAccepted: true,
          },
        ]);
      if (cmd === "save_string_groups_with_undo") {
        const entry = batchEditHistory({ title: "Updated status" });
        backendHistory = [entry];
        return Promise.resolve(entry);
      }
      if (cmd === "undo_batch_edit") {
        const entry = historyEntry("batch-undo", {
          id: "batch-undo-accepted-1",
          title: "Batch edit undone",
          summary: "Accepted token mismatch restored",
        });
        backendHistory = [entry];
        return Promise.resolve(entry);
      }
      return Promise.resolve(null);
    });
    render(<App />);
    openWorkspace();

    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Select greeting" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "1 selected" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Mark as done" }));

    const result = await screen.findByRole("complementary", {
      name: "Latest operation result",
    });
    fireEvent.click(
      within(result).getByRole("button", {
        name: "Undo the latest batch edit",
      }),
    );

    expect(invokeMock).toHaveBeenCalledWith("save_string_groups_with_undo", {
      title: "Updated status",
      groups: [
        {
          modUniqueId: "a.b",
          entries: [
            {
              relativeDir: "i18n",
              key: "greeting",
              target: "Hallo",
              status: "translated-token-mismatch-accepted",
              source: "Hello {{name}}",
            },
          ],
        },
      ],
    });
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("undo_batch_edit", {
        operationId: "batch-edit-1",
      }),
    );
  });

  it("starts the selected strings immediately with the ready Settings engine", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings")
        return Promise.resolve({
          ...CONFIGURED,
          ai: {
            defaultEngine: "codex",
            codexReasoning: "high",
          },
        });
      if (cmd === "codex_cli_status")
        return Promise.resolve({
          installed: true,
          authenticated: true,
          version: "0.57.0",
          authentication: "ChatGPT account",
        });
      if (cmd === "translate_with_codex_cli")
        return new Promise<never>(() => undefined);
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "scan_mods") return Promise.resolve(exportScan(false));
      if (cmd === "load_strings")
        return Promise.resolve([
          {
            key: "greeting",
            source: "Hello",
            target: "",
            targetPresent: false,
            status: "untranslated",
          },
        ]);
      return Promise.resolve(null);
    });

    render(<App />);
    openWorkspace();

    await waitFor(() => {
      expect(
        invokeMock.mock.calls.some(([cmd]) => cmd === "codex_cli_status"),
      ).toBe(true);
    });
    fireEvent.click(
      await screen.findByRole("checkbox", {
        name: "Select all visible strings",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "1 selected" }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: /Translate selected with AI/ }),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "AI translation progress",
    });
    expect(within(dialog).queryByLabelText("Engine")).toBeNull();
    expect(within(dialog).queryByLabelText("Scope")).toBeNull();
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("translate_with_codex_cli", {
        request: {
          runId: expect.any(String),
          scope: "selected",
          includeOpen: true,
          includeChanged: true,
          identities: [
            {
              modUniqueId: "a.b",
              relativeDir: "i18n",
              key: "greeting",
            },
          ],
        },
      }),
    );
  });

  it("replaces a cancelled AI progress dialog with the exact partial result", async () => {
    let releaseTranslation: ((result: AiRunResult) => void) | null = null;
    let activeRunId = "";
    invokeMock.mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === "load_settings")
        return Promise.resolve({
          ...CONFIGURED,
          llm: {
            provider: "custom",
            baseUrl: "http://127.0.0.1:1234/v1",
            model: "local-test",
            temperature: 0.2,
          },
        });
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "scan_mods") return Promise.resolve(exportScan(false));
      if (cmd === "load_strings")
        return Promise.resolve([
          {
            key: "first",
            source: "First",
            target: "",
            targetPresent: false,
            status: "untranslated",
          },
          {
            key: "second",
            source: "Second",
            target: "",
            targetPresent: false,
            status: "untranslated",
          },
        ]);
      if (cmd === "translate_with_local_ai") {
        activeRunId = (args as { request: { runId: string } }).request.runId;
        backendHistory = [aiHistory()];
        return new Promise((resolve) => {
          releaseTranslation = resolve;
        });
      }
      if (cmd === "cancel_ai_run") return Promise.resolve(true);
      return Promise.resolve(null);
    });
    render(<App />);
    openWorkspace();

    fireEvent.click(
      await screen.findByRole("checkbox", {
        name: "Select all visible strings",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "2 selected" }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: /Translate selected with AI/ }),
    );
    const progressDialog = await screen.findByRole("dialog", {
      name: "AI translation progress",
    });
    expect(within(progressDialog).queryByLabelText("Engine")).toBeNull();
    expect(within(progressDialog).queryByLabelText("Scope")).toBeNull();
    expect(
      within(progressDialog).getByRole("progressbar", {
        name: "AI translation progress",
      }),
    ).toHaveAttribute(
      "aria-valuetext",
      "2 selected strings are being translated",
    );
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("translate_with_local_ai", {
        request: expect.objectContaining({
          runId: expect.any(String),
          scope: "selected",
          includeOpen: true,
          includeChanged: true,
          identities: [
            { modUniqueId: "a.b", relativeDir: "i18n", key: "first" },
            { modUniqueId: "a.b", relativeDir: "i18n", key: "second" },
          ],
        }),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    if (!releaseTranslation) throw new Error("AI request did not start");
    expect(invokeMock).toHaveBeenCalledWith("cancel_ai_run", {
      runId: activeRunId,
    });
    act(() => {
      releaseTranslation?.({
        runId: activeRunId,
        engine: "local",
        model: "local-test",
        reasoning: "default",
        scope: "selected",
        requested: 2,
        completed: 1,
        outcome: "cancelled",
        suggestions: [
          {
            identity: {
              modUniqueId: "a.b",
              relativeDir: "i18n",
              key: "first",
            },
            text: "Erste",
            status: "review-needed",
            tokenDifferences: [],
            glossaryMisses: [],
          },
        ],
      });
    });

    const result = await screen.findByRole("complementary", {
      name: "Latest operation result",
    });
    expect(
      screen.queryByRole("dialog", { name: "AI translation progress" }),
    ).toBeNull();
    expect(result).toHaveTextContent("AI translation cancelled");
    expect(result).toHaveTextContent("1 Local AI suggestion");
    expect(result).toHaveTextContent("1 saved · 1 remaining");
    expect(
      within(result).getByRole("button", { name: "Open review queue" }),
    ).toBeEnabled();
    expect(
      within(result).queryByRole("button", {
        name: "Undo the latest batch edit",
      }),
    ).toBeNull();
    fireEvent.click(
      within(result).getByRole("button", { name: "Open review queue" }),
    );
    expect(screen.getByRole("button", { name: "This mod" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("opens a multi-mod AI result without hiding Review rows in one component", async () => {
    const scan = exportScan(false);
    scan.mods.push({
      ...scan.mods[0],
      uniqueId: "second.mod",
      name: "Second Mod",
      packageId: "Second Mod",
      folderPath: "y",
      i18nFiles: [
        {
          relativeDir: "i18n",
          defaultPath: "y/i18n/default.json",
          targetPath: "y/i18n/de.json",
          targetExists: false,
          totalKeys: 1,
          translatedKeys: 0,
          reviewNeeded: 0,
        },
      ],
      totalKeys: 1,
      translatedKeys: 0,
      reviewNeeded: 0,
      progress: 0,
      status: "untranslated",
    });
    scan.modCount = 2;
    scan.fileCount = 2;

    let releaseTranslation: ((result: AiRunResult) => void) | null = null;
    let activeRunId = "";
    let completed = false;
    invokeMock.mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === "load_settings")
        return Promise.resolve({
          ...CONFIGURED,
          llm: {
            provider: "custom",
            baseUrl: "http://127.0.0.1:1234/v1",
            model: "local-test",
            temperature: 0.2,
          },
        });
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "scan_mods") return Promise.resolve(scan);
      if (cmd === "load_strings") {
        const modUniqueId = (args as { modUniqueId: string }).modUniqueId;
        const first = modUniqueId === "a.b";
        return Promise.resolve([
          {
            key: first ? "first" : "second",
            source: first ? "First" : "Second",
            target: completed ? (first ? "Erste" : "Zweite") : "",
            targetPresent: completed,
            status: completed ? "review-needed" : "untranslated",
          },
        ]);
      }
      if (cmd === "translate_with_local_ai") {
        activeRunId = (args as { request: { runId: string } }).request.runId;
        backendHistory = [
          aiHistory({
            outcome: "success",
            itemCount: 2,
            title: "Local AI translation run",
            summary: "2 suggestions saved to Review",
          }),
        ];
        return new Promise((resolve) => {
          releaseTranslation = resolve;
        });
      }
      return Promise.resolve(null);
    });

    render(<App />);
    openWorkspace();
    fireEvent.click(await screen.findByRole("button", { name: "All mods" }));
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Select first" }),
    );
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Select second" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "2 selected" }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: /Translate selected with AI/ }),
    );
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("translate_with_local_ai", {
        request: expect.objectContaining({
          identities: [
            { modUniqueId: "a.b", relativeDir: "i18n", key: "first" },
            {
              modUniqueId: "second.mod",
              relativeDir: "i18n",
              key: "second",
            },
          ],
        }),
      }),
    );
    if (!releaseTranslation) throw new Error("AI request did not start");
    completed = true;
    act(() => {
      releaseTranslation?.({
        runId: activeRunId,
        engine: "local",
        model: "local-test",
        reasoning: "default",
        scope: "selected",
        requested: 2,
        completed: 2,
        outcome: "complete",
        suggestions: [
          {
            identity: {
              modUniqueId: "a.b",
              relativeDir: "i18n",
              key: "first",
            },
            text: "Erste",
            status: "review-needed",
            tokenDifferences: [],
            glossaryMisses: [],
          },
          {
            identity: {
              modUniqueId: "second.mod",
              relativeDir: "i18n",
              key: "second",
            },
            text: "Zweite",
            status: "review-needed",
            tokenDifferences: [],
            glossaryMisses: [],
          },
        ],
      });
    });

    const result = await screen.findByRole("complementary", {
      name: "Latest operation result",
    });
    fireEvent.click(
      within(result).getByRole("button", { name: "Open review queue" }),
    );
    expect(screen.getByRole("button", { name: "All mods" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("keeps error toasts assertive and dismissible while success stays polite", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "scan_mods") return Promise.resolve(exportScan(false));
      if (cmd === "load_strings")
        return Promise.resolve([
          {
            key: "greeting",
            source: "Hello",
            target: "",
            targetPresent: false,
            status: "untranslated",
          },
        ]);
      return Promise.resolve(null);
    });
    render(<App />);
    openWorkspace();

    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Select greeting" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "1 selected" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy source text" }));

    const errorToast = await screen.findByRole("alert");
    expect(errorToast).toHaveClass("stv3-toast", "is-error");
    expect(errorToast).toHaveAttribute("aria-live", "assertive");
    expect(errorToast.querySelector(".lucide-circle-x")).not.toBeNull();

    vi.useFakeTimers();
    act(() => vi.advanceTimersByTime(3_000));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    vi.useRealTimers();

    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss notification" }),
    );
    expect(screen.queryByRole("alert")).toBeNull();

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    fireEvent.click(screen.getByRole("button", { name: "1 selected" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy source text" }));
    const successToast = await screen.findByRole("status");
    expect(successToast).toHaveClass("stv3-toast", "is-success");
    expect(successToast).toHaveAttribute("aria-live", "polite");
    expect(successToast.querySelector(".lucide-circle-check")).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: "Dismiss notification" }),
    ).toBeNull();
  });

  it("resolves an export problem after its token mismatch is explicitly accepted", async () => {
    const blocked = {
      ...EXPORT_RESULT,
      files: [],
      skipped: [
        {
          relativeDir: "i18n",
          key: "greeting",
          reason: "Missing protected token: {{name}}",
        },
      ],
      filesWritten: 0,
      totalWrittenKeys: 0,
      blocked: true,
    };
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "scan_mods") return Promise.resolve(exportScan(false));
      if (cmd === "load_strings")
        return Promise.resolve([
          {
            key: "greeting",
            source: "Hello {{name}}",
            target: "Hallo",
            targetPresent: true,
            status: "translated",
          },
        ]);
      if (cmd === "export_mod") return Promise.resolve(blocked);
      return Promise.resolve(null);
    });
    render(<App />);
    openWorkspace();

    await screen.findByText("greeting");
    chooseToolbarAction("Export actions", "Export current mod");
    fireEvent.click(screen.getByRole("button", { name: "Export" }));

    const tray = await screen.findByRole("complementary", {
      name: "Latest operation result",
    });
    expect(tray).toHaveTextContent("Export blocked");
    expect(tray).toHaveTextContent("greeting");
    fireEvent.click(screen.getByRole("button", { name: "Open issue" }));
    expect(
      screen.getByRole("searchbox", { name: "Search strings" }),
    ).toHaveValue("greeting");
    expect(
      screen.queryByRole("complementary", { name: "Latest operation result" }),
    ).toBeNull();

    await screen.findByRole("dialog", { name: "greeting" });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Save anyway" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "greeting" })).toBeNull(),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Latest result" }),
    );

    expect(await screen.findByText(/greeting · Resolved/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Export again" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Overview" }));
    expect(
      await screen.findByText("Last export · Unavailable in this session"),
    ).toBeInTheDocument();
  });

  it("replaces invalid native-drop details inside the import dialog", async () => {
    mockExportConfigured(false);
    render(<App />);
    openWorkspace();
    expect(await screen.findAllByText("Test Mod")).not.toHaveLength(0);
    await waitFor(() => expect(fileDropHandler).not.toBeNull());

    act(() => {
      fileDropHandler?.({
        type: "drop",
        paths: ["C:/one.json", "C:/two.json"],
      });
    });
    let importDialog = await screen.findByRole("dialog", {
      name: "Import LLM batch",
    });
    expect(importDialog).toHaveTextContent(
      "Choose only one JSON file. Nothing was imported.",
    );
    expect(
      within(importDialog).getByRole("button", { name: "Import file" }),
    ).toBeDisabled();
    fireEvent.click(
      within(importDialog).getByRole("button", { name: "Cancel import" }),
    );

    act(() => {
      fileDropHandler?.({ type: "drop", paths: ["C:/result.txt"] });
    });
    importDialog = await screen.findByRole("dialog", {
      name: "Import LLM batch",
    });
    expect(importDialog).toHaveTextContent(
      "Invalid file type. Exactly one JSON batch file is required.",
    );
    expect(importDialog).toHaveTextContent("C:/result.txt");
    expect(
      within(importDialog).getByRole("button", { name: "Import file" }),
    ).toBeDisabled();
  });

  it("previews and builds a translation-only package ZIP", async () => {
    const preview = {
      packageName: "Test Mod",
      selectedVersion: "1.0",
      versionSource: "Test Mod",
      versionConflicts: [],
      defaultFileName: "Test Mod - 1.0 - German (de).zip",
      targetLang: "de",
      targetLanguage: "German",
      entries: [
        {
          modName: "Test Mod",
          modVersion: "1.0",
          archivePath: "Test Mod/i18n/de.json",
          strings: 1,
          totalSourceStrings: 1,
          outdated: 0,
          reviewNeeded: 0,
        },
      ],
      omittedComponents: [],
      warnings: [],
      problems: [],
      totalStrings: 1,
      totalSourceStrings: 1,
    };
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "scan_mods") return Promise.resolve(exportScan(false));
      if (cmd === "load_strings") return Promise.resolve([]);
      if (cmd === "preview_translation_zip") return Promise.resolve(preview);
      if (cmd === "pick_translation_zip_destination")
        return Promise.resolve("C:/release/Test Mod.zip");
      if (cmd === "build_translation_zip")
        return Promise.resolve({
          path: "C:/release/Test Mod.zip",
          folder: "C:/release",
          fileName: "Test Mod.zip",
          entries: 1,
          strings: 1,
        });
      return Promise.resolve(null);
    });
    render(<App />);
    openWorkspace();
    expect(await screen.findAllByText("Test Mod")).not.toHaveLength(0);
    chooseToolbarAction("Export actions", "Build translation ZIP");

    await screen.findByText("Test Mod/i18n/de.json");
    expect(
      screen.getByRole("dialog", { name: "Build translation ZIP" }),
    ).toHaveTextContent("Test Mod/i18n/de.json");
    const chooseLocation = screen.getByRole("button", {
      name: "Choose save location …",
    });
    await waitFor(() => expect(chooseLocation).toBeEnabled());
    fireEvent.click(chooseLocation);
    const result = await screen.findByRole("complementary", {
      name: "Latest operation result",
    });
    expect(result).toHaveTextContent("ZIP created");
    expect(invokeMock).toHaveBeenCalledWith(
      "build_translation_zip",
      expect.objectContaining({
        request: expect.objectContaining({
          packageName: "Test Mod",
          targetLang: "de",
          destination: "C:/release/Test Mod.zip",
          overwrite: false,
        }),
      }),
    );
    fireEvent.click(
      within(result).getByRole("button", { name: "Translation notes" }),
    );
    await screen.findByLabelText("Generated release notes");
    expect(
      screen.queryByRole("complementary", {
        name: "Latest operation result",
      }),
    ).toBeNull();
    expect(
      (screen.getByLabelText("Generated release notes") as HTMLTextAreaElement)
        .value,
    ).toContain("Archiv: Test Mod.zip");
    fireEvent.click(
      screen.getByRole("button", { name: "Close translation notes" }),
    );
    expect(
      await screen.findByRole("complementary", {
        name: "Latest operation result",
      }),
    ).toBeInTheDocument();
  });

  it("keeps the LLM dialog after native Save cancellation and reports a later export", async () => {
    let exportAttempts = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "scan_mods") return Promise.resolve(exportScan(false));
      if (cmd === "load_strings")
        return Promise.resolve([
          {
            key: "greeting",
            source: "Hello",
            target: "",
            targetPresent: false,
            status: "untranslated",
          },
        ]);
      if (cmd === "export_llm_batch") {
        exportAttempts += 1;
        if (exportAttempts === 1) return Promise.resolve(null);
        backendHistory = [batchExportHistory()];
        return Promise.resolve({
          path: "C:/out/test.llm-batch.json",
          stringCount: 1,
        });
      }
      return Promise.resolve(null);
    });
    render(<App />);
    openWorkspace();
    const keyButton = await screen.findByRole("button", { name: "greeting" });
    fireEvent.contextMenu(keyButton);
    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: /Export LLM batch/,
      }),
    );

    const saveDialog = screen.getByRole("dialog", { name: "Save LLM batch" });
    expect(saveDialog).toHaveTextContent("1 eligible strings");
    expect(
      within(saveDialog).getByRole("button", { name: "Change …" }),
    ).toBeEnabled();
    fireEvent.click(
      within(saveDialog).getByRole("button", { name: "Save JSON batch" }),
    );

    await waitFor(() => expect(exportAttempts).toBe(1));
    expect(
      screen.getByRole("dialog", { name: "Save LLM batch" }),
    ).toBeVisible();
    fireEvent.click(
      within(saveDialog).getByRole("button", { name: "Save JSON batch" }),
    );

    const tray = await screen.findByRole("complementary", {
      name: "Latest operation result",
    });
    expect(tray).toHaveTextContent("LLM batch exported");
    expect(tray).toHaveTextContent("C:/out/test.llm-batch.json");
    expect(invokeMock).toHaveBeenCalledWith("export_llm_batch", {
      modUniqueId: "a.b",
      items: [
        {
          relativeDir: "i18n",
          key: "greeting",
          source: "Hello",
        },
      ],
    });
    expect(
      screen.queryByRole("dialog", { name: "Save LLM batch" }),
    ).not.toBeInTheDocument();
  });

  it("changes the LLM destination first and exports to that exact path", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "scan_mods") return Promise.resolve(exportScan(false));
      if (cmd === "load_strings")
        return Promise.resolve([
          {
            key: "greeting",
            source: "Hello",
            target: "",
            targetPresent: false,
            status: "untranslated",
          },
        ]);
      if (cmd === "pick_llm_batch_destination")
        return Promise.resolve("C:/chosen/custom.json");
      if (cmd === "export_llm_batch_to_path") {
        backendHistory = [
          batchExportHistory({
            path: "C:/chosen/custom.json",
            fileName: "custom.json",
          }),
        ];
        return Promise.resolve({
          path: "C:/chosen/custom.json",
          stringCount: 1,
        });
      }
      return Promise.resolve(null);
    });
    render(<App />);
    openWorkspace();
    const keyButton = await screen.findByRole("button", { name: "greeting" });
    fireEvent.contextMenu(keyButton);
    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: /Export LLM batch/,
      }),
    );
    const saveDialog = screen.getByRole("dialog", { name: "Save LLM batch" });

    fireEvent.click(
      within(saveDialog).getByRole("button", { name: "Change …" }),
    );
    expect(await screen.findByText("C:/chosen/custom.json")).toBeVisible();
    expect(
      within(saveDialog).getByRole("textbox", { name: "File name" }),
    ).toHaveValue("custom.json");
    fireEvent.click(
      within(saveDialog).getByRole("button", { name: "Save JSON batch" }),
    );

    const tray = await screen.findByRole("complementary", {
      name: "Latest operation result",
    });
    expect(tray).toHaveTextContent("C:/chosen/custom.json");
    expect(invokeMock).toHaveBeenCalledWith("pick_llm_batch_destination", {
      suggestedFileName: "a.b.llm-batch.json",
    });
    expect(invokeMock).toHaveBeenCalledWith("export_llm_batch_to_path", {
      modUniqueId: "a.b",
      items: [
        {
          relativeDir: "i18n",
          key: "greeting",
          source: "Hello",
        },
      ],
      path: "C:/chosen/custom.json",
    });
  });

  it("generates release notes independently for the selected package", async () => {
    const preview = {
      packageName: "Test Mod",
      selectedVersion: "1.0",
      versionSource: "Test Mod",
      versionConflicts: [],
      defaultFileName: "Test Mod - 1.0 - German (de).zip",
      targetLang: "de",
      targetLanguage: "German",
      entries: [
        {
          modName: "Test Mod",
          modVersion: "1.0",
          archivePath: "Test Mod/i18n/de.json",
          strings: 1,
          totalSourceStrings: 1,
          outdated: 0,
          reviewNeeded: 0,
        },
      ],
      omittedComponents: [],
      warnings: [],
      problems: [],
      totalStrings: 1,
      totalSourceStrings: 1,
    };
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "scan_mods") return Promise.resolve(exportScan(false));
      if (cmd === "load_strings") return Promise.resolve([]);
      if (cmd === "preview_translation_zip") return Promise.resolve(preview);
      return Promise.resolve(null);
    });
    render(<App />);
    openWorkspace();
    expect(await screen.findAllByText("Test Mod")).not.toHaveLength(0);
    chooseToolbarAction("Export actions", "Translation notes");
    await screen.findByLabelText("Generated release notes");
    const dialog = screen.getByRole("dialog", {
      name: "Translation notes",
    });
    expect(
      within(dialog).getByLabelText("Generated release notes"),
    ).toHaveAttribute("readonly");
    expect(
      (
        within(dialog).getByLabelText(
          "Generated release notes",
        ) as HTMLTextAreaElement
      ).value,
    ).toContain("Deutsche Übersetzung für Test Mod 1.0");
  });

  it("reuses the edited ZIP version and archive name in release notes", async () => {
    const preview = {
      packageName: "Test Mod",
      selectedVersion: "1.0",
      versionSource: "Test Mod",
      versionConflicts: [],
      defaultFileName: "Test Mod - 1.0 - German (de).zip",
      targetLang: "de",
      targetLanguage: "German",
      entries: [
        {
          modName: "Test Mod",
          modVersion: "1.0",
          archivePath: "Test Mod/i18n/de.json",
          strings: 1,
          totalSourceStrings: 1,
          outdated: 0,
          reviewNeeded: 0,
        },
      ],
      omittedComponents: [],
      warnings: [],
      problems: [],
      totalStrings: 1,
      totalSourceStrings: 1,
    };
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "scan_mods") return Promise.resolve(exportScan(false));
      if (cmd === "load_strings") return Promise.resolve([]);
      if (cmd === "preview_translation_zip") return Promise.resolve(preview);
      return Promise.resolve(null);
    });
    render(<App />);
    openWorkspace();
    expect(await screen.findAllByText("Test Mod")).not.toHaveLength(0);
    chooseToolbarAction("Export actions", "Build translation ZIP");
    await screen.findByLabelText("Package version");
    const zipDialog = screen.getByRole("dialog", {
      name: "Build translation ZIP",
    });
    fireEvent.change(within(zipDialog).getByLabelText("Package version"), {
      target: { value: "1.1/beta" },
    });
    fireEvent.click(
      within(zipDialog).getByRole("button", { name: "Translation notes" }),
    );
    const releaseDialog = await screen.findByRole("dialog", {
      name: "Translation notes",
    });
    const text = (
      within(releaseDialog).getByLabelText(
        "Generated release notes",
      ) as HTMLTextAreaElement
    ).value;
    expect(text).toContain("Test Mod 1.1/beta");
    expect(text).toContain("Test Mod - 1.1_beta - German (de).zip");
    expect(
      screen.queryByRole("dialog", { name: "Build translation ZIP" }),
    ).toBeNull();
    fireEvent.click(
      within(releaseDialog).getByRole("button", {
        name: "Close translation notes",
      }),
    );
    expect(
      screen.queryByRole("dialog", { name: "Build translation ZIP" }),
    ).toBeNull();
  });

  it("closes the ZIP preview when opening a blocking problem", async () => {
    const preview = {
      packageName: "Test Mod",
      selectedVersion: "1.0",
      versionSource: "Test Mod",
      versionConflicts: [],
      defaultFileName: "Test Mod - 1.0 - German (de).zip",
      targetLang: "de",
      targetLanguage: "German",
      entries: [],
      omittedComponents: [],
      warnings: [],
      problems: [
        {
          modUniqueId: "a.b",
          modName: "Test Mod",
          relativeDir: "i18n",
          key: "broken.key",
          reason: "token count mismatch",
        },
      ],
      totalStrings: 0,
      totalSourceStrings: 1,
    };
    invokeMock.mockImplementation((command: string) => {
      if (command === "load_settings") return Promise.resolve(CONFIGURED);
      if (command === "load_glossary") return Promise.resolve(null);
      if (command === "scan_mods") return Promise.resolve(exportScan(true));
      if (command === "load_strings") return Promise.resolve([]);
      if (command === "preview_translation_zip")
        return Promise.resolve(preview);
      return Promise.resolve(null);
    });
    render(<App />);
    openWorkspace();
    expect(await screen.findAllByText("Test Mod")).not.toHaveLength(0);
    chooseToolbarAction("Export actions", "Build translation ZIP");
    const problems = await screen.findByRole("list", {
      name: "Blocking ZIP problems",
    });
    expect(problems).toHaveTextContent("broken.key");
    fireEvent.click(
      within(problems).getByRole("button", { name: "Open issue" }),
    );
    expect(
      screen.queryByRole("dialog", { name: "Build translation ZIP" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("searchbox", { name: "Search strings" }),
    ).toHaveValue("broken.key");
  });

  it("asks before replacing an existing translation ZIP", async () => {
    const preview = {
      packageName: "Test Mod",
      selectedVersion: "1.0",
      versionSource: "Test Mod",
      versionConflicts: [],
      defaultFileName: "Test Mod.zip",
      targetLang: "de",
      targetLanguage: "German",
      entries: [
        {
          modName: "Test Mod",
          modVersion: "1.0",
          archivePath: "Test Mod/i18n/de.json",
          strings: 1,
          totalSourceStrings: 1,
          outdated: 0,
          reviewNeeded: 0,
        },
      ],
      omittedComponents: [],
      warnings: [],
      problems: [],
      totalStrings: 1,
      totalSourceStrings: 1,
    };
    invokeMock.mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "scan_mods") return Promise.resolve(exportScan(false));
      if (cmd === "load_strings") return Promise.resolve([]);
      if (cmd === "preview_translation_zip") return Promise.resolve(preview);
      if (cmd === "pick_translation_zip_destination")
        return Promise.resolve("C:/release/Test Mod.zip");
      if (
        cmd === "build_translation_zip" &&
        !(args as { request?: { overwrite?: boolean } })?.request?.overwrite
      )
        return Promise.reject("OVERWRITE_REQUIRED");
      if (cmd === "build_translation_zip")
        return Promise.resolve({
          path: "C:/release/Test Mod.zip",
          folder: "C:/release",
          fileName: "Test Mod.zip",
          entries: 1,
          strings: 1,
        });
      return Promise.resolve(null);
    });
    render(<App />);
    openWorkspace();
    expect(await screen.findAllByText("Test Mod")).not.toHaveLength(0);
    chooseToolbarAction("Export actions", "Build translation ZIP");
    await screen.findByLabelText("Package version");
    const chooseLocation = await screen.findByRole("button", {
      name: "Choose save location …",
    });
    await waitFor(() => expect(chooseLocation).toBeEnabled());
    fireEvent.click(chooseLocation);
    expect(
      await screen.findByRole("dialog", { name: "Confirm ZIP overwrite" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Replace ZIP" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "build_translation_zip",
        expect.objectContaining({
          request: expect.objectContaining({ overwrite: true }),
        }),
      ),
    );
  });

  it("exposes the complete keyboard-accessible V3 command bar", async () => {
    mockExportConfigured(false);
    render(<App />);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Export actions" }),
      ).toBeEnabled(),
    );

    const views = screen.getByRole("navigation", { name: "Main views" });
    expect(
      within(views)
        .getAllByRole("button")
        .map((button) => button.textContent?.trim()),
    ).toEqual(["Overview", "Workspace"]);
    expect(screen.getByRole("button", { name: "Scan mods" })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Import LLM batch" }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: "Settings" })).toBeEnabled();

    const exportButton = screen.getByRole("button", { name: "Export actions" });
    const stableLatestResult = document.querySelector<HTMLButtonElement>(
      'button[title="Reopen the latest operation result"]',
    );
    expect(stableLatestResult).not.toBeNull();
    expect(stableLatestResult).toHaveAttribute("hidden");
    expect(stableLatestResult).toHaveAttribute("data-action", "reopen-result");
    expect(stableLatestResult?.nextElementSibling).toBe(
      screen.getByRole("button", { name: "Settings" }),
    );
    fireEvent.keyDown(exportButton, { key: "ArrowDown" });
    const currentExport = screen.getByRole("menuitem", {
      name: "Export current mod",
    });
    await waitFor(() => expect(currentExport).toHaveFocus());
    expect(currentExport).toBeEnabled();
    expect(
      screen.getByRole("menuitem", { name: "Export all mods …" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("menuitem", { name: "Build translation ZIP" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("menuitem", { name: "Translation notes" }),
    ).toBeEnabled();
    expect(screen.getByRole("menu", { name: "Export" })).toHaveTextContent(
      "Advanced",
    );

    fireEvent.keyDown(currentExport, { key: "End" });
    expect(
      screen.getByRole("menuitem", { name: "Export all mods …" }),
    ).toHaveFocus();
    const allExport = screen.getByRole("menuitem", {
      name: "Export all mods …",
    });
    const settingsButton = screen.getByRole("button", { name: "Settings" });
    fireEvent.blur(allExport, { relatedTarget: settingsButton });
    await waitFor(() =>
      expect(screen.queryByRole("menu", { name: "Export" })).toBeNull(),
    );

    fireEvent.keyDown(exportButton, { key: "ArrowDown" });
    await waitFor(() =>
      expect(
        screen.getByRole("menuitem", { name: "Export current mod" }),
      ).toHaveFocus(),
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Export" })).toBeNull();
    expect(exportButton).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Import LLM batch" }));
    const importDialog = screen.getByRole("dialog", {
      name: "Import LLM batch",
    });
    expect(importDialog).toHaveTextContent("No file selected");
    expect(
      within(importDialog).getByRole("button", { name: "Import file" }),
    ).toBeDisabled();
  });

  it("rescans after a settings language change without opening extra-key cleanup", async () => {
    const extraKeyScan = {
      ...EMPTY_SCAN,
      extraKeys: [
        {
          modName: "Example Mod",
          relativeDir: "i18n",
          targetPath: "E:/Mods/Example/i18n/fr.json",
          key: "removed-after-switch",
        },
      ],
    };
    let scans = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "glossary_status")
        return Promise.resolve({
          gameXnbPresent: false,
          unpackedPresent: false,
          sourceAvailable: false,
          cached: null,
          outdatedCache: false,
          packAvailable: false,
          packXnbAvailable: false,
        });
      if (cmd === "save_settings") return Promise.resolve(null);
      if (cmd === "scan_mods") {
        scans += 1;
        return Promise.resolve(scans === 1 ? EMPTY_SCAN : extraKeyScan);
      }
      return Promise.resolve(null);
    });
    render(<App />);

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("scan_mods", {
        modsPath: "E:/SDV/Mods",
        targetLang: "de",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.change(screen.getByLabelText("Target language"), {
      target: { value: "fr" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("scan_mods", {
        modsPath: "E:/SDV/Mods",
        targetLang: "fr",
      }),
    );
    expect(screen.queryByText("removed-after-switch")).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Scan" })).toBeNull();
  });

  it("changes only the selected Mods folder and rescans the saved workspace", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "glossary_status") return Promise.resolve(null);
      if (cmd === "pick_folder") return Promise.resolve("E:/Other/Mods");
      if (cmd === "save_settings") return Promise.resolve(null);
      if (cmd === "scan_mods") return Promise.resolve(EMPTY_SCAN);
      return Promise.resolve(null);
    });
    render(<App />);

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("scan_mods", {
        modsPath: "E:/SDV/Mods",
        targetLang: "de",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Change Mods folder" }));

    expect(await screen.findByText("E:/Other/Mods")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Setup" })).toBeNull();
    expect(invokeMock).toHaveBeenCalledWith("pick_folder", {
      title: "Select your Mods folder",
    });

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("save_settings", {
        settings: expect.objectContaining({
          stardewPath: "E:/SDV",
          modsPath: "E:/Other/Mods",
          targetLang: "de",
        }),
      }),
    );
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("scan_mods", {
        modsPath: "E:/Other/Mods",
        targetLang: "de",
      }),
    );
  });

  it("does not apply or rescan a language when settings persistence fails", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "glossary_status") return Promise.resolve(null);
      if (cmd === "scan_mods") return Promise.resolve(EMPTY_SCAN);
      if (cmd === "save_settings")
        return Promise.reject(new Error("settings file is locked"));
      return Promise.resolve(null);
    });
    render(<App />);

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("scan_mods", {
        modsPath: "E:/SDV/Mods",
        targetLang: "de",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.change(screen.getByLabelText("Target language"), {
      target: { value: "fr" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "settings file is locked",
    );
    expect(invokeMock).not.toHaveBeenCalledWith("scan_mods", {
      modsPath: "E:/SDV/Mods",
      targetLang: "fr",
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByLabelText("Target language")).toHaveValue("de");
  });

  it("preserves AI and portable workspace settings when setup is run again", async () => {
    const llm = {
      provider: "custom",
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "local-test",
      temperature: 0.15,
    };
    const ai = {
      defaultEngine: "codex" as const,
      codexReasoning: "high" as const,
    };
    const shortcuts = { "editor.save": "Ctrl+S" };
    const lastOpened = { "a.b": 1_234 };
    const workspace = {
      selectedModId: "a.b",
      modSearch: "",
      stringSearch: "",
      stringScope: "mod" as const,
      statusFilter: "all" as const,
      issuesOnly: false,
      sort: null,
      modPaneWidth: 340,
      columnWidths: {},
    };
    const settings = {
      ...CONFIGURED,
      llm,
      ai,
      shortcuts,
      lastOpened,
      workspace,
      diagnosticLogging: false,
    };
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(settings);
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "scan_mods") return Promise.resolve(exportScan(false));
      if (cmd === "load_strings") return Promise.resolve([]);
      if (cmd === "glossary_status")
        return Promise.resolve({
          gameXnbPresent: false,
          unpackedPresent: false,
          sourceAvailable: false,
          cached: null,
          outdatedCache: false,
          packAvailable: false,
          packXnbAvailable: false,
        });
      return Promise.resolve(null);
    });

    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Settings" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const settingsDialog = await screen.findByRole("dialog", {
      name: "Settings",
    });
    fireEvent.click(
      within(settingsDialog).getByRole("button", { name: "Setup …" }),
    );

    const setup = await screen.findByRole("dialog", { name: "Setup" });
    fireEvent.click(within(setup).getByRole("button", { name: "Next" }));
    await within(setup).findByRole("region", { name: "Mods folder" });
    fireEvent.click(within(setup).getByRole("button", { name: "Next" }));
    const targetLanguage =
      await within(setup).findByLabelText("Target language");
    fireEvent.change(targetLanguage, { target: { value: "fr" } });
    fireEvent.click(within(setup).getByRole("button", { name: "Next" }));
    fireEvent.click(
      await within(setup).findByRole("button", { name: "Finish" }),
    );

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("save_settings", {
        settings: {
          ...CONFIGURED,
          targetLang: "fr",
          llm,
          ai,
          shortcuts,
          lastOpened,
          workspace,
          diagnosticLogging: false,
        },
      }),
    );
  });

  it("opens the setup wizard on first launch (no saved Stardew path)", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings")
        return Promise.resolve({
          stardewPath: null,
          modsPath: null,
          sourceLang: "default",
          targetLang: null,
        });
      if (cmd === "load_glossary") return Promise.resolve(null);
      return Promise.resolve(null);
    });
    render(<App />);

    expect(
      await screen.findByRole("dialog", { name: "Setup" }),
    ).toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalledWith("scan_mods", expect.anything());
  });

  it("imports one dropped JSON result into the selected mod", async () => {
    const summary = {
      imported: 1,
      skippedTranslated: 0,
      unmatched: 0,
      identicalToSource: 0,
      totalInFile: 1,
    };
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "scan_mods") return Promise.resolve(exportScan(false));
      if (cmd === "load_strings") return Promise.resolve([]);
      if (cmd === "preflight_llm_batch_path")
        return Promise.resolve(READY_IMPORT_PREFLIGHT);
      if (cmd === "import_llm_batch_path") {
        backendHistory = [importHistory()];
        return Promise.resolve(summary);
      }
      return Promise.resolve(null);
    });
    render(<App />);
    openWorkspace();

    expect(await screen.findAllByText("Test Mod")).not.toHaveLength(0);
    await waitFor(() => expect(fileDropHandler).not.toBeNull());

    act(() => {
      fileDropHandler?.({
        type: "enter",
        paths: ["C:/results/test.llm-result.json"],
      });
    });
    expect(await screen.findByText("Import into Test Mod")).toBeInTheDocument();
    const dropState = document.querySelector(".stv3-native-drop-state");
    expect(dropState).toHaveClass(
      "stv3-file-choice",
      "stv3-drop-zone",
      "is-dragging",
    );
    expect(document.querySelector(".batchdrop")).toBeNull();

    act(() => {
      fileDropHandler?.({
        type: "drop",
        paths: ["C:/results/test.llm-result.json"],
      });
    });
    const dialog = await screen.findByRole("dialog", {
      name: "Import LLM batch",
    });
    expect(dialog).toHaveTextContent("test.llm-result.json");
    expect(dialog).toHaveTextContent("C:/results/test.llm-result.json");
    expect(await within(dialog).findByText("Ready to import")).toBeVisible();
    expect(dialog).toHaveTextContent("1 / 1");
    expect(invokeMock).toHaveBeenCalledWith("preflight_llm_batch_path", {
      modUniqueId: "a.b",
      files: [
        {
          relativeDir: "i18n",
          defaultPath: "x/i18n/default.json",
          targetPath: "x/i18n/de.json",
        },
      ],
      path: "C:/results/test.llm-result.json",
    });
    expect(invokeMock).not.toHaveBeenCalledWith(
      "import_llm_batch_path",
      expect.anything(),
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Import file" }),
    );
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("import_llm_batch_path", {
        modUniqueId: "a.b",
        files: [
          {
            relativeDir: "i18n",
            defaultPath: "x/i18n/default.json",
            targetPath: "x/i18n/de.json",
          },
        ],
        path: "C:/results/test.llm-result.json",
      }),
    );
    const result = await screen.findByRole("complementary", {
      name: "Latest operation result",
    });
    expect(result).toHaveTextContent("1 of 1 value saved to the review queue");
    expect(result).toHaveTextContent("test.llm-result.json");
    expect(result).toHaveTextContent("C:/results/test.llm-result.json");
    fireEvent.click(
      within(result).getByRole("button", { name: "Open review queue" }),
    );
    expect(
      screen.queryByRole("complementary", { name: "Latest operation result" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Latest result" })).toBeVisible();
    expect(screen.getByRole("button", { name: /^Review/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "This mod" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("closes a rejected import before exposing Choose another file", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "scan_mods") return Promise.resolve(exportScan(false));
      if (cmd === "load_strings") return Promise.resolve([]);
      if (cmd === "preflight_llm_batch_path")
        return Promise.resolve(READY_IMPORT_PREFLIGHT);
      if (cmd === "import_llm_batch_path")
        return Promise.reject(new Error("snapshot mismatch"));
      return Promise.resolve(null);
    });
    render(<App />);
    openWorkspace();
    expect(await screen.findAllByText("Test Mod")).not.toHaveLength(0);
    await waitFor(() => expect(fileDropHandler).not.toBeNull());

    act(() => {
      fileDropHandler?.({
        type: "drop",
        paths: ["C:/results/mismatch.llm-result.json"],
      });
    });
    const importDialog = await screen.findByRole("dialog", {
      name: "Import LLM batch",
    });
    expect(
      await within(importDialog).findByText("Ready to import"),
    ).toBeVisible();
    fireEvent.click(
      within(importDialog).getByRole("button", { name: "Import file" }),
    );

    const result = await screen.findByRole("complementary", {
      name: "Latest operation result",
    });
    expect(
      screen.queryByRole("dialog", { name: "Import LLM batch" }),
    ).toBeNull();
    expect(result).toHaveTextContent("LLM import rejected");
    expect(result).toHaveTextContent("No changes were made");
    fireEvent.click(
      within(result).getByRole("button", { name: "Choose another file" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Import LLM batch" }),
    ).toBeInTheDocument();
  });

  it("rejects a dropped result when no mod is selected", async () => {
    mockConfigured(EMPTY_SCAN);
    render(<App />);
    await waitFor(() => expect(fileDropHandler).not.toBeNull());

    act(() => {
      fileDropHandler?.({
        type: "enter",
        paths: ["C:/results/test.json"],
      });
    });
    expect(await screen.findByText("Select a mod first")).toBeInTheDocument();
    act(() => {
      fileDropHandler?.({
        type: "drop",
        paths: ["C:/results/test.json"],
      });
    });

    expect(
      await screen.findByRole("complementary", {
        name: "Latest operation result",
      }),
    ).toHaveTextContent("Select a mod before dropping");
    expect(invokeMock).not.toHaveBeenCalledWith(
      "import_llm_batch_path",
      expect.anything(),
    );
  });

  it("shows multiple or non-JSON native drops as inline invalid import states", async () => {
    mockExportConfigured(false);
    render(<App />);
    openWorkspace();
    expect(await screen.findAllByText("Test Mod")).not.toHaveLength(0);
    await waitFor(() => expect(fileDropHandler).not.toBeNull());

    act(() => {
      fileDropHandler?.({
        type: "drop",
        paths: ["C:/one.json", "C:/two.json"],
      });
    });
    let dialog = await screen.findByRole("dialog", {
      name: "Import LLM batch",
    });
    expect(dialog).toHaveTextContent("Choose only one JSON file");
    expect(
      within(dialog).getByRole("button", { name: "Import file" }),
    ).toBeDisabled();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Cancel import" }),
    );

    act(() => {
      fileDropHandler?.({ type: "drop", paths: ["C:/result.txt"] });
    });
    dialog = await screen.findByRole("dialog", {
      name: "Import LLM batch",
    });
    expect(dialog).toHaveTextContent("Invalid file type");
    expect(dialog).toHaveTextContent("C:/result.txt");
    expect(
      within(dialog).getByRole("button", { name: "Import file" }),
    ).toBeDisabled();
    expect(invokeMock).not.toHaveBeenCalledWith(
      "import_llm_batch_path",
      expect.anything(),
    );
  });

  it("automatically scans and shows discovered mods on configured startup", async () => {
    mockConfigured({
      mods: [
        {
          uniqueId: "a.b",
          name: "Test Mod",
          version: "1.0",
          nexusId: 7286,
          packageId: "Test Mod",
          folderPath: "E:/SDV/Mods/Test Mod",
          i18nFiles: [
            {
              relativeDir: "i18n",
              defaultPath: "x/i18n/default.json",
              targetPath: "x/i18n/de.json",
              targetExists: false,
              totalKeys: 5,
              translatedKeys: 0,
              reviewNeeded: 2,
            },
          ],
          totalKeys: 5,
          translatedKeys: 0,
          reviewNeeded: 2,
          progress: 0,
          status: "untranslated",
        },
      ],
      warnings: [],
      modCount: 1,
      fileCount: 1,
    });

    render(<App />);
    openWorkspace();

    // The accepted V3 workspace auto-selects the most recently used (or first
    // real) scanned component once the user opens it from Overview.
    expect(await screen.findAllByText("Test Mod")).not.toHaveLength(0);
    expect(screen.getByRole("treeitem", { name: /7286/ })).toBeInTheDocument();
    expect(
      screen.getByRole("searchbox", { name: "Search strings" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Overview" }));
    const overview = await screen.findByRole("main", { name: "Overview" });
    expect(overview).toHaveTextContent("1 mods");
    expect(overview).not.toHaveTextContent("Needs attention");
    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    expect(
      await screen.findByRole("searchbox", { name: "Search strings" }),
    ).toBeInTheDocument();
  });

  it("searches strings across mods before one is selected", async () => {
    const scan = exportScan(false);
    scan.mods.push({
      ...scan.mods[0],
      uniqueId: "second.mod",
      name: "Second Mod",
      packageId: "Second Mod",
      folderPath: "y",
      i18nFiles: [
        {
          relativeDir: "i18n",
          defaultPath: "y/i18n/default.json",
          targetPath: "y/i18n/de.json",
          targetExists: true,
          totalKeys: 1,
          translatedKeys: 1,
          reviewNeeded: 0,
        },
      ],
    });
    scan.modCount = 2;
    scan.fileCount = 2;

    invokeMock.mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "scan_mods") return Promise.resolve(scan);
      if (cmd === "load_strings") {
        const modUniqueId = (args as { modUniqueId: string }).modUniqueId;
        return Promise.resolve(
          modUniqueId === "second.mod"
            ? [
                {
                  key: "festival.answer",
                  source: "The dance starts at noon",
                  target: "Der Tanz beginnt mittags",
                  targetPresent: true,
                  status: "translated",
                },
              ]
            : [],
        );
      }
      return Promise.resolve(null);
    });

    render(<App />);
    openWorkspace();
    expect(await screen.findAllByText("Test Mod")).not.toHaveLength(0);
    await screen.findByRole("searchbox", { name: "Search strings" });
    fireEvent.click(screen.getByRole("button", { name: "All mods" }));
    await screen.findByRole("searchbox", { name: "Search strings" });
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search strings" }),
      { target: { value: "mittags" } },
    );

    expect(await screen.findByText("festival.answer")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("treeitem", { name: /Second Mod/ }));
    expect(
      await screen.findByRole("main", { name: "String table" }),
    ).toHaveTextContent("festival.answer");
    expect(
      screen.getByRole("searchbox", { name: "Search strings" }),
    ).toHaveValue("mittags");
  });

  it("returns to global search from the strings panel header", async () => {
    const scan = exportScan(false);
    scan.mods.push({
      ...scan.mods[0],
      uniqueId: "second.mod",
      name: "Second Mod",
      packageId: "Second Mod",
      folderPath: "y",
      i18nFiles: [
        {
          relativeDir: "i18n",
          defaultPath: "y/i18n/default.json",
          targetPath: "y/i18n/de.json",
          targetExists: true,
          totalKeys: 1,
          translatedKeys: 1,
          reviewNeeded: 0,
        },
      ],
    });
    scan.modCount = 2;
    scan.fileCount = 2;

    invokeMock.mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "scan_mods") return Promise.resolve(scan);
      if (cmd === "load_strings") {
        const modUniqueId = (args as { modUniqueId: string }).modUniqueId;
        return Promise.resolve(
          modUniqueId === "second.mod"
            ? [
                {
                  key: "festival.answer",
                  source: "The dance starts at noon",
                  target: "Der Tanz beginnt mittags",
                  targetPresent: true,
                  status: "translated",
                },
              ]
            : [],
        );
      }
      return Promise.resolve(null);
    });

    render(<App />);
    openWorkspace();
    expect(await screen.findAllByText("Test Mod")).not.toHaveLength(0);
    await screen.findByRole("searchbox", { name: "Search strings" });
    fireEvent.click(screen.getByRole("button", { name: "All mods" }));
    await screen.findByRole("searchbox", { name: "Search strings" });
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search strings" }),
      { target: { value: "mittags" } },
    );

    fireEvent.click(
      await screen.findByRole("treeitem", { name: /Second Mod/ }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "All mods" }));

    // The global result is reachable again with the query intact.
    expect(await screen.findByText("festival.answer")).toBeInTheDocument();
    expect(
      screen.getByRole("searchbox", { name: "Search strings" }),
    ).toHaveValue("mittags");
  });

  it("keeps Review as an explicit workspace filter", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "scan_mods")
        return Promise.resolve({
          mods: [
            {
              uniqueId: "a.b",
              name: "Test Mod",
              version: "1.0",
              nexusId: null,
              packageId: "Test Mod",
              folderPath: "x",
              i18nFiles: [
                {
                  relativeDir: "i18n",
                  defaultPath: "x/i18n/default.json",
                  targetPath: "x/i18n/de.json",
                  targetExists: true,
                  totalKeys: 1,
                  translatedKeys: 1,
                  reviewNeeded: 1,
                },
              ],
              totalKeys: 1,
              translatedKeys: 1,
              reviewNeeded: 1,
              progress: 1,
              status: "translated",
            },
          ],
          warnings: [],
          modCount: 1,
          fileCount: 1,
        });
      if (cmd === "load_strings")
        return Promise.resolve([
          {
            key: "greeting",
            source: "Hello",
            target: "Hallo KI",
            targetPresent: true,
            status: "review-needed",
          },
        ]);
      return Promise.resolve(null);
    });

    render(<App />);
    openWorkspace();
    const review = await screen.findByRole("button", { name: /^Review\b/ });
    fireEvent.click(review);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Review\b/ })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    expect(
      await screen.findByRole("main", { name: "String table" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Hallo KI")).toBeInTheDocument();
  });

  it("keeps Changed as an explicit workspace filter", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "scan_mods")
        return Promise.resolve({
          mods: [
            {
              uniqueId: "a.b",
              name: "Test Mod",
              version: "1.0",
              nexusId: null,
              packageId: "Test Mod",
              folderPath: "x",
              i18nFiles: [
                {
                  relativeDir: "i18n",
                  defaultPath: "x/i18n/default.json",
                  targetPath: "x/i18n/de.json",
                  targetExists: true,
                  totalKeys: 2,
                  translatedKeys: 2,
                  reviewNeeded: 1,
                },
              ],
              totalKeys: 2,
              translatedKeys: 2,
              reviewNeeded: 1,
              progress: 1,
              status: "translated",
            },
          ],
          warnings: [],
          modCount: 1,
          fileCount: 1,
        });
      if (cmd === "load_strings")
        return Promise.resolve([
          {
            key: "changed.key",
            source: "New source",
            target: "Old target",
            targetPresent: true,
            status: "outdated",
          },
          {
            key: "review.key",
            source: "Review source",
            target: "AI target",
            targetPresent: true,
            status: "review-needed",
          },
        ]);
      return Promise.resolve(null);
    });

    render(<App />);
    openWorkspace();
    await screen.findByText("changed.key");
    fireEvent.click(screen.getByRole("button", { name: /^Changed\b/ }));

    expect(
      await screen.findByRole("button", { name: /^Changed\b/ }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByText("changed.key")).toBeInTheDocument();
    expect(screen.queryByText("review.key")).toBeNull();
  });

  it("does not expose an aggregate Needs attention queue", async () => {
    mockExportConfigured(false);
    render(<App />);
    openWorkspace();

    expect(await screen.findAllByText("Test Mod")).not.toHaveLength(0);
    expect(
      screen.queryByRole("button", { name: /^Needs attention\b/ }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "All mods" }));
    expect(
      screen.queryByRole("button", { name: /^Needs attention\b/ }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Overview" }));
    expect(await screen.findByText("Recently edited")).toBeInTheDocument();
    expect(screen.queryByText("Needs attention")).toBeNull();
  });

  it("keeps Validation issues separate and clears it through an Overview status shortcut", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "scan_mods") return Promise.resolve(exportScan(false));
      if (cmd === "load_strings")
        return Promise.resolve([
          {
            key: "token.issue",
            source: "Hello {{name}}",
            target: "Hallo",
            targetPresent: true,
            status: "translated",
          },
        ]);
      return Promise.resolve(null);
    });

    render(<App />);
    openWorkspace();
    await screen.findByText("token.issue");
    fireEvent.click(
      screen.getByRole("button", { name: /^Validation issues\b/ }),
    );

    const issues = screen.getByRole("button", {
      name: /^Validation issues\b/,
    });
    expect(issues).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByText("token.issue")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Overview" }));
    fireEvent.click(
      await screen.findByRole("button", { name: /Reviewed & current/ }),
    );
    const remountedIssues = await screen.findByRole("button", {
      name: /^Validation issues\b/,
    });
    expect(remountedIssues).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: /^Done\b/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("opens the scan dialog when an automatic scan has warnings", async () => {
    mockConfigured({
      ...EMPTY_SCAN,
      warnings: ["Skipped broken manifest"],
    });
    render(<App />);

    expect(
      await screen.findByRole("dialog", { name: "Scan" }),
    ).toHaveTextContent("Skipped broken manifest");
  });

  it("opens the scan dialog when an automatic scan finds extra target keys", async () => {
    mockConfigured({
      ...EMPTY_SCAN,
      extraKeys: [
        {
          modName: "Example Mod",
          relativeDir: "i18n",
          targetPath: "E:/Mods/Example/i18n/de.json",
          key: "removed-key",
        },
      ],
    });
    render(<App />);

    expect(
      await screen.findByRole("dialog", { name: "Scan" }),
    ).toHaveTextContent("removed-key");
  });

  it("opens the scan dialog when an automatic scan fails", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "scan_mods") return Promise.reject("Mods folder not found");
      if (cmd === "load_glossary") return Promise.resolve(null);
      return Promise.resolve(null);
    });
    render(<App />);

    const dialog = await screen.findByRole("dialog", { name: "Scan" });
    expect(dialog).toHaveTextContent("Mods folder not found");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    openWorkspace();

    const skipped = screen.getByRole("button", {
      name: "Skipped components unavailable; open scan diagnostics",
    });
    expect(skipped).toHaveTextContent("Skipped · Unavailable");
    fireEvent.click(skipped);
    expect(
      await screen.findByRole("dialog", { name: "Scan" }),
    ).toHaveTextContent("Mods folder not found");
  });

  it("keeps a completed manual re-scan open until the user closes it", async () => {
    let finishScan: (result: typeof EMPTY_SCAN) => void = () => {};
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "scan_mods")
        return new Promise((resolve) => {
          finishScan = resolve;
        });
      return Promise.resolve(null);
    });
    render(<App />);

    // Finish the silent startup scan first.
    await waitFor(() =>
      expect(
        invokeMock.mock.calls.filter(([cmd]) => cmd === "scan_mods"),
      ).toHaveLength(1),
    );
    finishScan(EMPTY_SCAN);
    await waitFor(() =>
      expect(screen.getByLabelText("Scan mods")).toBeEnabled(),
    );

    fireEvent.click(screen.getByLabelText("Scan mods"));
    expect(
      await screen.findByRole("dialog", { name: "Scan" }),
    ).toHaveTextContent("Scanning mods");
    finishScan(EMPTY_SCAN);
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "Scan" })).toHaveTextContent(
        "Scan completed",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Scan" })).toBeNull();
  });

  it("does not reopen a running scan after the user dismisses it", async () => {
    const scanResolvers: Array<(result: typeof EMPTY_SCAN) => void> = [];
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "scan_mods")
        return new Promise((resolve) => {
          scanResolvers.push(resolve);
        });
      return Promise.resolve(null);
    });
    render(<App />);

    await waitFor(() => expect(scanResolvers).toHaveLength(1));
    scanResolvers.shift()!(EMPTY_SCAN);
    await waitFor(() =>
      expect(screen.getByLabelText("Scan mods")).toBeEnabled(),
    );

    fireEvent.click(screen.getByLabelText("Scan mods"));
    const dialog = await screen.findByRole("dialog", { name: "Scan" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Scan" })).toBeNull();

    scanResolvers.shift()!(EMPTY_SCAN);
    await waitFor(() =>
      expect(screen.getByLabelText("Scan mods")).toBeEnabled(),
    );
    expect(screen.queryByRole("dialog", { name: "Scan" })).toBeNull();
  });
});
