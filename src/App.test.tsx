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
const scannedTargets = new Map<string, boolean>();
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
    if (cmd === "cloud_ai_status") {
      return Promise.resolve(mocked).then(
        (value) =>
          value ?? {
            installed: false,
            authenticated: false,
            error: "ChatGPT is unavailable in this test.",
          },
      );
    }
    if (cmd === "scan_mods") {
      // Remember which targets exist, so the export preview below can plan
      // like the backend does.
      return Promise.resolve(mocked).then((value) => {
        for (const mod of (value as ScanResult | null)?.mods ?? [])
          for (const file of mod.i18nFiles)
            scannedTargets.set(file.targetPath, file.targetExists);
        return value;
      });
    }
    if (cmd === "preview_export") {
      const requested =
        (args as { mods?: ExportModInput[] } | undefined)?.mods ?? [];
      return Promise.resolve(mocked).then((value) => {
        const preflight = (value ?? {
          acceptedMismatches: 0,
          omitted: [],
        }) as Partial<ExportPreflight>;
        return {
          ...preflight,
          files:
            preflight.files ??
            requested.flatMap((mod) =>
              mod.files.map((file) => ({
                modUniqueId: mod.modUniqueId,
                targetPath: file.targetPath,
                action: scannedTargets.get(file.targetPath)
                  ? "replace"
                  : "create",
              })),
            ),
        };
      });
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
  AppSettings,
  ExportModInput,
  ExportPreflight,
  Glossary,
  LlmImportPreflight,
  OperationHistoryEntry,
  OperationKind,
  ScanResult,
  ZipPreview,
} from "./tauri/commands";

const CONFIGURED = {
  stardewPath: "E:/SDV",
  modsPath: "E:/SDV/Mods",
  sourceLang: "default",
  targetLang: "de",
  diagnosticLogging: true,
};

function combinedOutputPreview(): ZipPreview {
  return {
    packageName: "Stardew Translator Output",
    selectedVersion: "",
    versionSource: "",
    versionConflicts: [],
    defaultFileName: "Stardew Translator Output - de.zip",
    targetLang: "de",
    targetLanguage: "German",
    entries: [
      {
        modName: "Manual mod",
        modVersion: "1",
        modUniqueId: "Manual mod",
        installFolder: "Manual mod",
        archivePath: "Manual mod/i18n/de.json",
        strings: 1,
        totalSourceStrings: 1,
        outdated: 0,
        reviewNeeded: 0,
      },
      {
        modName: "AI mod",
        modVersion: "2",
        modUniqueId: "AI mod",
        installFolder: "AI mod",
        archivePath: "AI mod/i18n/de.json",
        strings: 1,
        totalSourceStrings: 1,
        outdated: 0,
        reviewNeeded: 1,
      },
    ],
    omittedComponents: [],
    warnings: [],
    problems: [],
    totalStrings: 2,
    totalSourceStrings: 2,
  };
}

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

it("shows unreadable settings without starting setup and retries after repair", async () => {
  const error = "Settings file is corrupted and no usable backup exists.";
  let repaired = false;
  invokeMock.mockImplementation((command: string) => {
    if (command === "load_settings")
      return repaired ? Promise.resolve(CONFIGURED) : Promise.reject(error);
    if (command === "scan_mods") return Promise.resolve(EMPTY_SCAN);
    return Promise.resolve(null);
  });
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  render(<App />);
  expect(await screen.findByText(error)).toBeVisible();
  expect(screen.queryByText("Game folder")).toBeNull();
  // The detail is in the Activity log once and can be copied for a report.
  expect(
    within(screen.getByRole("log")).getAllByText(
      `Could not load settings: ${error}`,
    ),
  ).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Copy details" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(error));
  expect(screen.getByRole("button", { name: "Settings" })).toBeDisabled();
  expect(invokeMock.mock.calls.some(([cmd]) => cmd === "save_settings")).toBe(
    false,
  );

  repaired = true;
  fireEvent.click(
    screen.getByRole("button", { name: "Retry loading settings" }),
  );
  await waitFor(() =>
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === "scan_mods")).toBe(
      true,
    ),
  );
  expect(screen.queryByText(error)).toBeNull();
  expect(screen.queryByText("Game folder")).toBeNull();
  expect(screen.getByRole("button", { name: "Settings" })).toBeEnabled();
  expect(invokeMock.mock.calls.some(([cmd]) => cmd === "save_settings")).toBe(
    false,
  );
});

const EMPTY_SCAN = {
  mods: [],
  warnings: [],
  extraKeys: [],
  skippedComponents: [],
  modCount: 0,
  fileCount: 0,
  sourceDeltas: {
    sourcesChanged: 0,
    stringsAdded: 0,
    stringsRemoved: 0,
    addedStrings: [],
    changedSources: [],
  },
};

const EXPORT_RESULT = {
  files: [
    {
      relativeDir: "i18n",
      targetPath: "x/i18n/de.json",
      shownPath: "Mods/x/i18n/de.json",
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
};

function exportScan(targetExists: boolean): ScanResult {
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
        statusCounts: {
          untranslated: 0,
          outdated: 0,
          "review-needed": 0,
          translated: 1,
        },
        progress: 1,
        status: "translated",
      },
    ],
    warnings: [],
    extraKeys: [],
    skippedComponents: [],
    modCount: 1,
    fileCount: 1,
    sourceDeltas: {
      sourcesChanged: 0,
      stringsAdded: 0,
      stringsRemoved: 0,
      addedStrings: [],
      changedSources: [],
    },
  };
}

/** A scan whose single mod still has one string waiting in Review. */
function withPendingReview(result: ScanResult): ScanResult {
  for (const mod of result.mods) {
    mod.reviewNeeded = 1;
    mod.i18nFiles[0].reviewNeeded = 1;
    mod.statusCounts = {
      untranslated: 0,
      outdated: 0,
      "review-needed": 1,
      translated: 0,
    };
  }
  return result;
}

function scanWithMod(uniqueId: string, name: string) {
  const result = exportScan(false);
  result.mods = [
    {
      ...result.mods[0],
      uniqueId,
      name,
      packageId: name,
    },
  ];
  return result;
}

function plannedFiles(targetExists: boolean): ExportPreflight["files"] {
  return [
    {
      modUniqueId: "a.b",
      targetPath: "x/i18n/de.json",
      action: targetExists ? "replace" : "create",
    },
  ];
}

function mockExportConfigured(
  targetExists: boolean,
  preflight: ExportPreflight = {
    acceptedMismatches: 0,
    omitted: [],
    files: plannedFiles(targetExists),
  },
) {
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
    if (cmd === "load_glossary") return Promise.resolve(null);
    if (cmd === "scan_mods") return Promise.resolve(exportScan(targetExists));
    if (cmd === "load_strings") return Promise.resolve([]);
    if (cmd === "preview_export") return Promise.resolve(preflight);
    if (cmd === "export_mod") {
      backendHistory = [exportHistory()];
      return Promise.resolve(EXPORT_RESULT);
    }
    return Promise.resolve(null);
  });
}

function mockConfigured(
  scanResult: unknown = EMPTY_SCAN,
  strings: Promise<unknown[]> = Promise.resolve([]),
) {
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
    if (cmd === "scan_mods") return Promise.resolve(scanResult);
    if (cmd === "load_glossary") return Promise.resolve(null);
    if (cmd === "load_strings") return strings;
    return Promise.resolve(null);
  });
}

/** Export flows go through the single Export… entry and its two choices. */
const EXPORT_CHOICES: Record<string, [scope: string, output: string]> = {
  "Export current mod": ["This mod", "JSON"],
  "Export all mods …": ["All mods", "JSON"],
  "Translation ZIP · current mod": ["This mod", "ZIP"],
  "Translation ZIP · all mods": ["All mods", "ZIP"],
};

function chooseExportOption(name: string) {
  const option = screen.getByRole("radio", { name });
  if (option.getAttribute("aria-checked") !== "true") fireEvent.click(option);
}

/** Chooses an action and, for a JSON export, waits until its preview has
 * replaced the ZIP preview the Export… dialog opens with. */
async function chooseToolbarAction(
  menuName: "File actions",
  actionName: string,
) {
  const choice = EXPORT_CHOICES[actionName];
  openMenuEntry(menuName, choice ? "Export…" : actionName);
  if (!choice) return;
  // A remembered JSON choice shows the dialog once its preflight is ready.
  await screen.findByRole("radio", { name: choice[0] });
  chooseExportOptions(choice);
  if (choice[1] !== "JSON") return;
  await waitFor(() =>
    expect(document.getElementById("translator-zip-title")).toBeNull(),
  );
}

function openMenuEntry(_menuName: "File actions", entry: string) {
  fireEvent.click(screen.getByRole("button", { name: "File actions" }));
  fireEvent.click(
    screen.getByRole("menuitem", { name: new RegExp("^" + entry) }),
  );
}

/** Scope first: switching to JSON starts a preflight that pauses the
 * choices until it is ready. */
function chooseExportOptions([scope, output]: [string, string]) {
  chooseExportOption(scope);
  chooseExportOption(output);
}

/** Opens Export… on a fresh session, where it starts with the ZIP preview,
 * and picks the choices without waiting for the JSON preflight. */
function startToolbarAction(menuName: "File actions", actionName: string) {
  openMenuEntry(menuName, "Export…");
  chooseExportOptions(EXPORT_CHOICES[actionName]);
}

async function inspectLatestResult() {
  await screen.findByLabelText("Operation result");
  // The notice can finish rendering after the first check on a slow CI
  // runner, so keep hiding it until the collapsed "Latest result" appears.
  const latest = await waitFor(
    () => {
      const hide = screen.queryByRole("button", { name: "Hide result" });
      if (hide) fireEvent.click(hide);
      return screen.getByRole("button", { name: "Latest result" });
    },
    { timeout: 3000 },
  );
  fireEvent.click(latest);
  await screen.findByRole("button", { name: "Back to notification" });
  return screen.getByRole("complementary", { name: "Operation result" });
}
function openWorkspace() {}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** The Setup dialog is named by its visible heading. */
const SETUP_DIALOG =
  /^(Welcome to Stardew i18n Translator|Configure your workspace)$/;

