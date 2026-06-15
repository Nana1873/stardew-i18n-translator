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
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
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
  }),
}));

import { App } from "./App";

const CONFIGURED = {
  stardewPath: "E:/SDV",
  modsPath: "E:/SDV/Mods",
  sourceLang: "default",
  targetLang: "de",
  diagnosticLogging: true,
};

beforeEach(() => {
  invokeMock.mockReset();
  fileDropHandler = null;
  localStorage.clear();
});

const EMPTY_SCAN = {
  mods: [],
  warnings: [],
  extraKeys: [],
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
    if (cmd === "export_mod") return Promise.resolve(EXPORT_RESULT);
    return Promise.resolve(null);
  });
}

function mockConfigured(scanResult: unknown = EMPTY_SCAN) {
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
    if (cmd === "scan_mods") return Promise.resolve(scanResult);
    if (cmd === "load_glossary") return Promise.resolve(null);
    return Promise.resolve(null);
  });
}

describe("App shell", () => {
  it("renders the toolbar and the dashboard landing", async () => {
    mockConfigured();
    render(<App />);

    // The nav toggle is labelled with its destination (work view from here).
    expect(
      screen.getByRole("button", { name: /Mod list/ }),
    ).toBeInTheDocument();
    // Landing screen is the dashboard (SPEC §7.0 rollout ④), not the panels.
    expect(screen.getByRole("main", { name: "Dashboard" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Mod list" })).toBeNull();
    expect(screen.queryByRole("searchbox")).toBeNull();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Scan" })).toBeEnabled(),
    );
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

  it("the nav toggle switches views and renames to its destination", async () => {
    mockConfigured();
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /Mod list/ }));
    expect(
      await screen.findByRole("region", { name: "Mod list" }),
    ).toBeInTheDocument();

    // In the work view the same button now offers the way back.
    fireEvent.click(screen.getByRole("button", { name: /Dashboard/ }));
    expect(
      await screen.findByRole("main", { name: "Dashboard" }),
    ).toBeInTheDocument();
  });

  it("shows the actionable no-mod card in the work view", async () => {
    mockConfigured();
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /Mod list/ }));
    expect(
      await screen.findByText("Select a mod to start translating"),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "open the review queue" }),
    );
    expect(
      await screen.findByRole("main", { name: "Dashboard" }),
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

    fireEvent.click(
      await screen.findByRole("button", { name: /Browse all mods/ }),
    );
    expect(screen.getByText("1 in progress")).toBeInTheDocument();
  });

  it("asks before replacing an existing selected-mod translation", async () => {
    mockExportConfigured(true);
    render(<App />);

    fireEvent.click(
      await screen.findByRole("button", { name: /Browse all mods/ }),
    );
    fireEvent.click(await screen.findByText("Test Mod"));
    fireEvent.click(screen.getByRole("button", { name: "Export" }));

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

  it("continues an overwrite only after confirmation", async () => {
    mockExportConfigured(true);
    render(<App />);

    fireEvent.click(
      await screen.findByRole("button", { name: /Browse all mods/ }),
    );
    fireEvent.click(await screen.findByText("Test Mod"));
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
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
      await screen.findByRole("complementary", { name: "Operation result" }),
    ).toHaveTextContent("Export complete");
  });

  it("exports a new target immediately, then confirms the next export", async () => {
    mockExportConfigured(false);
    render(<App />);

    fireEvent.click(
      await screen.findByRole("button", { name: /Browse all mods/ }),
    );
    fireEvent.click(await screen.findByText("Test Mod"));
    fireEvent.click(screen.getByRole("button", { name: "Export" }));

    expect(
      await screen.findByRole("complementary", { name: "Operation result" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "Confirm export overwrite" }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss result" }));
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(
      screen.getByRole("dialog", { name: "Confirm export overwrite" }),
    ).toBeInTheDocument();
  });

  it("keeps export problems available while navigating and refreshes one saved string", async () => {
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

    fireEvent.click(
      await screen.findByRole("button", { name: /Browse all mods/ }),
    );
    fireEvent.click(await screen.findByText("Test Mod"));
    fireEvent.click(screen.getByRole("button", { name: "Export" }));

    const tray = await screen.findByRole("complementary", {
      name: "Operation result",
    });
    expect(tray).toHaveTextContent("1 open, 0 resolved");
    fireEvent.click(screen.getByRole("button", { name: /i18n \/ greeting/ }));
    expect(
      screen.getByRole("searchbox", { name: "Search strings" }),
    ).toHaveValue("greeting");
    expect(tray).toBeInTheDocument();

    fireEvent.doubleClick(await screen.findByText("greeting"));
    expect(
      screen.getByRole("button", { name: "Expand result" }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Translation"), {
      target: { value: "Hallo {{name}}" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Expand result" }));

    expect(await screen.findByText("0 open, 1 resolved")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Export again" }),
    ).toBeInTheDocument();
  });

  it("replaces an older result and supports explicit dismissal", async () => {
    mockExportConfigured(false);
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: /Browse all mods/ }),
    );
    fireEvent.click(await screen.findByText("Test Mod"));
    await waitFor(() => expect(fileDropHandler).not.toBeNull());

    act(() => {
      fileDropHandler?.({
        type: "drop",
        paths: ["C:/one.json", "C:/two.json"],
      });
    });
    expect(
      await screen.findByText("Drop exactly one LLM batch/result JSON file."),
    ).toBeInTheDocument();

    act(() => {
      fileDropHandler?.({ type: "drop", paths: ["C:/result.txt"] });
    });
    expect(
      await screen.findByText("Only JSON batch/result files can be imported."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Drop exactly one LLM batch/result JSON file."),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss result" }));
    expect(
      screen.queryByRole("complementary", { name: "Operation result" }),
    ).toBeNull();
  });

  it("summarizes affected files and mods before Export All", async () => {
    mockExportConfigured(true);
    render(<App />);

    await screen.findByText(/1 mods scanned/);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Export All" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Export All" }));

    const dialog = await screen.findByRole("dialog", {
      name: "Confirm export overwrite",
    });
    expect(dialog).toHaveTextContent("1 existing translation file");
    expect(dialog).toHaveTextContent("1 mod");
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
    fireEvent.click(
      await screen.findByRole("button", { name: /Browse all mods/ }),
    );
    fireEvent.click(await screen.findByText("Test Mod"));
    fireEvent.click(screen.getByRole("button", { name: "Build ZIP" }));

    await screen.findByText("Test Mod/i18n/de.json");
    expect(
      screen.getByRole("dialog", { name: "Build translation ZIP" }),
    ).toHaveTextContent("Test Mod/i18n/de.json");
    const chooseLocation = screen.getByRole("button", {
      name: "Choose location...",
    });
    await waitFor(() => expect(chooseLocation).toBeEnabled());
    fireEvent.click(chooseLocation);
    const result = await screen.findByRole("complementary", {
      name: "Operation result",
    });
    expect(result).toHaveTextContent("Translation ZIP created");
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
      within(result).getByRole("button", { name: "Release notes" }),
    );
    await screen.findByLabelText("Generated release notes");
    expect(
      (screen.getByLabelText("Generated release notes") as HTMLTextAreaElement)
        .value,
    ).toContain("Archiv: Test Mod.zip");
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
    fireEvent.click(
      await screen.findByRole("button", { name: /Browse all mods/ }),
    );
    fireEvent.click(await screen.findByText("Test Mod"));
    fireEvent.click(screen.getByRole("button", { name: "Release notes" }));
    await screen.findByLabelText("Generated release notes");
    const dialog = screen.getByRole("dialog", {
      name: "Translation release notes",
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
    fireEvent.click(
      await screen.findByRole("button", { name: /Browse all mods/ }),
    );
    fireEvent.click(await screen.findByText("Test Mod"));
    fireEvent.click(screen.getByRole("button", { name: "Build ZIP" }));
    await screen.findByLabelText("Package version");
    const zipDialog = screen.getByRole("dialog", {
      name: "Build translation ZIP",
    });
    fireEvent.change(within(zipDialog).getByLabelText("Package version"), {
      target: { value: "1.1/beta" },
    });
    fireEvent.click(
      within(zipDialog).getByRole("button", { name: "Release notes" }),
    );
    const releaseDialog = await screen.findByRole("dialog", {
      name: "Translation release notes",
    });
    const text = (
      within(releaseDialog).getByLabelText(
        "Generated release notes",
      ) as HTMLTextAreaElement
    ).value;
    expect(text).toContain("Test Mod 1.1/beta");
    expect(text).toContain("Test Mod - 1.1_beta - German (de).zip");
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
    fireEvent.click(
      await screen.findByRole("button", { name: /Browse all mods/ }),
    );
    fireEvent.click(await screen.findByText("Test Mod"));
    fireEvent.click(screen.getByRole("button", { name: "Build ZIP" }));
    fireEvent.click(await screen.findByRole("button", { name: /broken\.key/ }));
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
    fireEvent.click(
      await screen.findByRole("button", { name: /Browse all mods/ }),
    );
    fireEvent.click(await screen.findByText("Test Mod"));
    fireEvent.click(screen.getByRole("button", { name: "Build ZIP" }));
    await screen.findByLabelText("Package version");
    const chooseLocation = await screen.findByRole("button", {
      name: "Choose location...",
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
      tokenIssues: 0,
      tokenIssueKeys: [],
      identicalToSource: 0,
      totalInFile: 1,
    };
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_settings") return Promise.resolve(CONFIGURED);
      if (cmd === "load_glossary") return Promise.resolve(null);
      if (cmd === "scan_mods") return Promise.resolve(exportScan(false));
      if (cmd === "load_strings") return Promise.resolve([]);
      if (cmd === "import_llm_batch_path") return Promise.resolve(summary);
      return Promise.resolve(null);
    });
    render(<App />);

    fireEvent.click(
      await screen.findByRole("button", { name: /Browse all mods/ }),
    );
    fireEvent.click(await screen.findByText("Test Mod"));
    await waitFor(() => expect(fileDropHandler).not.toBeNull());

    fileDropHandler?.({
      type: "enter",
      paths: ["C:/results/test.llm-result.json"],
    });
    expect(await screen.findByText("Import into Test Mod")).toBeInTheDocument();

    fileDropHandler?.({
      type: "drop",
      paths: ["C:/results/test.llm-result.json"],
    });
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
    expect(
      await screen.findByRole("complementary", { name: "Operation result" }),
    ).toHaveTextContent("Imported 1 of 1 string");
  });

  it("rejects a dropped result when no mod is selected", async () => {
    mockConfigured(exportScan(false));
    render(<App />);
    await waitFor(() => expect(fileDropHandler).not.toBeNull());

    fileDropHandler?.({
      type: "enter",
      paths: ["C:/results/test.json"],
    });
    expect(await screen.findByText("Select a mod first")).toBeInTheDocument();
    fileDropHandler?.({
      type: "drop",
      paths: ["C:/results/test.json"],
    });

    expect(
      await screen.findByRole("complementary", { name: "Operation result" }),
    ).toHaveTextContent("Select a mod before dropping");
    expect(invokeMock).not.toHaveBeenCalledWith(
      "import_llm_batch_path",
      expect.anything(),
    );
  });

  it("rejects multiple or non-JSON dropped files before invoking Rust", async () => {
    mockExportConfigured(false);
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: /Browse all mods/ }),
    );
    fireEvent.click(await screen.findByText("Test Mod"));
    await waitFor(() => expect(fileDropHandler).not.toBeNull());

    fileDropHandler?.({
      type: "drop",
      paths: ["C:/one.json", "C:/two.json"],
    });
    expect(
      await screen.findByRole("complementary", { name: "Operation result" }),
    ).toHaveTextContent("Drop exactly one");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss result" }));

    fileDropHandler?.({ type: "drop", paths: ["C:/result.txt"] });
    expect(
      await screen.findByRole("complementary", { name: "Operation result" }),
    ).toHaveTextContent("Only JSON");
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

    // The dashboard reflects the scan (queue + toolbar pill)…
    expect(await screen.findByText(/1 mods scanned/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /2 to review/ }),
    ).toBeInTheDocument();

    // …and Browse switches into the work view with the mod list.
    fireEvent.click(screen.getByRole("button", { name: /Browse all mods/ }));
    expect(await screen.findByText("Test Mod")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "7286" })).toBeInTheDocument();
    expect(
      screen.getByRole("searchbox", { name: "Search strings" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByText("Test Mod"));
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
    fireEvent.click(
      await screen.findByRole("button", { name: /Browse all mods/ }),
    );
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search strings" }),
      { target: { value: "mittags" } },
    );

    expect(await screen.findByText("festival.answer")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Second Mod/ }));
    expect(
      await screen.findByRole("region", { name: "String table" }),
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
    fireEvent.click(
      await screen.findByRole("button", { name: /Browse all mods/ }),
    );
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search strings" }),
      { target: { value: "mittags" } },
    );

    // No escape hatch until a mod is selected — global search is the default.
    expect(
      screen.queryByRole("button", { name: /Search all mods/ }),
    ).toBeNull();

    // Open a result, then bounce back out to the cross-mod search.
    fireEvent.click(await screen.findByRole("button", { name: /Second Mod/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: /Search all mods/ }),
    );

    // The global result is reachable again with the query intact.
    expect(
      await screen.findByRole("button", { name: /Second Mod/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("searchbox", { name: "Search strings" }),
    ).toHaveValue("mittags");
  });

  it("the dashboard review queue jumps into the mod filtered to review-needed", async () => {
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

    // The queue lists the mod; clicking it opens the work view on its
    // review backlog (status filter pre-set to review-needed).
    fireEvent.click(await screen.findByRole("button", { name: /Test Mod/ }));
    expect(
      await screen.findByRole("region", { name: "String table" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Hallo KI")).toBeInTheDocument();
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

    expect(
      await screen.findByRole("dialog", { name: "Scan" }),
    ).toHaveTextContent("Mods folder not found");
  });

  it("keeps the progress dialog for a manual re-scan", async () => {
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
      expect(screen.getByRole("button", { name: "Scan" })).toBeEnabled(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Scan" }));
    expect(
      await screen.findByRole("dialog", { name: "Scan" }),
    ).toHaveTextContent("Scanning mods");
    finishScan(EMPTY_SCAN);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Scan" })).toBeNull(),
    );
  });
});