describe("App shell", () => {
  it("opens the complete workspace directly", async () => {
    const strings = deferred<unknown[]>();
    mockConfigured(exportScan(false), strings.promise);
    render(<App />);

    await screen.findByRole("region", { name: "Translation workspace" });

    expect(
      screen
        .getByRole("region", { name: "Translation workspace" })
        .querySelector(".translator-workbench"),
    ).toHaveStyle({ "--translator-mod-pane-width": "340px" });
    expect(
      screen.getByRole("region", { name: "Mod list" }),
    ).toBeInTheDocument();
    await screen.findByText("Loading strings…");
    expect(
      screen.queryByRole("searchbox", { name: "Search strings" }),
    ).toBeNull();
    const searchReady = screen.findByRole("searchbox", {
      name: "Search strings",
    });
    act(() => strings.resolve([]));
    expect(await searchReady).toBeInTheDocument();
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
    expect(screen.getByPlaceholderText("Filter mods…")).toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: SETUP_DIALOG }),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("scan_mods", {
        modsPath: "E:/SDV/Mods",
        targetLang: "de",
      }),
    );
    expect(screen.queryByRole("dialog", { name: /scan/i })).toBeNull();
  });

  it("shows the current scan's real skipped-component count", async () => {
    mockConfigured();
    render(<App />);

    const skipped = await screen.findByRole("button", {
      name: "0 items need attention; open scan results",
    });
    expect(skipped).toHaveTextContent("Scan OK");
    fireEvent.click(skipped);

    const dialog = await screen.findByRole("dialog", { name: /scan/i });
    expect(dialog).toHaveTextContent("Latest scan");
    expect(dialog).toHaveTextContent("Everything is ready");
    expect(dialog).not.toHaveTextContent("No components were skipped");
  });

  it("refreshes the workspace scan time from one minute clock", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T10:00:00Z"));
    try {
      mockConfigured(exportScan(false));
      const { unmount } = render(<App />);
      await act(async () => {
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      expect(
        screen.getByRole("main", { name: "String table" }),
      ).toHaveTextContent("scanned just now");
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      expect(
        screen.getByRole("main", { name: "String table" }),
      ).toHaveTextContent("scanned 1 min ago");
      unmount();
    } finally {
      vi.useRealTimers();
    }
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

  it("keeps the newer Settings scan when the startup scan finishes last", async () => {
    const startupScan = deferred<ReturnType<typeof exportScan>>();
    const settingsScan = deferred<ReturnType<typeof exportScan>>();
    const frenchScan = scanWithMod("french.mod", "French Mod");
    const staleGermanScan = {
      ...scanWithMod("german.mod", "German Mod"),
      warnings: ["Stale startup warning"],
    };

    invokeMock.mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "glossary_status") return Promise.resolve(null);
      if (cmd === "save_settings") return Promise.resolve(null);
      if (cmd === "scan_mods") {
        const targetLang = (args as { targetLang: string }).targetLang;
        return targetLang === "fr" ? settingsScan.promise : startupScan.promise;
      }
      if (cmd === "load_strings") return Promise.resolve([]);
      return Promise.resolve(null);
    });

    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Settings" })).toBeEnabled(),
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

    await act(async () => {
      settingsScan.resolve(frenchScan);
      await settingsScan.promise;
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull(),
    );
    openWorkspace();
    expect(
      await screen.findByRole("treeitem", { name: /French Mod/ }),
    ).toBeInTheDocument();

    await act(async () => {
      startupScan.resolve(staleGermanScan);
      await startupScan.promise;
    });
    expect(
      screen.getByRole("treeitem", { name: /French Mod/ }),
    ).toHaveAttribute("aria-current", "true");
    expect(screen.queryByRole("treeitem", { name: /German Mod/ })).toBeNull();
    expect(screen.queryByText("Stale startup warning")).toBeNull();
    expect(screen.queryByRole("dialog", { name: /scan/i })).toBeNull();
    expect(screen.getByLabelText("Scan mods")).toBeEnabled();
  });

  it("keeps the newest language glossary when the previous language resolves last", async () => {
    const germanGlossary = deferred<Glossary | null>();
    const frenchGlossary = deferred<Glossary | null>();

    invokeMock.mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "load_glossary") {
        const targetLang = (args as { targetLang: string }).targetLang;
        return targetLang === "fr"
          ? frenchGlossary.promise
          : germanGlossary.promise;
      }
      if (cmd === "glossary_status") return Promise.resolve(null);
      if (cmd === "save_settings") return Promise.resolve(null);
      if (cmd === "scan_mods") return Promise.resolve(exportScan(false));
      if (cmd === "load_strings")
        return Promise.resolve([
          {
            key: "fruit",
            source: "Apple",
            target: "",
            status: "untranslated",
          },
        ]);
      return Promise.resolve(null);
    });

    render(<App />);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("load_glossary", {
        targetLang: "de",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.change(screen.getByLabelText("Target language"), {
      target: { value: "fr" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("load_glossary", {
        targetLang: "fr",
      }),
    );

    await act(async () => {
      frenchGlossary.resolve({
        format: 2,
        sourceLang: "default",
        targetLang: "fr",
        termCount: 1,
        entries: [
          {
            source: "Apple",
            target: "Pomme",
            kind: "item",
            asset: "Strings/Objects",
            key: "Apple",
          },
        ],
      });
      await frenchGlossary.promise;
    });
    await act(async () => {
      germanGlossary.resolve({
        format: 2,
        sourceLang: "default",
        targetLang: "de",
        termCount: 1,
        entries: [
          {
            source: "Apple",
            target: "Apfel",
            kind: "item",
            asset: "Strings/Objects",
            key: "Apple",
          },
        ],
      });
      await germanGlossary.promise;
    });

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull(),
    );
    openWorkspace();
    const key = await screen.findByRole("button", { name: "fruit" });
    const row = key.closest<HTMLElement>("[data-string-row]");
    if (!row) throw new Error("String row was not rendered");
    fireEvent.doubleClick(row);
    const editor = await screen.findByRole("dialog", { name: "fruit" });
    expect(editor).toHaveTextContent("Apple → Pomme");
    expect(editor).not.toHaveTextContent("Apple → Apfel");
  });

  it("reloads the glossary when Settings closes without saving", async () => {
    let built = false;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "load_glossary")
        return Promise.resolve(
          built
            ? {
                format: 2,
                sourceLang: "default",
                targetLang: "de",
                termCount: 1,
                entries: [
                  {
                    source: "Apple",
                    target: "Apfel",
                    kind: "item",
                    asset: "Strings/Objects",
                    key: "Apple",
                  },
                ],
              }
            : null,
        );
      if (cmd === "glossary_status") return Promise.resolve(null);
      if (cmd === "scan_mods") return Promise.resolve(exportScan(false));
      if (cmd === "load_strings")
        return Promise.resolve([
          {
            key: "fruit",
            source: "Apple",
            target: "",
            status: "untranslated",
          },
        ]);
      return Promise.resolve(null);
    });

    render(<App />);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("load_glossary", {
        targetLang: "de",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    // A glossary built in Settings is saved right away.
    built = true;
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull(),
    );

    openWorkspace();
    const key = await screen.findByRole("button", { name: "fruit" });
    const row = key.closest<HTMLElement>("[data-string-row]");
    if (!row) throw new Error("String row was not rendered");
    fireEvent.doubleClick(row);
    const editor = await screen.findByRole("dialog", { name: "fruit" });
    await waitFor(() => expect(editor).toHaveTextContent("Apple → Apfel"));
  });

  it("has one workspace without redundant view navigation", async () => {
    mockConfigured();
    render(<App />);
    await screen.findByRole("region", { name: "Translation workspace" });
    expect(screen.queryByRole("button", { name: "Overview" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Workspace" })).toBeNull();
    expect(screen.getByRole("button", { name: "Settings" })).toBeEnabled();
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
      "false",
    );
    expect(screen.getByRole("button", { name: /^Issues\b/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
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
            workspace: {
              ...workspace,
              statusFilter: "all",
              modSearch: "Test Mod",
            },
          },
        }),
      { timeout: 2_500 },
    );
  });

  it("shows the actionable no-mod card in the work view", async () => {
    mockConfigured();
    render(<App />);

    expect(
      await screen.findByText("No translatable strings"),
    ).toBeInTheDocument();

    await screen.findByRole("region", { name: "Translation workspace" });
  });

  it("counts partially translated top-level packages in the mod-panel header", async () => {
    mockConfigured({
      mods: [
        {
          uniqueId: "bundle.complete",
          name: "Complete Component",
          version: "1.0",
          nexusId: null,
          packageId: "Bundle",
          folderPath: "x",
          i18nFiles: [],
          totalKeys: 4,
          translatedKeys: 4,
          reviewNeeded: 0,
          progress: 1,
          status: "translated",
        },
        {
          uniqueId: "bundle.open",
          name: "Open Component",
          version: "1.0",
          nexusId: null,
          packageId: "Bundle",
          folderPath: "x/child",
          i18nFiles: [],
          totalKeys: 6,
          translatedKeys: 0,
          reviewNeeded: 0,
          progress: 0,
          status: "untranslated",
        },
        {
          uniqueId: "partial.mod",
          name: "Partial Mod",
          version: "1.0",
          nexusId: null,
          packageId: "Partial Mod",
          folderPath: "y",
          i18nFiles: [],
          totalKeys: 10,
          translatedKeys: 4,
          reviewNeeded: 0,
          progress: 0.4,
          status: "untranslated",
        },
      ],
      warnings: [],
      modCount: 2,
      fileCount: 0,
    });
    render(<App />);
    openWorkspace();

    const heading = await screen.findByText(
      (_content, node) =>
        node?.classList.contains("translator-pane-heading") === true &&
        node.textContent === "Mods · 2",
    );
    expect(within(heading).getByText("2")).toHaveClass("translator-pane-count");
    const inProgress = await screen.findByText(
      (_content, node) =>
        node?.classList.contains("panel__header-tail") === true &&
        node.textContent === "2 in progress",
    );
    expect(within(inProgress).getByText("2")).toHaveClass(
      "translator-pane-count",
    );
  });

  it("asks before replacing an existing selected-mod translation", async () => {
    mockExportConfigured(true);
    render(<App />);
    openWorkspace();

    expect(await screen.findAllByText("Test Mod")).not.toHaveLength(0);
    await chooseToolbarAction("File actions", "Export current mod");

    expect(
      await screen.findByRole("dialog", { name: "Export translations" }),
    ).toHaveTextContent("1 existing translation file");
    expect(invokeMock).toHaveBeenCalledWith("preview_export", {
      mods: [
        {
          modUniqueId: "a.b",
          modName: "Test Mod",
          files: [
            {
              relativeDir: "i18n",
              defaultPath: "x/i18n/default.json",
              targetPath: "x/i18n/de.json",
            },
          ],
        },
      ],
    });
    expect(
      invokeMock.mock.calls.filter(([cmd]) => cmd === "export_mod"),
    ).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.queryByRole("dialog", { name: "Export translations" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "File actions" })).toHaveFocus();
  });

  it("opens Export… on this mod as ZIP and remembers the choice for the session", async () => {
    mockExportConfigured(true);
    render(<App />);
    openWorkspace();

    expect(await screen.findAllByText("Test Mod")).not.toHaveLength(0);
    openMenuEntry("File actions", "Export…");
    const zip = await screen.findByRole("dialog", {
      name: "Export translations",
    });
    expect(screen.getByRole("radio", { name: "This mod" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "ZIP" })).toBeChecked();
    expect(zip).toHaveTextContent("Test Mod · German (de)");
    expect(zip).toHaveTextContent("Saves one installable ZIP for this mod");
    expect(invokeMock).toHaveBeenCalledWith(
      "preview_translation_zip",
      expect.anything(),
    );
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "This mod" })).toHaveFocus(),
    );

    fireEvent.keyDown(screen.getByRole("radio", { name: "ZIP" }), {
      key: "ArrowRight",
    });
    await waitFor(() =>
      expect(document.getElementById("translator-zip-title")).toBeNull(),
    );
    const json = screen.getByRole("dialog", { name: "Export translations" });
    expect(json).toHaveTextContent("Writes directly into your Mods folder");
    expect(
      within(json).getByRole("button", { name: "Replace in Mods folder" }),
    ).toBeEnabled();
    expect(screen.getByRole("radio", { name: "JSON" })).toBeChecked();
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "JSON" })).toHaveFocus(),
    );

    fireEvent.keyDown(json, { key: "Escape" });
    expect(
      screen.queryByRole("dialog", { name: "Export translations" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "File actions" })).toHaveFocus();

    openMenuEntry("File actions", "Export…");
    expect(await screen.findByRole("radio", { name: "JSON" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "This mod" })).toBeChecked();
    expect(
      invokeMock.mock.calls.filter(([cmd]) => cmd === "preview_export"),
    ).toHaveLength(2);
  });

  describe("while an Export… switch is loading", () => {
    const zipPreview: ZipPreview = {
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
          modUniqueId: "a.b",
          installFolder: "Test Mod",
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
    /** The first JSON preflight answers at once; later ones wait. */
    function mockSwitching() {
      const pending = deferred<ExportPreflight>();
      let preflights = 0;
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
        if (cmd === "load_glossary") return Promise.resolve(null);
        if (cmd === "scan_mods") return Promise.resolve(exportScan(true));
        if (cmd === "load_strings") return Promise.resolve([]);
        if (cmd === "preview_translation_zip")
          return Promise.resolve(zipPreview);
        if (cmd === "preview_export")
          return ++preflights === 1
            ? Promise.resolve({
                acceptedMismatches: 0,
                omitted: [],
                files: plannedFiles(true),
              })
            : pending.promise;
        if (cmd === "export_mod" || cmd === "export_all_mods")
          return new Promise(() => {});
        return Promise.resolve(null);
      });
      return pending;
    }
    const calls = (cmd: string) =>
      invokeMock.mock.calls.filter(([name]) => name === cmd).length;

    it("does not confirm the stale preview of the previous choice", async () => {
      const pending = mockSwitching();
      render(<App />);
      expect(await screen.findAllByText("Test Mod")).not.toHaveLength(0);
      await chooseToolbarAction("File actions", "Export current mod");
      fireEvent.click(screen.getByRole("radio", { name: "All mods" }));

      const stale = screen.getByRole("dialog", { name: "Export translations" });
      const confirm = within(stale).getByRole("button", { name: "Checking…" });
      expect(confirm).toBeDisabled();
      fireEvent.click(confirm);
      expect(calls("export_mod")).toBe(0);
      expect(screen.getByRole("radio", { name: "All mods" })).toHaveAttribute(
        "aria-disabled",
        "true",
      );

      act(() =>
        pending.resolve({
          acceptedMismatches: 0,
          omitted: [],
          files: plannedFiles(true),
        }),
      );
      const ready = await within(
        screen.getByRole("dialog", { name: "Export translations" }),
      ).findByRole("button", { name: "Replace in Mods folder" });
      expect(screen.getByRole("dialog")).toHaveTextContent("1 mod · German");
      fireEvent.click(ready);
      await waitFor(() => expect(calls("export_all_mods")).toBe(1));
      expect(calls("export_mod")).toBe(0);
      // The write keeps the menu busy until it finishes.
      expect(
        screen.getByRole("button", { name: "File actions" }),
      ).toBeDisabled();
    });

    it("cancels the pending preview on Escape so nothing reopens", async () => {
      const pending = mockSwitching();
      render(<App />);
      expect(await screen.findAllByText("Test Mod")).not.toHaveLength(0);
      await chooseToolbarAction("File actions", "Export current mod");
      fireEvent.click(screen.getByRole("radio", { name: "All mods" }));
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      expect(screen.queryByRole("dialog")).toBeNull();

      await act(async () => {
        pending.resolve({
          acceptedMismatches: 0,
          omitted: [],
          files: plannedFiles(false),
        });
        await pending.promise;
      });
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(
        screen.getByRole("button", { name: "File actions" }),
      ).toBeEnabled();
    });

    it("does not save the ZIP while switching to JSON, and Cancel stops the switch", async () => {
      const pending = mockSwitching();
      render(<App />);
      expect(await screen.findAllByText("Test Mod")).not.toHaveLength(0);
      // Use up the immediate preflight so the next one waits.
      await chooseToolbarAction("File actions", "Export current mod");
      fireEvent.click(screen.getByRole("radio", { name: "ZIP" }));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Save ZIP…" })).toBeEnabled(),
      );

      fireEvent.click(screen.getByRole("radio", { name: "JSON" }));
      const checking = screen.getByRole("button", { name: "Checking…" });
      expect(checking).toBeDisabled();
      fireEvent.click(checking);
      expect(calls("pick_translation_zip_destination")).toBe(0);

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("dialog")).toBeNull();
      await act(async () => {
        pending.resolve({
          acceptedMismatches: 0,
          omitted: [],
          files: plannedFiles(false),
        });
        await pending.promise;
      });
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(
        screen.getByRole("button", { name: "File actions" }),
      ).toBeEnabled();
    });
  });

  it("keeps toolbar dialogs disabled while export preflight is pending", async () => {
    const preflight = deferred<ExportPreflight>();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "scan_mods") return Promise.resolve(exportScan(false));
      if (cmd === "load_strings") return Promise.resolve([]);
      if (cmd === "preview_export") return preflight.promise;
      return Promise.resolve(null);
    });
    render(<App />);
    openWorkspace();

    expect(await screen.findAllByText("Test Mod")).not.toHaveLength(0);
    // The Export… dialog opens on the ZIP preview; it stays until the JSON
    // preflight is ready.
    startToolbarAction("File actions", "Export current mod");
    await waitFor(() =>
      expect(
        invokeMock.mock.calls.filter(([cmd]) => cmd === "preview_export"),
      ).toHaveLength(1),
    );

    const exportActions = screen.getByRole("button", {
      name: "File actions",
      hidden: true,
    });
    expect(exportActions).toBeDisabled();
    expect(exportActions).toHaveTextContent("Checking…");
    expect(exportActions).not.toHaveTextContent("Exporting…");
    expect(
      screen.getByRole("button", { name: "Scan mods", hidden: true }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Settings", hidden: true }),
    ).toBeDisabled();
    expect(screen.getByRole("radio", { name: "JSON" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    for (const group of screen.getAllByRole("radiogroup"))
      expect(group).toHaveAttribute("aria-busy", "true");

    // Further choices wait for the running preflight.
    fireEvent.click(screen.getByRole("radio", { name: "All mods" }));
    fireEvent.click(exportActions);
    expect(
      invokeMock.mock.calls.filter(([cmd]) => cmd === "preview_export"),
    ).toHaveLength(1);

    act(() => {
      preflight.resolve({
        acceptedMismatches: 0,
        omitted: [],
        files: plannedFiles(false),
      });
    });
    await waitFor(() =>
      expect(document.getElementById("translator-zip-title")).toBeNull(),
    );
    expect(
      screen.getByRole("dialog", { name: "Export translations" }),
    ).toHaveTextContent("Writes directly into your Mods folder");
    expect(exportActions).toHaveTextContent("Files…");
  });

  it("reports an export failure after its result card was replaced", async () => {
    const exported = deferred<typeof EXPORT_RESULT>();
    backendHistory = [importHistory()];
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "scan_mods") return Promise.resolve(exportScan(false));
      if (cmd === "load_strings") return Promise.resolve([]);
      if (cmd === "preview_export")
        return Promise.resolve({
          acceptedMismatches: 0,
          omitted: [],
          files: plannedFiles(false),
        });
      if (cmd === "export_mod") return exported.promise;
      return Promise.resolve(null);
    });
    render(<App />);
    openWorkspace();

    expect(await screen.findAllByText("Test Mod")).not.toHaveLength(0);
    await chooseToolbarAction("File actions", "Export current mod");
    const preflight = await screen.findByRole("dialog", {
      name: "Export translations",
    });
    fireEvent.click(
      within(preflight).getByRole("button", { name: "Export to Mods folder" }),
    );
    // Another result replaces the pending export card.
    fireEvent.click(
      await screen.findByRole("button", {
        name: /^Details: LLM batch imported/,
      }),
    );
    await act(async () => {
      exported.reject("The disk is full.");
    });

    expect(
      await screen.findAllByText("Export failed: The disk is full."),
    ).not.toHaveLength(0);
  });

  it("labels only the confirmed export write as exporting", async () => {
    const exported = deferred<typeof EXPORT_RESULT>();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "scan_mods") return Promise.resolve(exportScan(false));
      if (cmd === "load_strings") return Promise.resolve([]);
      if (cmd === "preview_export")
        return Promise.resolve({
          acceptedMismatches: 0,
          omitted: [],
        });
      if (cmd === "export_mod") return exported.promise;
      return Promise.resolve(null);
    });
    render(<App />);
    openWorkspace();

    expect(await screen.findAllByText("Test Mod")).not.toHaveLength(0);
    await chooseToolbarAction("File actions", "Export current mod");
    const preflight = await screen.findByRole("dialog", {
      name: "Export translations",
    });
    fireEvent.click(
      within(preflight).getByRole("button", { name: "Export to Mods folder" }),
    );

    const exportActions = screen.getByRole("button", {
      name: "File actions",
    });
    await waitFor(() => expect(exportActions).toHaveTextContent("Exporting…"));

    act(() => {
      exported.resolve(EXPORT_RESULT);
    });
    await waitFor(() => expect(exportActions).toHaveTextContent("Files…"));
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
    await chooseToolbarAction("File actions", "Export current mod");

    const preflight = await screen.findByRole("dialog", {
      name: "Export translations",
    });
    expect(preflight).toHaveTextContent(
      "Replaces 1 existing translation file and creates 1 new translation file",
    );
    expect(within(preflight).getByText("Files to replace")).toBeInTheDocument();
    expect(within(preflight).getByText("New files")).toBeInTheDocument();

    fireEvent.click(
      within(preflight).getByRole("button", { name: "Replace in Mods folder" }),
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
    await chooseToolbarAction("File actions", "Export current mod");
    await screen.findByRole("dialog", { name: "Export translations" });
    fireEvent.click(
      screen.getByRole("button", { name: "Replace in Mods folder" }),
    );

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
    expect(await inspectLatestResult()).toHaveTextContent("Export completed");
  });

  it("shows the complete preflight for a new target and reopens the latest result", async () => {
    mockExportConfigured(false, {
      acceptedMismatches: 2,
      omitted: [],
      files: plannedFiles(false),
    });
    render(<App />);
    openWorkspace();

    expect(await screen.findAllByText("Test Mod")).not.toHaveLength(0);
    await chooseToolbarAction("File actions", "Export current mod");

    const preflight = await screen.findByRole("dialog", {
      name: "Export translations",
    });
    expect(preflight).toHaveTextContent("Creates 1 new translation file");
    expect(
      within(preflight).getByLabelText("Export contents"),
    ).toHaveTextContent("1 translation included");
    expect(preflight).not.toHaveTextContent("open strings omitted");
    expect(preflight).toHaveTextContent("2 token differences kept on purpose.");
    expect(
      within(preflight).getByRole("button", { name: "Export to Mods folder" }),
    ).toBeEnabled();
    expect(preflight).toHaveTextContent("2 token differences kept on purpose.");
    expect(preflight).toHaveTextContent("x/i18n/de.json");
    expect(invokeMock).not.toHaveBeenCalledWith(
      "export_mod",
      expect.anything(),
    );

    fireEvent.click(
      within(preflight).getByRole("button", { name: "Export to Mods folder" }),
    );
    expect(await inspectLatestResult()).toHaveTextContent(
      "Mods/x/i18n/de.json",
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Back to notification" }),
    );
    expect(screen.getByLabelText("Operation result")).toHaveAttribute(
      "role",
      "status",
    );
    fireEvent.click(screen.getByRole("button", { name: "Hide result" }));
    expect(screen.queryByLabelText("Operation result")).toBeNull();
    const latestResult = screen.getByRole("button", { name: "Latest result" });
    await waitFor(() => expect(latestResult).toHaveFocus());
    fireEvent.click(latestResult);
    expect(screen.getByLabelText("Operation result")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Back to notification" }),
      ).toHaveFocus(),
    );
  });

  it("reopens the newest result after an older history item was selected", async () => {
    const newer = exportHistory({
      id: "export-newer",
      title: "Newest export result",
      completedAtEpochMs: 1_780_000_002_000,
    });
    const older = importHistory({
      id: "import-older",
      title: "Older import result",
      completedAtEpochMs: 1_780_000_001_000,
    });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "scan_mods") return Promise.resolve(exportScan(false));
      if (cmd === "load_strings") return Promise.resolve([]);
      if (cmd === "export_mod") {
        backendHistory = [newer, older];
        return Promise.resolve(EXPORT_RESULT);
      }
      return Promise.resolve(null);
    });
    render(<App />);
    openWorkspace();

    expect(await screen.findAllByText("Test Mod")).not.toHaveLength(0);
    await chooseToolbarAction("File actions", "Export current mod");
    const confirm = await screen.findByRole("dialog", {
      name: "Export translations",
    });
    fireEvent.click(
      within(confirm).getByRole("button", { name: "Export to Mods folder" }),
    );

    await inspectLatestResult();
    let history = await screen.findByLabelText("Recent operation results");
    await waitFor(() => expect(history).toHaveValue(newer.id));
    fireEvent.change(history, { target: { value: older.id } });
    expect(history).toHaveValue(older.id);
    expect(screen.getByLabelText("Operation result")).toHaveTextContent(
      "Older import result",
    );

    fireEvent.click(screen.getByRole("button", { name: "Hide result" }));
    fireEvent.click(screen.getByRole("button", { name: "Latest result" }));

    history = await screen.findByLabelText("Recent operation results");
    expect(history).toHaveValue(newer.id);
    const reopened = screen.getByLabelText("Operation result");
    expect(within(reopened).getByText("Export completed")).toBeVisible();
    expect(within(reopened).getByText("Test Mod")).toBeVisible();
  });

  it("blocks export from the read-only preflight and opens the exact issue outside a scan subset", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "scan_mods")
        return Promise.resolve({
          ...exportScan(false),
          sourceDeltas: {
            sourcesChanged: 0,
            stringsAdded: 1,
            stringsRemoved: 0,
            addedStrings: [
              { modUniqueId: "a.b", relativeDir: "i18n", key: "new.key" },
            ],
            changedSources: [],
          },
        });
      if (cmd === "load_strings")
        return Promise.resolve([
          {
            key: "new.key",
            source: "New",
            target: "Neu",
            status: "translated",
          },
          {
            key: "greeting",
            source: "Hello {{name}}",
            target: "Hallo",
            status: "translated",
          },
        ]);
      if (cmd === "preview_export")
        return Promise.resolve({
          acceptedMismatches: 0,
          omitted: [
            {
              modUniqueId: "a.b",
              modName: "Test Mod",
              relativeDir: "i18n",
              key: "greeting",
              reason: "#$b# is missing from the translation.",
            },
          ],
        });
      return Promise.resolve(null);
    });
    render(<App />);
    openWorkspace();

    expect(await screen.findAllByText("Test Mod")).not.toHaveLength(0);
    fireEvent.click(screen.getByLabelText("Scan mods"));
    const scanToast = await screen.findByRole("status");
    fireEvent.click(
      within(scanToast).getByRole("button", { name: "Details…" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Show new strings (1)" }),
    );
    expect(await screen.findByText("new.key")).toBeVisible();
    expect(screen.queryByText("greeting")).toBeNull();
    await chooseToolbarAction("File actions", "Export current mod");
    const preflight = await screen.findByRole("dialog", {
      name: "Export translations",
    });

    expect(preflight).toHaveTextContent("1 string stays in English");
    expect(preflight).toHaveTextContent("greeting");
    expect(preflight).toHaveTextContent(
      "#$b# is missing from the translation.",
    );
    expect(
      within(preflight).getByRole("button", { name: "Export to Mods folder" }),
    ).toBeEnabled();
    fireEvent.click(
      within(preflight).getByRole("button", { name: "Open greeting" }),
    );

    expect(
      screen.queryByRole("dialog", { name: "Export translations" }),
    ).toBeNull();
    expect(
      screen.getByRole("searchbox", { name: "Search strings" }),
    ).toHaveValue("greeting");
    const editor = await screen.findByRole("dialog", { name: "greeting" });
    fireEvent.click(
      within(editor).getByRole("button", { name: "Close editor" }),
    );
    expect(
      invokeMock.mock.calls.filter(([cmd]) => cmd === "export_mod"),
    ).toHaveLength(0);
  });

  it("reports a failed export preflight without starting an export", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "scan_mods") return Promise.resolve(exportScan(false));
      if (cmd === "load_strings") return Promise.resolve([]);
      if (cmd === "preview_export")
        return Promise.reject(new Error("Preview unavailable"));
      return Promise.resolve(null);
    });
    render(<App />);
    openWorkspace();

    expect(await screen.findAllByText("Test Mod")).not.toHaveLength(0);
    await chooseToolbarAction("File actions", "Export current mod");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not check export readiness: Error: Preview unavailable",
    );
    expect(
      screen.queryByRole("dialog", { name: "Export translations" }),
    ).toBeNull();
    expect(
      invokeMock.mock.calls.filter(([cmd]) => cmd === "export_mod"),
    ).toHaveLength(0);
  });

  it("keeps the result tray collapsed after a top-level dialog closes", async () => {
    mockExportConfigured(false);
    render(<App />);
    openWorkspace();

    expect(await screen.findAllByText("Test Mod")).not.toHaveLength(0);
    await chooseToolbarAction("File actions", "Export current mod");
    await screen.findByRole("dialog", { name: "Export translations" });
    fireEvent.click(
      screen.getByRole("button", { name: "Export to Mods folder" }),
    );
    await inspectLatestResult();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const settingsDialog = await screen.findByRole("dialog", {
      name: "Settings",
    });
    fireEvent.click(
      within(settingsDialog).getByRole("button", { name: "Close settings" }),
    );

    expect(
      await screen.findByRole("status", { name: "Operation result" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Back to notification" }),
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
      if (cmd === "preview_export")
        // The first export removed the target, so the next one creates it.
        return Promise.resolve({
          acceptedMismatches: 0,
          omitted: [],
          files: plannedFiles(exports === 0),
        });
      return Promise.resolve(null);
    });
    render(<App />);
    openWorkspace();

    expect(await screen.findAllByText("Test Mod")).not.toHaveLength(0);
    await chooseToolbarAction("File actions", "Export current mod");
    await screen.findByRole("dialog", { name: "Export translations" });
    fireEvent.click(
      screen.getByRole("button", { name: "Replace in Mods folder" }),
    );
    await waitFor(() => expect(exports).toBe(1));
    expect(screen.getByLabelText("Operation result")).toHaveTextContent(
      "1 file removed.",
    );
    expect(screen.getByLabelText("Operation result")).toHaveTextContent(
      "removed",
    );
    fireEvent.click(screen.getByRole("button", { name: "Hide result" }));

    await chooseToolbarAction("File actions", "Export current mod");
    const secondPreflight = await screen.findByRole("dialog", {
      name: "Export translations",
    });
    expect(secondPreflight).toHaveTextContent("Creates 1 new translation file");
    fireEvent.click(
      within(secondPreflight).getByRole("button", {
        name: "Export to Mods folder",
      }),
    );
    await waitFor(() => expect(exports).toBe(2));
  });

  it("counts only the mods and files the all-mod export would write", async () => {
    const base = exportScan(false).mods[0];
    const scan = {
      ...exportScan(false),
      mods: [
        { ...base, uniqueId: "a.first", name: "First Mod" },
        {
          ...base,
          uniqueId: "b.untranslated",
          name: "Untranslated Mod",
          translatedKeys: 0,
          i18nFiles: base.i18nFiles.map((file) => ({
            ...file,
            defaultPath: "y/i18n/default.json",
            targetPath: "y/i18n/de.json",
          })),
        },
      ],
      modCount: 2,
      fileCount: 2,
    };
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "scan_mods") return Promise.resolve(scan);
      // The backend writes nothing for a mod without translations.
      if (cmd === "preview_export")
        return Promise.resolve({
          acceptedMismatches: 0,
          omitted: [],
          files: [
            {
              modUniqueId: "a.first",
              targetPath: "x/i18n/de.json",
              action: "create",
            },
          ],
        });
      return Promise.resolve(null);
    });
    render(<App />);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "File actions" }),
      ).toBeEnabled(),
    );
    await chooseToolbarAction("File actions", "Export all mods …");
    const preflight = await screen.findByRole("dialog", {
      name: "Export translations",
    });
    expect(preflight).toHaveTextContent("1 mod · German (de)");
    expect(preflight).toHaveTextContent("Creates 1 new translation file");
    expect(preflight).not.toHaveTextContent("y/i18n/de.json");
  });

  it("says the files are already up to date when the export changes nothing", async () => {
    mockExportConfigured(true, {
      acceptedMismatches: 0,
      omitted: [],
      files: [
        {
          modUniqueId: "a.b",
          targetPath: "x/i18n/de.json",
          action: "unchanged",
        },
      ],
    });
    render(<App />);
    openWorkspace();

    expect(await screen.findAllByText("Test Mod")).not.toHaveLength(0);
    await chooseToolbarAction("File actions", "Export current mod");
    const preflight = await screen.findByRole("dialog", {
      name: "Export translations",
    });
    expect(preflight).toHaveTextContent(
      "Your translation files are already up to date",
    );
    expect(preflight).not.toHaveTextContent("backed up first");
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
            summary: "3 translation files updated",
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
        });
      }
      return Promise.resolve(null);
    });
    render(<App />);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "File actions" }),
      ).toBeEnabled(),
    );
    await chooseToolbarAction("File actions", "Export all mods …");
    const preflight = await screen.findByRole("dialog", {
      name: "Export translations",
    });
    expect(preflight).toHaveTextContent("Export translations");
    expect(preflight).toHaveTextContent(
      "Replaces 1 existing translation file and creates 2 new translation files",
    );
    expect(preflight).toHaveTextContent("Files to replace");
    expect(preflight).toHaveTextContent("New files");
    expect(preflight).toHaveTextContent("3 translations included");
    expect(invokeMock).toHaveBeenCalledWith("preview_export", {
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
    fireEvent.click(
      within(preflight).getByRole("button", { name: "Replace in Mods folder" }),
    );

    const tray = await inspectLatestResult();
    await waitFor(() => expect(tray).toHaveTextContent("All mods exported"));
    expect(tray).toHaveTextContent("3 translation files updated");
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

  it("retries a failed all-mod export through the preflight confirmation", async () => {
    let exportAttempts = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "scan_mods") return Promise.resolve(exportScan(true));
      if (cmd === "export_all_mods") {
        exportAttempts += 1;
        return Promise.reject(new Error("Target file is locked"));
      }
      return Promise.resolve(null);
    });
    render(<App />);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "File actions" }),
      ).toBeEnabled(),
    );
    await chooseToolbarAction("File actions", "Export all mods …");
    const firstPreflight = await screen.findByRole("dialog", {
      name: "Export translations",
    });
    fireEvent.click(
      within(firstPreflight).getByRole("button", {
        name: "Replace in Mods folder",
      }),
    );

    const tray = await inspectLatestResult();
    await waitFor(() =>
      expect(tray).toHaveTextContent("Target file is locked"),
    );
    expect(exportAttempts).toBe(1);
    const previewCallsBeforeRetry = invokeMock.mock.calls.filter(
      ([cmd]) => cmd === "preview_export",
    ).length;

    fireEvent.click(within(tray).getByRole("button", { name: "Export again" }));

    const retryPreflight = await screen.findByRole("dialog", {
      name: "Export translations",
    });
    expect(retryPreflight).toHaveTextContent("Export translations");
    expect(
      invokeMock.mock.calls.filter(([cmd]) => cmd === "preview_export"),
    ).toHaveLength(previewCallsBeforeRetry + 1);
    expect(exportAttempts).toBe(1);

    // Cancelling the retry confirmation writes nothing.
    fireEvent.click(
      within(retryPreflight).getByRole("button", { name: "Cancel export" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Export translations" }),
      ).toBeNull(),
    );
    expect(exportAttempts).toBe(1);

    // The compact notice keeps the retry action available after cancellation.
    fireEvent.click(
      await screen.findByRole("button", { name: "Retry export" }),
    );
    const confirmedRetry = await screen.findByRole("dialog", {
      name: "Export translations",
    });
    fireEvent.click(
      within(confirmedRetry).getByRole("button", {
        name: "Replace in Mods folder",
      }),
    );
    await waitFor(() => expect(exportAttempts).toBe(2));
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

    const result = await inspectLatestResult();
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
        within(screen.getByLabelText("Operation result")).getAllByText(
          "Batch edit undone",
        ).length,
      ).toBeGreaterThan(0),
    );
  });

  it("removes the undo action when changing target language", async () => {
    mockConfigured();
    backendHistory = [batchEditHistory()];
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: /Details: Batch edit saved/ }),
    );
    const result = await screen.findByRole("complementary", {
      name: "Operation result",
    });
    expect(
      within(result).getByRole("button", {
        name: "Undo the latest batch edit",
      }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.change(screen.getByLabelText("Target language"), {
      target: { value: "fr" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Settings" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", { name: "Undo the latest batch edit" }),
    ).not.toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalledWith(
      "undo_batch_edit",
      expect.anything(),
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

    const result = await inspectLatestResult();
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

  it.each([
    undefined,
    "The quality check didn't finish for 1 text (an invalid review response). Their drafts are in Review; please check them.",
  ])(
    "keeps quick-editor suggestions and displays their warning: %s",
    async (warning) => {
      const completed = aiHistory({
        id: "ai-quick-success",
        outcome: "success",
        title: "Local AI quick translation",
        summary: "1 suggestion added to Review",
        itemCount: 1,
      });
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
              key: "greeting",
              source: "Hello",
              target: "",
              status: "untranslated",
            },
          ]);
        if (cmd === "translate_with_local_ai") {
          const runId = (args as { request: { runId: string } }).request.runId;
          backendHistory = [completed];
          return Promise.resolve({
            runId,
            engine: "local",
            model: "local-test",
            reasoning: "default",
            scope: "string",
            requested: 1,
            completed: 1,
            outcome: "complete",
            error: warning,
            suggestions: [
              {
                identity: {
                  modUniqueId: "a.b",
                  relativeDir: "i18n",
                  key: "greeting",
                },
                text: "Hallo",
                status: "review-needed",
                tokenDifferences: [],
                glossaryMisses: [],
              },
            ],
          } satisfies AiRunResult);
        }
        return Promise.resolve(null);
      });
      render(<App />);
      openWorkspace();

      const key = await screen.findByRole("button", { name: "greeting" });
      const row = key.closest<HTMLElement>("[data-string-row]");
      if (!row) throw new Error("String row was not rendered");
      fireEvent.doubleClick(row);
      const editor = await screen.findByRole("dialog", { name: "greeting" });
      fireEvent.click(
        within(editor).getByRole("button", { name: /Translate with AI/ }),
      );

      await waitFor(() =>
        expect(
          within(editor).getByRole("textbox", { name: "German translation" }),
        ).toHaveValue("Hallo"),
      );
      expect(screen.queryByLabelText("Operation result")).toBeNull();
      if (warning) expect(within(editor).getByText(warning)).toBeVisible();
      fireEvent.click(
        within(editor).getByRole("button", { name: "Close editor" }),
      );

      const latest = await screen.findByRole("button", {
        name: "Latest result",
      });
      expect(latest).toBeVisible();
      fireEvent.click(latest);
      const result = await inspectLatestResult();
      expect(result).toHaveTextContent("Local AI quick translation");
      expect(screen.getByLabelText("Recent operation results")).toHaveValue(
        completed.id,
      );
    },
  );

  it("replaces an older latest result after a failed quick-editor AI run", async () => {
    const older = exportHistory({
      id: "export-before-quick-ai",
      title: "Older export result",
    });
    const failed = aiHistory({
      id: "ai-quick-failed",
      outcome: "failed",
      title: "Failed quick AI translation",
      summary: "No suggestion was saved",
      warnings: ["Local provider unavailable"],
      itemCount: 0,
    });
    invokeMock.mockImplementation((cmd: string) => {
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
            key: "greeting",
            source: "Hello",
            target: "",
            status: "untranslated",
          },
        ]);
      if (cmd === "export_mod") {
        backendHistory = [older];
        return Promise.resolve(EXPORT_RESULT);
      }
      if (cmd === "translate_with_local_ai") {
        backendHistory = [failed, older];
        return Promise.reject(new Error("Local provider unavailable"));
      }
      return Promise.resolve(null);
    });
    render(<App />);
    openWorkspace();

    expect(await screen.findAllByText("Test Mod")).not.toHaveLength(0);
    await chooseToolbarAction("File actions", "Export current mod");
    const confirm = await screen.findByRole("dialog", {
      name: "Export translations",
    });
    fireEvent.click(
      within(confirm).getByRole("button", { name: "Export to Mods folder" }),
    );
    const olderResult = await inspectLatestResult();
    fireEvent.click(
      within(olderResult).getByRole("button", { name: "Hide result" }),
    );

    const key = await screen.findByRole("button", { name: "greeting" });
    const row = key.closest<HTMLElement>("[data-string-row]");
    if (!row) throw new Error("String row was not rendered");
    fireEvent.doubleClick(row);
    const editor = await screen.findByRole("dialog", { name: "greeting" });
    fireEvent.click(
      within(editor).getByRole("button", { name: /Translate with AI/ }),
    );
    expect(await within(editor).findByRole("alert")).toHaveTextContent(
      "Local provider unavailable",
    );
    fireEvent.click(
      within(editor).getByRole("button", { name: "Close editor" }),
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Latest result" }),
    );
    const result = await inspectLatestResult();
    expect(result).toHaveTextContent("Failed quick AI translation");
    expect(result).toHaveTextContent("No suggestion was saved");
    expect(screen.getByLabelText("Recent operation results")).toHaveValue(
      failed.id,
    );
  });

  it("starts the selected strings immediately with the ready Settings engine", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings")
        return Promise.resolve({
          ...CONFIGURED,
          ai: {
            defaultEngine: "chatgpt",
            cloudReasoning: "high",
            cloudQualityReview: true,
            cloudModel: "gpt-test-model",
          },
        });
      if (cmd === "cloud_ai_status")
        return Promise.resolve({
          installed: true,
          authenticated: true,
          version: "0.57.0",
          authentication: "ChatGPT account",
        });
      if (cmd === "translate_with_cloud_ai")
        return new Promise<never>(() => undefined);
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "scan_mods") return Promise.resolve(exportScan(false));
      if (cmd === "load_strings")
        return Promise.resolve([
          {
            key: "greeting",
            source: "Hello",
            target: "",
            status: "untranslated",
          },
        ]);
      return Promise.resolve(null);
    });

    render(<App />);
    openWorkspace();

    await waitFor(() => {
      expect(
        invokeMock.mock.calls.some(([cmd]) => cmd === "cloud_ai_status"),
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

    const dialog = await screen.findByLabelText("AI translation progress");
    expect(within(dialog).queryByLabelText("Engine")).toBeNull();
    expect(within(dialog).queryByLabelText("Scope")).toBeNull();
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("translate_with_cloud_ai", {
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

  it.each(["language", "Mods folder"])(
    "does not reload the original workspace after an AI run finishes following a %s change",
    async (change) => {
      let releaseTranslation!: (result: AiRunResult) => void;
      let activeRunId = "";
      // The finished run saved its suggestion to the original workspace.
      let suggestionSaved = false;
      let currentSettings: AppSettings = {
        ...CONFIGURED,
        llm: {
          provider: "custom",
          baseUrl: "http://127.0.0.1:1234/v1",
          model: "local-test",
          temperature: 0.2,
        },
      };
      invokeMock.mockImplementation((cmd: string, args?: unknown) => {
        if (cmd === "load_settings") return Promise.resolve(currentSettings);
        if (cmd === "save_settings") {
          currentSettings = (args as { settings: AppSettings }).settings;
          return Promise.resolve(null);
        }
        if (cmd === "pick_folder") return Promise.resolve("E:/Other/Mods");
        if (cmd === "scan_mods") {
          const { modsPath, targetLang } = args as {
            modsPath: string;
            targetLang: string;
          };
          const scan = withPendingReview(exportScan(false));
          scan.mods[0].i18nFiles[0].defaultPath = `${modsPath}/Test/i18n/default.json`;
          scan.mods[0].i18nFiles[0].targetPath = `${modsPath}/Test/i18n/${targetLang}.json`;
          return Promise.resolve(scan);
        }
        if (cmd === "load_strings") {
          const original =
            currentSettings.targetLang === "de" &&
            currentSettings.modsPath === CONFIGURED.modsPath;
          return Promise.resolve([
            {
              key: "greeting",
              source: "Hello",
              target: !original
                ? "Current workspace translation"
                : suggestionSaved
                  ? "Stale German suggestion"
                  : "",
              status:
                original && suggestionSaved ? "review-needed" : "untranslated",
            },
          ]);
        }
        if (cmd === "translate_with_local_ai") {
          activeRunId = (args as { request: { runId: string } }).request.runId;
          return new Promise<AiRunResult>((resolve) => {
            releaseTranslation = resolve;
          });
        }
        return Promise.resolve(null);
      });
      render(<App />);
      fireEvent.click(
        await screen.findByRole("checkbox", { name: "Select greeting" }),
      );
      fireEvent.click(screen.getByRole("button", { name: "1 selected" }));
      fireEvent.click(
        screen.getByRole("menuitem", { name: /Translate selected with AI/ }),
      );
      await waitFor(() => expect(activeRunId).not.toBe(""));
      fireEvent.click(screen.getByRole("button", { name: "Settings" }));
      if (change === "language") {
        fireEvent.change(screen.getByLabelText("Target language"), {
          target: { value: "fr" },
        });
      } else {
        fireEvent.click(
          screen.getByRole("button", { name: "Change Mods folder" }),
        );
        await screen.findByText("E:/Other/Mods");
      }
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
      await screen.findByText("Current workspace translation");
      const beforeFinish = invokeMock.mock.calls.length;
      suggestionSaved = true;
      await act(async () => {
        releaseTranslation({
          runId: activeRunId,
          engine: "local",
          model: "local-test",
          reasoning: "default",
          scope: "selected",
          requested: 1,
          completed: 1,
          outcome: "complete",
          suggestions: [
            {
              identity: {
                modUniqueId: "a.b",
                relativeDir: "i18n",
                key: "greeting",
              },
              text: "Stale German suggestion",
              status: "review-needed",
              tokenDifferences: [],
              glossaryMisses: [],
            },
          ],
        });
      });
      await waitFor(() =>
        expect(screen.queryByLabelText("AI translation progress")).toBeNull(),
      );
      expect(screen.getByText("Current workspace translation")).toBeVisible();
      expect(screen.queryByText("Stale German suggestion")).toBeNull();
      const result = screen.getByLabelText("Operation result");
      expect(result).toHaveTextContent("German (de)");
      expect(
        within(result).queryByRole("button", { name: "Open Review" }),
      ).toBeNull();
      expect(
        invokeMock.mock.calls
          .slice(beforeFinish)
          .filter(([cmd]) => cmd === "scan_mods" || cmd === "load_strings"),
      ).toEqual([]);
      if (change === "language") {
        fireEvent.click(screen.getByRole("button", { name: "Settings" }));
        fireEvent.change(screen.getByLabelText("Target language"), {
          target: { value: "de" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
        await waitFor(() =>
          expect(invokeMock.mock.calls.slice(beforeFinish)).toContainEqual([
            "load_strings",
            expect.objectContaining({
              targetPath: "E:/SDV/Mods/Test/i18n/de.json",
            }),
          ]),
        );
        expect(
          within(screen.getByLabelText("Operation result")).getByRole(
            "button",
            {
              name: "Open Review",
            },
          ),
        ).toBeEnabled();
      }
    },
  );

  it("replaces a cancelled AI progress dialog with the exact partial result", async () => {
    let releaseTranslation: ((result: AiRunResult) => void) | null = null;
    let activeRunId = "";
    // The backend saves the partial suggestion as a Review string.
    let first = { target: "", status: "untranslated" };
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
      if (cmd === "scan_mods")
        return Promise.resolve(withPendingReview(exportScan(false)));
      if (cmd === "load_strings")
        return Promise.resolve([
          { key: "first", source: "First", ...first },
          {
            key: "second",
            source: "Second",
            target: "",
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
    const progressDialog = await screen.findByLabelText(
      "AI translation progress",
    );
    expect(within(progressDialog).queryByLabelText("Engine")).toBeNull();
    expect(within(progressDialog).queryByLabelText("Scope")).toBeNull();
    expect(
      within(progressDialog).getByRole("progressbar", {
        name: "Strings saved to Review",
      }),
    ).toHaveAttribute(
      "aria-valuetext",
      "2 selected strings are being prepared",
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
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel AI translation" }),
    );
    if (!releaseTranslation) throw new Error("AI request did not start");
    expect(invokeMock).toHaveBeenCalledWith("cancel_ai_run", {
      runId: activeRunId,
    });
    first = { target: "Erste", status: "review-needed" };
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

    const result = await inspectLatestResult();
    expect(screen.queryByLabelText("AI translation progress")).toBeNull();
    expect(result).toHaveTextContent("AI translation cancelled");
    expect(result).toHaveTextContent("1 Local AI suggestion");
    expect(result).toHaveTextContent("1 saved · 1 remaining");
    expect(
      within(result).getByRole("button", { name: "Open Review" }),
    ).toBeEnabled();
    expect(
      within(result).queryByRole("button", {
        name: "Undo the latest batch edit",
      }),
    ).toBeNull();
    fireEvent.click(
      within(result).getByRole("button", { name: "Open Review" }),
    );
    expect(screen.getByRole("button", { name: "This mod" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("shows saved AI work with later failures as completed with issues", async () => {
    let activeRunId = "";
    const issue =
      "1 selected string failed in Local AI. Completed suggestions remain saved in Review.";
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
            status: "untranslated",
          },
          {
            key: "second",
            source: "Second",
            target: "",
            status: "untranslated",
          },
        ]);
      if (cmd === "translate_with_local_ai") {
        activeRunId = (args as { request: { runId: string } }).request.runId;
        backendHistory = [
          aiHistory({
            outcome: "warning",
            itemCount: 1,
            title: "Local AI translation run",
            summary: "1 of 2 suggestions saved in Review.",
            warnings: [issue],
          }),
        ];
        return Promise.resolve({
          runId: activeRunId,
          engine: "local",
          model: "local-test",
          reasoning: "default",
          scope: "selected",
          requested: 2,
          completed: 1,
          outcome: "complete",
          error: issue,
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
        } satisfies AiRunResult);
      }
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

    const result = await inspectLatestResult();
    expect(result).toHaveTextContent("AI translation completed with issues");
    expect(result).toHaveTextContent("1 Local AI suggestion");
    expect(result).toHaveTextContent("1 saved · 1 remaining");
    expect(result).toHaveTextContent(issue);
    expect(result.querySelector(".translator-result-status")).toHaveClass(
      "is-warning",
    );
    expect(
      within(result).getByRole("option", {
        name: /Latest · Local AI translation run/,
      }),
    ).toBeVisible();

    fireEvent.click(
      screen.getByRole("button", { name: "Back to notification" }),
    );
    const notice = screen.getByLabelText("Operation result");
    expect(notice).toHaveClass("translator-toast", "is-warning");
    expect(notice).toHaveTextContent("1 of 2 saved to Review");
    expect(notice).toHaveTextContent(issue);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("opens a multi-mod AI result without hiding Review rows in one component", async () => {
    const scan = exportScan(false);
    const refreshScan = deferred<ScanResult>();
    let scanCount = 0;
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
      if (cmd === "scan_mods")
        return ++scanCount === 1 ? Promise.resolve(scan) : refreshScan.promise;
      if (cmd === "load_strings") {
        const modUniqueId = (args as { modUniqueId: string }).modUniqueId;
        const first = modUniqueId === "a.b";
        return Promise.resolve([
          {
            key: first ? "first" : "second",
            source: first ? "First" : "Second",
            target: completed ? (first ? "Erste" : "Zweite") : "",
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

    const result = await inspectLatestResult();
    const log = screen.getByRole("log");
    await waitFor(() => {
      const rows = Array.from(log.querySelectorAll("p"));
      const completions = rows.filter((row) =>
        row.textContent?.includes("Local AI translation run"),
      );
      expect(completions).toHaveLength(1);
      const lastScan = rows.reduce(
        (latest, row, index) =>
          row.textContent?.includes("Scanning mods") ? index : latest,
        -1,
      );
      expect(rows.indexOf(completions[0])).toBeLessThan(lastScan);
    });
    expect(log).not.toHaveTextContent("2 AI suggestions saved to Review.");
    act(() => refreshScan.resolve(scan));
    fireEvent.click(
      within(result).getByRole("button", { name: "Open Review" }),
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
    expect(errorToast).toHaveClass("translator-toast", "is-error");
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
    expect(successToast).toHaveClass("translator-toast", "is-success");
    expect(successToast).toHaveAttribute("aria-live", "polite");
    expect(successToast.querySelector(".lucide-circle-check")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Dismiss notification" }),
    ).toBeEnabled();
  });

  it("resolves an export problem after its token mismatch is explicitly accepted", async () => {
    const blocked = {
      ...EXPORT_RESULT,
      files: [],
      skipped: [
        {
          relativeDir: "i18n",
          key: "greeting",
          reason: "#$b# is missing from the translation.",
        },
      ],
      filesWritten: 0,
      totalWrittenKeys: 0,
    };
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "scan_mods") return Promise.resolve(exportScan(false));
      if (cmd === "load_strings")
        return Promise.resolve([
          {
            key: "greeting",
            source: "Hello#$b#there",
            target: "Hallo",
            status: "translated",
          },
        ]);
      if (cmd === "export_mod") return Promise.resolve(blocked);
      return Promise.resolve(null);
    });
    render(<App />);
    openWorkspace();

    await screen.findByText("greeting");
    await chooseToolbarAction("File actions", "Export current mod");
    await screen.findByRole("dialog", { name: "Export translations" });
    fireEvent.click(
      screen.getByRole("button", { name: "Export to Mods folder" }),
    );

    const tray = await inspectLatestResult();
    expect(tray).toHaveTextContent("left out because of token errors");
    expect(tray).toHaveTextContent("greeting");
    fireEvent.click(screen.getByRole("button", { name: "Open issue" }));
    expect(
      screen.getByRole("searchbox", { name: "Search strings" }),
    ).toHaveValue("greeting");
    expect(screen.queryByLabelText("Operation result")).toBeNull();

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

    expect(
      screen.queryByText("Last export · Unavailable in this session"),
    ).toBeNull();
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
      "This isn't a .json file. Choose the translated .json file.",
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
          modUniqueId: "Test Mod",
          installFolder: "Test Mod",
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
    await chooseToolbarAction("File actions", "Translation ZIP · current mod");

    await screen.findByText("Test Mod/i18n/de.json");
    expect(
      screen.getByRole("dialog", { name: "Export translations" }),
    ).toHaveTextContent("Test Mod/i18n/de.json");
    const chooseLocation = screen.getByRole("button", {
      name: "Save ZIP…",
    });
    await waitFor(() => expect(chooseLocation).toBeEnabled());
    fireEvent.click(chooseLocation);
    const result = await inspectLatestResult();
    expect(result).toHaveTextContent("ZIP created");
    expect(invokeMock).toHaveBeenCalledWith(
      "build_translation_zip",
      expect.objectContaining({
        request: expect.objectContaining({
          packageName: "Test Mod",
          targetLang: "de",
          destination: "C:/release/Test Mod.zip",
          overwrite: true,
        }),
      }),
    );
  });
  it("builds combined output after native save confirmation through the existing result tray", async () => {
    const preview = combinedOutputPreview();
    const previousZip = historyEntry("zip", {
      id: "previous-zip",
      title: "Previous package ZIP",
      path: "C:/output/previous.zip",
      fileName: "previous.zip",
    });
    backendHistory = [previousZip];
    invokeMock.mockImplementation(
      (cmd: string, args?: { overwrite?: boolean }) => {
        if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
        if (cmd === "scan_mods") return Promise.resolve(exportScan(false));
        if (cmd === "load_strings") return Promise.resolve([]);
        if (cmd === "preview_stardew_translator_output")
          return Promise.resolve(preview);
        if (cmd === "pick_translation_zip_destination")
          return Promise.resolve("C:/output/combined.zip");
        if (cmd === "build_stardew_translator_output") {
          if (!args?.overwrite) return Promise.reject("OVERWRITE_REQUIRED");
          backendHistory = [
            historyEntry("zip", {
              id: "combined-zip",
              title: "Stardew Translator Output created",
              path: "C:/output/combined.zip",
              fileName: "combined.zip",
            }),
            previousZip,
          ];
          return Promise.resolve({
            path: "C:/output/combined.zip",
            folder: "C:/output",
            fileName: "combined.zip",
            entries: 2,
            strings: 2,
          });
        }
        return Promise.resolve(null);
      },
    );
    render(<App />);
    openWorkspace();
    await screen.findAllByText("Test Mod");
    await chooseToolbarAction("File actions", "Translation ZIP · all mods");
    await screen.findByText("AI mod/i18n/de.json");
    const dialog = screen.getByRole("dialog", {
      name: "Export translations",
    });
    expect(within(dialog).queryByLabelText("Package version")).toBeNull();
    fireEvent.change(within(dialog).getByLabelText("Manual mod"), {
      target: { value: "OriginalManual" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save ZIP…" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Operation result")).toHaveTextContent(
        "combined.zip",
      ),
    );
    const result = await inspectLatestResult();
    expect(result).toHaveTextContent("ZIP created");
    expect(
      invokeMock.mock.calls.filter(
        ([command]) => command === "build_stardew_translator_output",
      ),
    ).toHaveLength(1);
    expect(invokeMock).toHaveBeenCalledWith("build_stardew_translator_output", {
      destination: "C:/output/combined.zip",
      overwrite: true,
      installFolders: [{ modUniqueId: "Manual mod", folder: "OriginalManual" }],
    });
    expect(
      invokeMock.mock.calls.some(
        ([command]) => command === "build_translation_zip",
      ),
    ).toBe(false);
    const history = within(result).getByRole("combobox", {
      name: "Recent operation results",
    });
    expect(history).toHaveValue("combined-zip");
    fireEvent.change(history, { target: { value: "previous-zip" } });
    expect(result).toHaveTextContent("previous.zip");
    expect(result).not.toHaveTextContent("combined.zip");
    fireEvent.change(history, { target: { value: "combined-zip" } });
    expect(result).toHaveTextContent("combined.zip");
  });

  it("persists a pending workspace change after a combined ZIP finishes", async () => {
    const build = deferred<unknown>();
    let exporting = false;
    let persistedSearch = "";
    let rejectedSaves = 0;
    mockConfigured(exportScan(false));
    const original = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(
      (cmd: string, args?: { settings: AppSettings }) => {
        if (cmd === "save_settings") {
          if (exporting) {
            rejectedSaves++;
            return Promise.reject(
              "An export or settings update is already running. Wait for it to finish and try again.",
            );
          }
          persistedSearch = args?.settings.workspace?.modSearch ?? "";
          return Promise.resolve(null);
        }
        if (cmd === "preview_stardew_translator_output")
          return Promise.resolve(combinedOutputPreview());
        if (cmd === "pick_translation_zip_destination")
          return Promise.resolve("C:/output/combined.zip");
        if (cmd === "build_stardew_translator_output") {
          exporting = true;
          return build.promise;
        }
        return original(cmd, args);
      },
    );
    render(<App />);
    openWorkspace();
    await screen.findAllByText("Test Mod");
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter mods" }), {
      target: { value: "Test" },
    });
    await chooseToolbarAction("File actions", "Translation ZIP · all mods");
    await screen.findByText("AI mod/i18n/de.json");
    fireEvent.click(screen.getByRole("button", { name: "Save ZIP…" }));
    await waitFor(() => expect(exporting).toBe(true));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450));
    });
    expect(rejectedSaves).toBe(0);
    await act(async () => {
      exporting = false;
      build.resolve({
        path: "C:/output/combined.zip",
        folder: "C:/output",
        fileName: "combined.zip",
        entries: 2,
        strings: 2,
      });
      await build.promise;
    });
    await waitFor(() => expect(persistedSearch).toBe("Test"));
  });

  it("retries a busy workspace save using the newest view and language", async () => {
    const saved: AppSettings[] = [];
    let busy = true;
    mockConfigured(exportScan(false));
    const original = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(
      (cmd: string, args?: { settings: AppSettings }) => {
        if (cmd === "save_settings") {
          const next = args!.settings;
          if (busy)
            return Promise.reject(
              "An export or settings update is already running. Wait for it to finish and try again.",
            );
          saved.push(next);
          return Promise.resolve(null);
        }
        return original(cmd, args);
      },
    );
    render(<App />);
    openWorkspace();
    await screen.findAllByText("Test Mod");
    const filter = screen.getByRole("searchbox", { name: "Filter mods" });
    fireEvent.change(filter, { target: { value: "Old search" } });
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("save_settings", {
        settings: expect.objectContaining({
          workspace: expect.objectContaining({ modSearch: "Old search" }),
        }),
      }),
    );
    fireEvent.change(filter, { target: { value: "Test" } });
    busy = false;
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.change(screen.getByLabelText("Target language"), {
      target: { value: "fr" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull(),
    );
    await waitFor(() =>
      expect(saved.at(-1)).toEqual(
        expect.objectContaining({
          targetLang: "fr",
          workspace: expect.objectContaining({ modSearch: "Test" }),
        }),
      ),
    );
    expect(saved.every((entry) => entry.targetLang === "fr")).toBe(true);
    expect(
      saved.some((entry) => entry.workspace?.modSearch === "Old search"),
    ).toBe(false);
  });

  it("retries a transiently busy workspace save and cancels pending retries on unmount", async () => {
    let attempts = 0;
    let busy = true;
    mockConfigured(exportScan(false));
    const original = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation((cmd: string, ...args: unknown[]) => {
      if (cmd === "save_settings") {
        attempts++;
        return busy
          ? Promise.reject(
              "An export or settings update is already running. Wait for it to finish and try again.",
            )
          : Promise.resolve(null);
      }
      return original(cmd, ...args);
    });
    const view = render(<App />);
    openWorkspace();
    await screen.findAllByText("Test Mod");
    const filter = screen.getByRole("searchbox", { name: "Filter mods" });
    fireEvent.change(filter, { target: { value: "Test" } });
    await waitFor(() => expect(attempts).toBe(1));
    busy = false;
    await waitFor(() => expect(attempts).toBe(2));
    busy = true;
    fireEvent.change(filter, { target: { value: "Pending" } });
    await waitFor(() => expect(attempts).toBe(3));
    view.unmount();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450));
    });
    expect(attempts).toBe(3);
  });

  it.each(["success", "error"])(
    "ignores a cancelled package preview's late %s while combined output is open",
    async (outcome) => {
      const pending = deferred<ZipPreview>();
      const preview = combinedOutputPreview();
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
        if (cmd === "scan_mods") return Promise.resolve(exportScan(false));
        if (cmd === "load_strings") return Promise.resolve([]);
        if (cmd === "preview_translation_zip") return pending.promise;
        if (cmd === "preview_stardew_translator_output")
          return Promise.resolve(preview);
        return Promise.resolve(null);
      });
      render(<App />);
      openWorkspace();
      await screen.findAllByText("Test Mod");
      await chooseToolbarAction(
        "File actions",
        "Translation ZIP · current mod",
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Close ZIP preview" }),
      );
      await chooseToolbarAction("File actions", "Translation ZIP · all mods");
      await screen.findByText("AI mod/i18n/de.json");
      await act(async () => {
        if (outcome === "success") {
          pending.resolve({
            ...preview,
            defaultFileName: "Old package.zip",
            entries: [
              {
                ...preview.entries[0],
                archivePath: "Old package/i18n/de.json",
              },
            ],
          });
        } else {
          pending.reject("Old package preview failed");
        }
        await pending.promise.catch(() => undefined);
      });
      const dialog = screen.getByRole("dialog", {
        name: "Export translations",
      });
      expect(
        within(dialog).getByRole("status", { name: "ZIP file" }),
      ).toHaveTextContent(preview.defaultFileName);
      fireEvent.click(
        within(dialog).getByText("Details", {
          exact: false,
          selector: ".desktop-xd-section-title",
        }),
      );
      expect(within(dialog).getByText("AI mod/i18n/de.json")).toBeVisible();
      expect(dialog).not.toHaveTextContent("Old package");
      expect(
        within(dialog).getByRole("button", { name: "Save ZIP…" }),
      ).toBeEnabled();
    },
  );
  it("does not reopen a cancelled combined output preview when its scan finishes", async () => {
    const pending = deferred<unknown>();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "scan_mods") return Promise.resolve(exportScan(false));
      if (cmd === "load_strings") return Promise.resolve([]);
      if (cmd === "preview_stardew_translator_output") return pending.promise;
      return Promise.resolve(null);
    });
    render(<App />);
    openWorkspace();
    await screen.findAllByText("Test Mod");
    await chooseToolbarAction("File actions", "Translation ZIP · all mods");
    fireEvent.click(screen.getByRole("button", { name: "Close ZIP preview" }));
    await act(async () => {
      pending.resolve({ packageName: "Late output" });
      await pending.promise;
    });
    expect(
      screen.queryByRole("dialog", {
        name: "Export translations",
      }),
    ).toBeNull();
    expect(
      invokeMock.mock.calls.some(
        ([command]) => command === "pick_translation_zip_destination",
      ),
    ).toBe(false);
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
    const row = keyButton.closest<HTMLElement>(".stringrow--data");
    expect(row).not.toBeNull();
    fireEvent.contextMenu(row!, { clientX: 24, clientY: 24 });
    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: /Export LLM batch/,
      }),
    );

    const saveDialog = screen.getByRole("dialog", { name: "Export LLM batch" });
    expect(saveDialog).toHaveTextContent("1 Open or Changed string included");
    expect(
      within(saveDialog).getByRole("button", { name: "Choose…" }),
    ).toBeEnabled();
    fireEvent.click(
      within(saveDialog).getByRole("button", { name: "Save batch…" }),
    );

    await waitFor(() => expect(exportAttempts).toBe(1));
    expect(
      screen.getByRole("dialog", { name: "Export LLM batch" }),
    ).toBeVisible();
    fireEvent.click(
      within(saveDialog).getByRole("button", { name: "Save batch…" }),
    );

    const tray = await inspectLatestResult();
    expect(tray).toHaveTextContent("LLM batch exported");
    // Saved outside the Mods folder: the file name only, not the user's path.
    expect(tray).toHaveTextContent("test.llm-batch.json");
    expect(tray).not.toHaveTextContent("C:/out/");
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
      screen.queryByRole("dialog", { name: "Export LLM batch" }),
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
    const row = keyButton.closest<HTMLElement>(".stringrow--data");
    expect(row).not.toBeNull();
    fireEvent.contextMenu(row!, { clientX: 24, clientY: 24 });
    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: /Export LLM batch/,
      }),
    );
    const saveDialog = screen.getByRole("dialog", { name: "Export LLM batch" });

    fireEvent.click(
      within(saveDialog).getByRole("button", { name: "Choose…" }),
    );
    expect(await screen.findByText("C:/chosen/custom.json")).toBeVisible();
    expect(
      within(saveDialog).getByRole("status", { name: "Batch file" }),
    ).toHaveTextContent("custom.json");
    fireEvent.click(
      within(saveDialog).getByRole("button", { name: "Save batch" }),
    );

    const tray = await inspectLatestResult();
    expect(tray).toHaveTextContent("custom.json");
    expect(tray).not.toHaveTextContent("C:/chosen/");
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

  it("closes the ZIP preview and exposes a blocking problem outside a scan subset", async () => {
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
      if (command === "scan_mods")
        return Promise.resolve({
          ...exportScan(true),
          sourceDeltas: {
            sourcesChanged: 0,
            stringsAdded: 1,
            stringsRemoved: 0,
            addedStrings: [
              { modUniqueId: "a.b", relativeDir: "i18n", key: "new.key" },
            ],
            changedSources: [],
          },
        });
      if (command === "load_strings")
        return Promise.resolve([
          {
            key: "new.key",
            source: "New",
            target: "Neu",
            status: "translated",
          },
          {
            key: "broken.key",
            source: "Hello {{name}}",
            target: "Hallo",
            status: "translated",
          },
        ]);
      if (command === "preview_translation_zip")
        return Promise.resolve(preview);
      return Promise.resolve(null);
    });
    render(<App />);
    openWorkspace();
    expect(await screen.findAllByText("Test Mod")).not.toHaveLength(0);
    fireEvent.click(screen.getByLabelText("Scan mods"));
    const scanToast = await screen.findByRole("status");
    fireEvent.click(
      within(scanToast).getByRole("button", { name: "Details…" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Show new strings (1)" }),
    );
    expect(await screen.findByText("new.key")).toBeVisible();
    expect(screen.queryByText("broken.key")).toBeNull();
    await chooseToolbarAction("File actions", "Translation ZIP · current mod");
    const problems = await screen.findByRole("list", {
      name: "Strings left out of the ZIP",
    });
    expect(problems).toHaveTextContent("broken.key");
    fireEvent.click(
      within(problems).getByRole("button", { name: "Open broken.key" }),
    );
    expect(
      screen.queryByRole("dialog", { name: "Export translations" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("searchbox", { name: "Search strings" }),
    ).toHaveValue("broken.key");
    fireEvent.doubleClick(await screen.findByText("broken.key"));
    expect(
      await screen.findByRole("dialog", { name: "broken.key" }),
    ).toBeVisible();
  });

  it("leaves a ZIP untouched when native Save is canceled and builds once after confirmation", async () => {
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
          modUniqueId: "Test Mod",
          installFolder: "Test Mod",
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
    let nativeSaveConfirmed = false;
    invokeMock.mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "scan_mods") return Promise.resolve(exportScan(false));
      if (cmd === "load_strings") return Promise.resolve([]);
      if (cmd === "preview_translation_zip") return Promise.resolve(preview);
      if (cmd === "pick_translation_zip_destination")
        return Promise.resolve(
          nativeSaveConfirmed ? "C:/release/Test Mod.zip" : null,
        );
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
    await chooseToolbarAction("File actions", "Translation ZIP · current mod");
    await screen.findByLabelText("Version");
    const chooseLocation = await screen.findByRole("button", {
      name: "Save ZIP…",
    });
    await waitFor(() => expect(chooseLocation).toBeEnabled());
    fireEvent.click(chooseLocation);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "pick_translation_zip_destination",
        expect.anything(),
      ),
    );
    expect(
      invokeMock.mock.calls.some(
        ([command]) => command === "build_translation_zip",
      ),
    ).toBe(false);
    nativeSaveConfirmed = true;
    fireEvent.click(chooseLocation);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "build_translation_zip",
        expect.objectContaining({
          request: expect.objectContaining({ overwrite: true }),
        }),
      ),
    );
    expect(
      invokeMock.mock.calls.filter(
        ([command]) => command === "build_translation_zip",
      ),
    ).toHaveLength(1);
  });

  it("exposes the complete keyboard-accessible command bar", async () => {
    mockExportConfigured(false);
    render(<App />);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "File actions" }),
      ).toBeEnabled(),
    );

    expect(screen.queryByRole("navigation", { name: "Main views" })).toBeNull();
    expect(screen.getByRole("button", { name: "Scan mods" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Settings" })).toBeEnabled();

    const exportButton = screen.getByRole("button", { name: "File actions" });
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
    const exportEntry = screen.getByRole("menuitem", {
      name: /^Export…/,
    });
    await waitFor(() =>
      expect(
        screen.getByRole("menuitem", { name: /^Import LLM batch…/ }),
      ).toHaveFocus(),
    );
    expect(exportEntry).toBeEnabled();
    expect(exportEntry).toHaveTextContent("JSON or ZIP, this mod or all mods.");
    // One Export… entry replaces the four JSON and ZIP entries.
    expect(
      screen
        .getAllByRole("menuitem")
        .map((item) => item.textContent?.replace(/….*$/, "…")),
    ).toEqual(["Import LLM batch…", "Export LLM batch…", "Export…"]);
    expect(screen.getByRole("menu", { name: "Files" })).not.toHaveTextContent(
      "Export JSON for",
    );
    expect(screen.getByRole("menu", { name: "Files" })).not.toHaveTextContent(
      "Advanced",
    );

    fireEvent.keyDown(exportEntry, { key: "Home" });
    fireEvent.keyDown(
      screen.getByRole("menuitem", { name: /^Import LLM batch…/ }),
      { key: "End" },
    );
    expect(exportEntry).toHaveFocus();
    const allExport = exportEntry;
    const settingsButton = screen.getByRole("button", { name: "Settings" });
    fireEvent.blur(allExport, { relatedTarget: settingsButton });
    await waitFor(() =>
      expect(screen.queryByRole("menu", { name: "Files" })).toBeNull(),
    );

    fireEvent.keyDown(exportButton, { key: "ArrowDown" });
    await waitFor(() =>
      expect(
        screen.getByRole("menuitem", { name: /^Import LLM batch…/ }),
      ).toHaveFocus(),
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Files" })).toBeNull();
    expect(exportButton).toHaveFocus();

    await chooseToolbarAction("File actions", "Import LLM batch…");
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
    expect(screen.queryByRole("dialog", { name: /scan/i })).toBeNull();
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
    expect(screen.queryByRole("dialog", { name: SETUP_DIALOG })).toBeNull();
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

  it("does not let the workspace autosave write the previous Mods folder during a settings save", async () => {
    let releaseSave!: () => void;
    invokeMock.mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "pick_folder") return Promise.resolve("E:/Other/Mods");
      if (cmd === "scan_mods") return Promise.resolve(EMPTY_SCAN);
      if (cmd === "save_settings") {
        const { settings } = args as { settings: AppSettings };
        // Keep the workspace autosave retrying, so it is due while the
        // explicit save of the new Mods folder is still running.
        if (settings.modsPath === CONFIGURED.modsPath) {
          return Promise.reject(
            "An export or settings update is already running. Wait for it to finish and try again.",
          );
        }
        if (!releaseSave) {
          return new Promise<null>((resolve) => {
            releaseSave = () => resolve(null);
          });
        }
        return Promise.resolve(null);
      }
      return Promise.resolve(null);
    });
    render(<App />);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("save_settings", {
        settings: expect.objectContaining({ modsPath: CONFIGURED.modsPath }),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Change Mods folder" }));
    await screen.findByText("E:/Other/Mods");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(releaseSave).toBeDefined());
    const saveStarted = invokeMock.mock.calls.length;
    // Longer than the 350 ms autosave retry delay.
    await act(() => new Promise((resolve) => setTimeout(resolve, 500)));
    await act(async () => releaseSave());
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("scan_mods", {
        modsPath: "E:/Other/Mods",
        targetLang: "de",
      }),
    );
    const laterSaves = invokeMock.mock.calls
      .slice(saveStarted)
      .filter(([cmd]) => cmd === "save_settings")
      .map(([, args]) => (args as { settings: AppSettings }).settings.modsPath);
    expect(laterSaves).not.toContain(CONFIGURED.modsPath);
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

    // Closing with unsaved changes asks first.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
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
      defaultEngine: "chatgpt" as const,
      cloudReasoning: "high" as const,
      cloudQualityReview: true,
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
      within(settingsDialog).getByRole("button", { name: "Setup…" }),
    );

    const setup = await screen.findByRole("dialog", { name: SETUP_DIALOG });
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

  it("scans the workspace automatically after the setup wizard finishes", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "scan_mods") return Promise.resolve(exportScan(false));
      if (cmd === "load_strings") return Promise.resolve([]);
      if (cmd === "glossary_status")
        return Promise.resolve({
          gameXnbPresent: false,
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
      expect(invokeMock).toHaveBeenCalledWith("scan_mods", {
        modsPath: "E:/SDV/Mods",
        targetLang: "de",
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Settings" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const settingsDialog = await screen.findByRole("dialog", {
      name: "Settings",
    });
    fireEvent.click(
      within(settingsDialog).getByRole("button", { name: "Setup…" }),
    );

    const setup = await screen.findByRole("dialog", { name: SETUP_DIALOG });
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
      expect(invokeMock).toHaveBeenCalledWith("scan_mods", {
        modsPath: "E:/SDV/Mods",
        targetLang: "fr",
      }),
    );
    expect(
      screen.queryByRole("dialog", { name: SETUP_DIALOG }),
    ).not.toBeInTheDocument();
  });

  it("scans right after the first-launch setup wizard finishes", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings")
        return Promise.resolve({
          stardewPath: null,
          modsPath: null,
          sourceLang: "default",
          targetLang: null,
        });
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "detect_stardew")
        return Promise.resolve({
          stardewPath: "E:/SDV",
          modsPath: "E:/SDV/Mods",
        });
      if (cmd === "scan_mods") return Promise.resolve(exportScan(false));
      if (cmd === "load_strings") return Promise.resolve([]);
      if (cmd === "glossary_status")
        return Promise.resolve({
          gameXnbPresent: false,
          sourceAvailable: false,
          cached: null,
          outdatedCache: false,
          packAvailable: false,
          packXnbAvailable: false,
        });
      return Promise.resolve(null);
    });
    render(<App />);

    const setup = await screen.findByRole("dialog", { name: SETUP_DIALOG });
    expect(invokeMock).not.toHaveBeenCalledWith("scan_mods", expect.anything());
    fireEvent.click(within(setup).getByRole("button", { name: "Auto-detect" }));
    await waitFor(() =>
      expect(within(setup).getByRole("button", { name: "Next" })).toBeEnabled(),
    );
    fireEvent.click(within(setup).getByRole("button", { name: "Next" }));
    await within(setup).findByRole("region", { name: "Mods folder" });
    fireEvent.click(within(setup).getByRole("button", { name: "Next" }));
    const targetLanguage =
      await within(setup).findByLabelText("Target language");
    fireEvent.change(targetLanguage, { target: { value: "de" } });
    fireEvent.click(within(setup).getByRole("button", { name: "Next" }));
    fireEvent.click(
      await within(setup).findByRole("button", { name: "Finish" }),
    );

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("scan_mods", {
        modsPath: "E:/SDV/Mods",
        targetLang: "de",
      }),
    );
    openWorkspace();
    expect(await screen.findAllByText("Test Mod")).not.toHaveLength(0);
  });

  it("does not scan when a re-run of the setup wizard is cancelled", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "scan_mods") return Promise.resolve(exportScan(false));
      if (cmd === "load_strings") return Promise.resolve([]);
      if (cmd === "validate_stardew_path") return Promise.resolve(true);
      return Promise.resolve(null);
    });
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Settings" })).toBeEnabled(),
    );
    const scanCalls = () =>
      invokeMock.mock.calls.filter(([cmd]) => cmd === "scan_mods").length;
    await waitFor(() => expect(scanCalls()).toBe(1));

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const settingsDialog = await screen.findByRole("dialog", {
      name: "Settings",
    });
    fireEvent.click(
      within(settingsDialog).getByRole("button", { name: "Setup…" }),
    );
    const setup = await screen.findByRole("dialog", { name: SETUP_DIALOG });
    // Change the language on step 3 so a wrongly saved cancel would show up.
    for (let step = 1; step < 3; step++) {
      const next = within(setup).getByRole("button", { name: "Next" });
      await waitFor(() => expect(next).toBeEnabled());
      fireEvent.click(next);
    }
    const language = await within(setup).findByRole("combobox", {
      name: "Target language",
    });
    fireEvent.change(language, { target: { value: "fr" } });
    expect(language).toHaveValue("fr");
    fireEvent.click(within(setup).getByRole("button", { name: "Cancel" }));
    fireEvent.click(
      within(setup).getByRole("button", { name: "Discard changes" }),
    );

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: SETUP_DIALOG })).toBeNull(),
    );
    expect(scanCalls()).toBe(1);
    // Workspace layout may be persisted on its own schedule; the cancelled
    // wizard must not save the language changed in it.
    const savedLanguages = invokeMock.mock.calls
      .filter(([cmd]) => cmd === "save_settings")
      .map(([, args]) => (args as { settings: typeof CONFIGURED }).settings);
    expect(savedLanguages.map((saved) => saved.targetLang)).not.toContain("fr");
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
      await screen.findByRole("dialog", { name: SETUP_DIALOG }),
    ).toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalledWith("scan_mods", expect.anything());
  });

  it("hides Open Review when the imported strings were already reviewed", async () => {
    const summary = {
      imported: 1,
      skippedTranslated: 0,
      unmatched: 0,
      identicalToSource: 0,
      importedWithTokenErrors: 0,
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
    const dropState = document.querySelector(".translator-native-drop-state");
    expect(dropState).toHaveClass(
      "translator-file-choice",
      "translator-drop-zone",
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
        path: "C:/results/test.llm-result.json",
      }),
    );
    const result = await inspectLatestResult();
    expect(result).toHaveTextContent("1 of 1 text added to Review");
    // The scan shows nothing left in Review, so the jump would be empty.
    expect(
      within(result).queryByRole("button", { name: "Open Review" }),
    ).toBeNull();
  });

  it("imports one dropped JSON result into the selected mod", async () => {
    const summary = {
      imported: 1,
      skippedTranslated: 0,
      unmatched: 0,
      identicalToSource: 0,
      importedWithTokenErrors: 0,
      totalInFile: 1,
    };
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "scan_mods")
        return Promise.resolve(withPendingReview(exportScan(false)));
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
    const dropState = document.querySelector(".translator-native-drop-state");
    expect(dropState).toHaveClass(
      "translator-file-choice",
      "translator-drop-zone",
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
        path: "C:/results/test.llm-result.json",
      }),
    );
    const result = await inspectLatestResult();
    expect(result).toHaveTextContent("1 of 1 text added to Review");
    expect(result).toHaveTextContent("test.llm-result.json");
    // The user's own folders are not shown; Show source file still uses them.
    expect(result).not.toHaveTextContent("C:/results/");
    fireEvent.click(
      within(result).getByRole("button", { name: "Open Review" }),
    );
    expect(screen.queryByLabelText("Operation result")).toBeNull();
    expect(screen.getByRole("button", { name: "Latest result" })).toBeVisible();
    expect(screen.getByRole("button", { name: /^Review/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "This mod" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("save_settings", {
        settings: expect.objectContaining({
          lastOpened: { "a.b": expect.any(Number) },
        }),
      }),
    );
  });

  it("persists last-opened when an import switches to its matching mod", async () => {
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
    });
    scan.modCount = 2;
    scan.fileCount = 2;
    const mismatch: LlmImportPreflight = {
      ...READY_IMPORT_PREFLIGHT,
      batchModUniqueId: "second.mod",
      selectedModUniqueId: "a.b",
      modMatches: false,
      ready: false,
      blockingReason: "This batch targets another scanned mod.",
    };

    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "scan_mods") return Promise.resolve(scan);
      if (cmd === "load_strings") return Promise.resolve([]);
      if (cmd === "pick_llm_batch_file")
        return Promise.resolve("C:/results/second.llm-result.json");
      if (cmd === "preflight_llm_batch_path") return Promise.resolve(mismatch);
      return Promise.resolve(null);
    });

    render(<App />);
    openWorkspace();
    await screen.findByRole("treeitem", { name: /Test Mod/ });
    await chooseToolbarAction("File actions", "Import LLM batch…");
    const dialog = await screen.findByRole("dialog", {
      name: "Import LLM batch",
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Choose file…" }),
    );
    fireEvent.click(
      await within(dialog).findByRole("button", {
        name: "Switch to matching mod",
      }),
    );

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("save_settings", {
        settings: expect.objectContaining({
          lastOpened: { "second.mod": expect.any(Number) },
        }),
      }),
    );
    const switchedDialog = screen.getByRole("dialog", {
      name: "Import LLM batch",
    });
    expect(switchedDialog).toHaveTextContent("Second Mod · ");
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "preflight_llm_batch_path",
        expect.objectContaining({
          modUniqueId: "second.mod",
          path: "C:/results/second.llm-result.json",
        }),
      ),
    );
    fireEvent.click(
      within(switchedDialog).getByRole("button", { name: "Cancel import" }),
    );
    expect(
      await screen.findByRole("treeitem", { name: /Second Mod/ }),
    ).toHaveAttribute("aria-current", "true");
  });

  it("resets the status and Issues filters when another mod is opened", async () => {
    const scan = exportScan(false);
    scan.mods.push({
      ...scan.mods[0],
      uniqueId: "second.mod",
      name: "Second Mod",
      packageId: "Second Mod",
      folderPath: "y",
    });
    scan.modCount = 2;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "scan_mods") return Promise.resolve(scan);
      if (cmd === "load_strings")
        return Promise.resolve([
          {
            key: "greeting",
            source: "Hello",
            target: "",
            status: "untranslated",
          },
        ]);
      return Promise.resolve(null);
    });
    render(<App />);
    openWorkspace();
    await screen.findByRole("treeitem", { name: /Second Mod/ });

    fireEvent.click(await screen.findByRole("button", { name: /^Done\b/ }));
    expect(screen.getByRole("button", { name: /^Done\b/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("treeitem", { name: /Second Mod/ }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Done\b/ })).toHaveAttribute(
        "aria-pressed",
        "false",
      ),
    );
    expect(screen.getByRole("button", { name: /^Issues\b/ })).toHaveAttribute(
      "aria-pressed",
      "false",
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

    const result = await inspectLatestResult();
    expect(
      screen.queryByRole("dialog", { name: "Import LLM batch" }),
    ).toBeNull();
    expect(result).toHaveTextContent("LLM import rejected");
    expect(result).toHaveTextContent("Nothing was imported");
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

    expect(await inspectLatestResult()).toHaveTextContent(
      "Select a mod first, then drop the file.",
    );
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
    expect(dialog).toHaveTextContent("This isn't a .json file");
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

    // The workspace auto-selects the most recently used (or first
    // real) scanned component once the user opens it from Overview.
    expect(await screen.findAllByText("Test Mod")).not.toHaveLength(0);
    expect(screen.getByRole("treeitem", { name: /7286/ })).toBeInTheDocument();
    expect(
      await screen.findByRole("searchbox", { name: "Search strings" }),
    ).toBeInTheDocument();

    expect(screen.queryByRole("main", { name: "Overview" })).toBeNull();

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
            status: "outdated",
          },
          {
            key: "review.key",
            source: "Review source",
            target: "AI target",
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

    fireEvent.click(await screen.findByRole("button", { name: "All mods" }));
    expect(
      screen.queryByRole("button", { name: /^Needs attention\b/ }),
    ).toBeNull();

    expect(screen.queryByText("Recently opened")).toBeNull();
    expect(screen.queryByText("Needs attention")).toBeNull();
  });

  it("leaves Issues when selecting a status and reopens it across statuses", async () => {
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
            status: "translated",
          },
        ]);
      return Promise.resolve(null);
    });

    render(<App />);
    openWorkspace();
    await screen.findByText("token.issue");
    fireEvent.click(screen.getByRole("button", { name: /^Issues\b/ }));

    const issues = screen.getByRole("button", {
      name: /^Issues\b/,
    });
    expect(issues).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByText("token.issue")).toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: /^Done\b/ }));
    const remountedIssues = await screen.findByRole("button", {
      name: /^Issues\b/,
    });
    expect(remountedIssues).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: /^Done\b/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(remountedIssues);
    expect(remountedIssues).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Done\b/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByText("token.issue")).toBeVisible();
  });

  it("opens the scan dialog when an automatic scan has warnings", async () => {
    mockConfigured({
      ...EMPTY_SCAN,
      warnings: ["Skipped broken manifest"],
    });
    render(<App />);

    expect(
      await screen.findByRole("dialog", { name: /scan/i }),
    ).toHaveTextContent("Skipped broken manifest");
  });

  it("keeps the startup scan report closed when it skips a component that needs attention", async () => {
    mockConfigured({
      ...EMPTY_SCAN,
      warnings: [],
      skippedComponents: [
        {
          packageId: "Example Pack",
          componentUniqueId: "example.pack",
          componentName: "Example Pack",
          relativeLocation: "Example Pack/manifest.json",
          reason: "invalid manifest JSON",
          requiresAttention: true,
          restOfPackageLoaded: false,
        },
      ],
    });
    render(<App />);

    // The header names the problem; the report opens only on request.
    const latest = await screen.findByRole("button", {
      name: "1 item needs attention; open scan results",
    });
    expect(screen.queryByRole("dialog", { name: /scan/i })).toBeNull();
    fireEvent.click(latest);
    const dialog = await screen.findByRole("dialog", { name: /scan/i });
    expect(dialog).toHaveTextContent("1 item needs a look");
    expect(dialog).toHaveTextContent("Example Pack");
    expect(dialog).not.toHaveTextContent("1 scanner warning");
  });

  it("does not interrupt startup for an expected community language pack exclusion", async () => {
    mockConfigured({
      ...EMPTY_SCAN,
      warnings: [],
      skippedComponents: [
        {
          packageId: "Example Pack",
          componentUniqueId: "example.pack",
          componentName: "Example Pack",
          relativeLocation: "Example Pack",
          reason: "This is a language pack, not a mod to translate.",
          requiresAttention: false,
          restOfPackageLoaded: false,
        },
      ],
    });
    render(<App />);

    await screen.findByRole("button", {
      name: /need attention; open scan results/,
    });
    expect(screen.queryByRole("dialog", { name: /scan/i })).toBeNull();
  });

  it("keeps extra target keys quiet on automatic scans and available in latest scan", async () => {
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

    const latest = await screen.findByRole("button", {
      name: /need attention; open scan results/,
    });
    expect(screen.queryByRole("dialog", { name: /scan/i })).toBeNull();
    fireEvent.click(latest);
    const summary = await screen.findByText(
      "1 translation entry without matching English source",
    );
    expect(summary.closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText("removed-key")).not.toBeVisible();
  });

  it("opens the scan dialog when an automatic scan fails", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "scan_mods") return Promise.reject("Mods folder not found");
      if (cmd === "load_glossary") return Promise.resolve(null);
      return Promise.resolve(null);
    });
    render(<App />);

    const dialog = await screen.findByRole("dialog", { name: /scan/i });
    expect(dialog).toHaveTextContent("Mods folder not found");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    openWorkspace();

    const skipped = screen.getByRole("button", {
      name: "Scan details unavailable; open scan results",
    });
    expect(skipped).toHaveTextContent("Scan details");
    fireEvent.click(skipped);
    expect(
      await screen.findByRole("dialog", { name: /scan/i }),
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
      await screen.findByRole("dialog", { name: /scan/i }),
    ).toHaveTextContent("Scanning mods");
    finishScan(EMPTY_SCAN);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /scan/i })).toBeNull(),
    );
    const toast = await screen.findByRole("status");
    expect(toast).toHaveTextContent("Scan complete");
    fireEvent.click(within(toast).getByRole("button", { name: "Details…" }));
    expect(
      await screen.findByRole("dialog", { name: /scan/i }),
    ).toHaveTextContent("Latest scan");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: /scan/i })).toBeNull();
  });

  it("refreshes strings and unresolved issues after scanning unchanged file paths", async () => {
    let target = "Hallo {{name}}";
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "scan_mods") return Promise.resolve(exportScan(true));
      if (cmd === "load_strings")
        return Promise.resolve([
          {
            key: "token.issue",
            source: "Hello {{name}}",
            target,
            status: "translated",
          },
        ]);
      return Promise.resolve(null);
    });
    render(<App />);
    openWorkspace();

    await screen.findByText("Hallo {{name}}");
    fireEvent.click(screen.getByRole("button", { name: /^Done\b/ }));
    // Issues stays clickable at 0 so its help and empty view stay reachable.
    expect(screen.getByRole("button", { name: "Issues 0" })).toBeEnabled();
    target = "Hallo";
    fireEvent.click(screen.getByLabelText("Scan mods"));

    expect(await screen.findByText("Hallo")).toBeVisible();
    expect(screen.queryByText("Hallo {{name}}")).toBeNull();
    expect(screen.getByRole("button", { name: /^Done\b/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(await screen.findByRole("button", { name: "Issues 1" }));
    expect(await screen.findByText("token.issue")).toBeVisible();
  });

  it("opens the exact new-string subset from the completed scan", async () => {
    const deltaScan = {
      ...exportScan(false),
      sourceDeltas: {
        sourcesChanged: 0,
        stringsAdded: 1,
        stringsRemoved: 0,
        addedStrings: [
          { modUniqueId: "a.b", relativeDir: "i18n", key: "new.key" },
        ],
        changedSources: [],
      },
    };
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "scan_mods") return Promise.resolve(deltaScan);
      if (cmd === "load_strings")
        return Promise.resolve([
          {
            key: "new.key",
            source: "New source",
            target: "",
            status: "untranslated",
            tokenMismatchAccepted: false,
          },
        ]);
      return Promise.resolve(null);
    });
    render(<App />);

    await waitFor(() =>
      expect(screen.getByLabelText("Scan mods")).toBeEnabled(),
    );
    fireEvent.click(screen.getByLabelText("Scan mods"));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /scan/i })).toBeNull(),
    );
    const toast = await screen.findByRole("status");
    fireEvent.click(within(toast).getByRole("button", { name: "Details…" }));
    const dialog = await screen.findByRole("dialog", { name: /scan/i });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Show new strings (1)" }),
    );

    expect(await screen.findByText("new.key")).toBeVisible();
    expect(
      screen.getByText("New strings from latest scan · 1 of 1 string shown"),
    ).toBeVisible();
    expect(screen.queryByRole("dialog", { name: /scan/i })).toBeNull();
  });

  it("opens the exact changed-English-string subset from the completed scan", async () => {
    const deltaScan = {
      ...exportScan(false),
      sourceDeltas: {
        sourcesChanged: 1,
        stringsAdded: 0,
        stringsRemoved: 0,
        addedStrings: [],
        changedSources: [
          { modUniqueId: "a.b", relativeDir: "i18n", key: "changed.key" },
        ],
      },
    };
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "scan_mods") return Promise.resolve(deltaScan);
      if (cmd === "load_strings")
        return Promise.resolve([
          {
            key: "changed.key",
            source: "Updated source",
            target: "Existing translation",
            status: "outdated",
            tokenMismatchAccepted: false,
          },
        ]);
      return Promise.resolve(null);
    });
    render(<App />);

    await waitFor(() =>
      expect(screen.getByLabelText("Scan mods")).toBeEnabled(),
    );
    fireEvent.click(screen.getByLabelText("Scan mods"));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /scan/i })).toBeNull(),
    );
    const toast = await screen.findByRole("status");
    fireEvent.click(within(toast).getByRole("button", { name: "Details…" }));
    const dialog = await screen.findByRole("dialog", { name: /scan/i });
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "Show changed strings (1)",
      }),
    );

    expect(await screen.findByText("changed.key")).toBeVisible();
    expect(
      screen.getByText(
        "Changed English strings from latest scan · 1 of 1 string shown",
      ),
    ).toBeVisible();
    expect(screen.queryByRole("dialog", { name: /scan/i })).toBeNull();
  });

  it("keeps a running scan open after Escape and completes it in place", async () => {
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
    const dialog = await screen.findByRole("dialog", { name: /scan/i });
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: /scan/i })).toBe(dialog);
    expect(within(dialog).getByText("Scanning mods…")).toBeVisible();

    scanResolvers.shift()!(EMPTY_SCAN);
    await waitFor(() =>
      expect(screen.getByLabelText("Scan mods")).toBeEnabled(),
    );
    expect(screen.queryByRole("dialog", { name: /scan/i })).toBeNull();
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Scan complete",
    );
  });
});

it("keeps App work progress and export eligibility coherent after clearing a personal blank-source target", async () => {
  const scan = exportScan(true);
  mockConfigured(scan);
  const original = invokeMock.getMockImplementation()!;
  invokeMock.mockImplementation((cmd: string, ...args: unknown[]) => {
    if (cmd === "load_strings")
      return Promise.resolve([
        {
          key: "blank",
          source: "",
          target: "Personal",
          status: "translated",
          tokenMismatchAccepted: false,
        },
      ]);
    return original(cmd, ...args);
  });
  render(<App />);
  openWorkspace();
  await screen.findByText("blank");
  fireEvent.doubleClick(screen.getByText("blank"));
  fireEvent.change(
    screen.getByRole("textbox", { name: "German translation" }),
    { target: { value: "" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(screen.getByRole("treeitem", { name: /Test Mod/ })).toHaveAttribute(
      "data-mod-progress",
      "1 / 1 · 100%",
    ),
  );
  expect(screen.getByText("1 / 1 covered")).toBeInTheDocument();
  await chooseToolbarAction("File actions", "Export current mod");
  const confirmation = await screen.findByRole("dialog", {
    name: "Export translations",
  });
  const eligible = within(confirmation).getByLabelText("Export contents");
  const open = within(confirmation).queryByText("open strings omitted");
  expect(eligible).toHaveTextContent("0 translations included");
  expect(open).toBeNull();
  expect(
    invokeMock.mock.calls.filter(([cmd]) => cmd === "scan_mods"),
  ).toHaveLength(1);
  expect(invokeMock).toHaveBeenCalledWith(
    "save_string",
    expect.objectContaining({ target: "", status: "untranslated" }),
  );
});
