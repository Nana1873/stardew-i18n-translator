import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

// jsdom has no layout, so the real virtualizer renders nothing — return a fixed
// window of items so the rendering logic is exercised.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: () => ({
    getTotalSize: () => 60,
    getVirtualItems: () => [
      { key: 0, index: 0, start: 0, size: 30 },
      { key: 1, index: 1, start: 30, size: 30 },
    ],
  }),
}));

import { StringTable, StringTableHeader } from "./StringTable";
import type { ScannedMod } from "../tauri/commands";

const MOD: ScannedMod = {
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
      translatedKeys: 1,
    },
  ],
  totalKeys: 2,
  translatedKeys: 1,
  progress: 0.5,
  status: "untranslated",
};

function mockStrings(
  rows: Array<{
    key: string;
    source: string;
    target: string;
    targetPresent?: boolean;
    status?: string;
  }>,
) {
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "load_strings") {
      return Promise.resolve(
        rows.map((r) => ({
          targetPresent: false,
          status: r.target ? "translated" : "untranslated",
          ...r,
        })),
      );
    }
    return Promise.resolve(undefined); // save_string
  });
}

beforeEach(() => {
  invokeMock.mockReset();
  mockStrings([
    { key: "greeting", source: "Hello", target: "Hallo", targetPresent: true },
    { key: "bye", source: "Bye", target: "" },
  ]);
});

describe("StringTable", () => {
  it("loads the mod's strings via load_strings and renders them", async () => {
    render(<StringTable mod={MOD} />);

    expect(await screen.findByText("greeting")).toBeInTheDocument();
    expect(screen.getByText("Hello")).toBeInTheDocument();
    expect(screen.getByText("Hallo")).toBeInTheDocument();

    expect(invokeMock).toHaveBeenCalledWith("load_strings", {
      modUniqueId: "a.b",
      relativeDir: "i18n",
      defaultPath: "x/i18n/default.json",
      targetPath: "x/i18n/de.json",
    });
  });

  it("persists an edit via save_string (status done) on Save", async () => {
    render(<StringTable mod={MOD} />);
    fireEvent.doubleClick(await screen.findByText("greeting"));

    fireEvent.change(screen.getByLabelText("Translation"), {
      target: { value: "Hallo Welt" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("save_string", {
        modUniqueId: "a.b",
        relativeDir: "i18n",
        key: "greeting",
        target: "Hallo Welt",
        status: "translated",
        source: "Hello",
      }),
    );
  });

  it("Reset clears the field and saves the string as untranslated", async () => {
    render(<StringTable mod={MOD} />);
    fireEvent.doubleClick(await screen.findByText("greeting"));

    const textarea = screen.getByLabelText(
      "Translation",
    ) as HTMLTextAreaElement;
    expect(textarea.value).toBe("Hallo");

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(textarea.value).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "save_string",
        expect.objectContaining({
          key: "greeting",
          target: "",
          status: "untranslated",
        }),
      ),
    );
  });

  it("shows glossary hints in the editor and inserts the term on click", async () => {
    render(<StringTable mod={MOD} glossary={{ Bye: "Tschüss" }} />);
    fireEvent.doubleClick(await screen.findByText("bye"));

    const textarea = screen.getByLabelText(
      "Translation",
    ) as HTMLTextAreaElement;
    expect(textarea.value).toBe("");

    fireEvent.click(await screen.findByRole("button", { name: /Bye/ }));
    expect(textarea.value).toBe("Tschüss");
  });

  it("shows a validation error icon when a source token is missing", async () => {
    mockStrings([
      {
        key: "greet",
        source: "Hi {{name}}",
        target: "Hallo",
        targetPresent: true,
      },
      { key: "ok", source: "Yes", target: "Ja", targetPresent: true },
    ]);
    render(<StringTable mod={MOD} />);

    expect(
      await screen.findByTitle("Missing token {{name}}"),
    ).toBeInTheDocument();
  });

  it("inserts a protected token at the cursor when its chip is clicked", async () => {
    mockStrings([
      { key: "g", source: "Hi {{name}}", target: "" },
      { key: "ok", source: "Yes", target: "" },
    ]);
    render(<StringTable mod={MOD} />);

    fireEvent.doubleClick(await screen.findByText("g"));
    const textarea = screen.getByLabelText(
      "Translation",
    ) as HTMLTextAreaElement;
    expect(textarea.value).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "{{name}}" }));
    expect(textarea.value).toBe("{{name}}");
  });

  it("sorts rows by a column when its header is clicked", async () => {
    mockStrings([
      { key: "zebra", source: "Z", target: "z", targetPresent: true },
      { key: "alpha", source: "A", target: "a", targetPresent: true },
    ]);
    render(<StringTable mod={MOD} />);

    // Default order: zebra then alpha (file order).
    await screen.findByText("zebra");
    const keysBefore = screen
      .getAllByText(/zebra|alpha/)
      .map((n) => n.textContent);
    expect(keysBefore[0]).toBe("zebra");

    // Click "Key" header → ascending → alpha first.
    fireEvent.click(screen.getByRole("button", { name: /^Key/ }));
    const keysAfter = screen
      .getAllByText(/zebra|alpha/)
      .map((n) => n.textContent);
    expect(keysAfter[0]).toBe("alpha");
  });

  it("filters rows by search text across key/original/target", async () => {
    render(<StringTable mod={MOD} search="bye" statusFilter="all" />);

    expect(await screen.findByText("bye")).toBeInTheDocument();
    expect(screen.queryByText("greeting")).not.toBeInTheDocument();
  });

  it("filters rows by status", async () => {
    render(<StringTable mod={MOD} search="" statusFilter="untranslated" />);

    // Only the untranslated row ("bye", empty target) remains.
    expect(await screen.findByText("bye")).toBeInTheDocument();
    expect(screen.queryByText("greeting")).not.toBeInTheDocument();
  });

  it("shows an empty hint when nothing matches the filter", async () => {
    render(<StringTable mod={MOD} search="zzz-no-match" statusFilter="all" />);

    expect(
      await screen.findByText("No strings match the current filter."),
    ).toBeInTheDocument();
  });

  it("AI translate fills the field, flags needs-review, and Save confirms translated", async () => {
    const onTranslate = vi.fn().mockResolvedValue({
      text: "Tschüss!",
      missingTokens: [],
      glossaryMisses: [],
    });
    render(<StringTable mod={MOD} onTranslate={onTranslate} />);
    fireEvent.doubleClick(await screen.findByText("bye"));

    fireEvent.click(screen.getByRole("button", { name: "Translate" }));
    const textarea = screen.getByLabelText(
      "Translation",
    ) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe("Tschüss!"));
    expect(onTranslate).toHaveBeenCalledWith("Bye");
    // Badge shows the unreviewed status.
    expect(screen.getByText(/Needs review/)).toBeInTheDocument();

    // Explicit Save = the user reviewed it → persisted as translated.
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "save_string",
        expect.objectContaining({
          key: "bye",
          target: "Tschüss!",
          status: "translated",
        }),
      ),
    );
  });

  it("navigating away from an AI suggestion auto-saves it as review-needed", async () => {
    const onTranslate = vi.fn().mockResolvedValue({
      text: "Hallo Welt",
      missingTokens: [],
      glossaryMisses: [],
    });
    render(<StringTable mod={MOD} onTranslate={onTranslate} />);
    fireEvent.doubleClick(await screen.findByText("greeting"));

    fireEvent.click(screen.getByRole("button", { name: "Translate" }));
    await waitFor(() =>
      expect(
        (screen.getByLabelText("Translation") as HTMLTextAreaElement).value,
      ).toBe("Hallo Welt"),
    );

    // Next (auto-save without confirming) keeps the review-needed status.
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "save_string",
        expect.objectContaining({ key: "greeting", status: "review-needed" }),
      ),
    );
  });

  it("flags dropped tokens returned by the AI", async () => {
    mockStrings([
      { key: "g", source: "Hi {{name}}", target: "" },
      { key: "ok", source: "Yes", target: "" },
    ]);
    const onTranslate = vi.fn().mockResolvedValue({
      text: "Hallo",
      missingTokens: ["{{name}}"],
      glossaryMisses: [],
    });
    render(<StringTable mod={MOD} onTranslate={onTranslate} />);
    fireEvent.doubleClick(await screen.findByText("g"));

    fireEvent.click(screen.getByRole("button", { name: "Translate" }));
    expect(
      await screen.findByText(/AI dropped token\(s\): \{\{name\}\}/),
    ).toBeInTheDocument();
  });

  it("without an AI configured, Translate shows a configure hint", async () => {
    render(<StringTable mod={MOD} />);
    fireEvent.doubleClick(await screen.findByText("greeting"));

    fireEvent.click(screen.getByRole("button", { name: "Translate" }));
    expect(
      await screen.findByText(/Configure a local AI in Settings/),
    ).toBeInTheDocument();
  });

  it("right-click → Mark as not translatable persists via one bulk save", async () => {
    render(<StringTable mod={MOD} />);
    fireEvent.contextMenu(await screen.findByText("greeting"));

    fireEvent.click(
      screen.getByRole("menuitem", { name: "Mark as not translatable" }),
    );

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "save_strings",
        expect.objectContaining({
          modUniqueId: "a.b",
          entries: [
            expect.objectContaining({
              key: "greeting",
              status: "not-translatable",
            }),
          ],
        }),
      ),
    );
  });

  it("bulk action saves every selected row in ONE save_strings call", async () => {
    render(<StringTable mod={MOD} />);
    fireEvent.click(await screen.findByText("greeting"));
    fireEvent.click(screen.getByText("bye"), { ctrlKey: true });
    fireEvent.contextMenu(screen.getByText("bye"));

    fireEvent.click(
      screen.getByRole("menuitem", { name: "Mark as not translatable" }),
    );

    await waitFor(() => {
      const calls = invokeMock.mock.calls.filter(
        ([cmd]) => cmd === "save_strings",
      );
      expect(calls).toHaveLength(1);
      const args = calls[0][1] as { entries: Array<{ key: string }> };
      expect(args.entries.map((e) => e.key).sort()).toEqual([
        "bye",
        "greeting",
      ]);
    });
    // No racy per-string saves alongside the bulk call.
    expect(invokeMock).not.toHaveBeenCalledWith(
      "save_string",
      expect.anything(),
    );
  });

  it("reports fresh translated counts after an edit and after a bulk action", async () => {
    const onCountsChange = vi.fn();
    render(<StringTable mod={MOD} onCountsChange={onCountsChange} />);

    // Edit: translating "bye" brings the working count to 2 of 2.
    fireEvent.doubleClick(await screen.findByText("bye"));
    fireEvent.change(screen.getByLabelText("Translation"), {
      target: { value: "Tschüss" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onCountsChange).toHaveBeenCalledWith(2, 0));

    // Bulk: clearing both translations drops the count to 0.
    onCountsChange.mockClear();
    fireEvent.click(screen.getByText("greeting"));
    fireEvent.click(screen.getByText("bye"), { ctrlKey: true });
    fireEvent.contextMenu(screen.getByText("bye"));
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Clear translation" }),
    );
    await waitFor(() => expect(onCountsChange).toHaveBeenCalledWith(0, 0));
  });

  it("batch-translates only untranslated/outdated rows in the selection as review-needed", async () => {
    const onTranslate = vi.fn().mockResolvedValue({
      text: "KI-Text",
      missingTokens: [],
      glossaryMisses: [],
    });
    const onCountsChange = vi.fn();
    render(
      <StringTable
        mod={MOD}
        onTranslate={onTranslate}
        onCountsChange={onCountsChange}
      />,
    );

    // Select both rows; only "bye" (untranslated) is eligible — "greeting" is
    // already translated and must not be re-translated.
    fireEvent.click(await screen.findByText("greeting"));
    fireEvent.click(screen.getByText("bye"), { ctrlKey: true });
    fireEvent.contextMenu(screen.getByText("bye"));
    fireEvent.click(
      screen.getByRole("menuitem", { name: /Translate missing with local AI/ }),
    );

    await screen.findByText("Batch translation complete");
    expect(onTranslate).toHaveBeenCalledTimes(1);
    expect(onTranslate).toHaveBeenCalledWith("Bye");
    expect(invokeMock).toHaveBeenCalledWith(
      "save_string",
      expect.objectContaining({
        key: "bye",
        target: "KI-Text",
        status: "review-needed",
      }),
    );

    // Closing the dialog reports the fresh working count (both non-empty now,
    // one of them an unreviewed AI suggestion).
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onCountsChange).toHaveBeenCalledWith(2, 1);
  });

  it("the batch menu item is disabled without an AI configured", async () => {
    render(<StringTable mod={MOD} />);
    fireEvent.contextMenu(await screen.findByText("bye"));

    expect(
      screen.getByRole("menuitem", { name: /Translate missing with local AI/ }),
    ).toBeDisabled();
  });

  it("exports only eligible rows as a Claude batch and shows the outcome", async () => {
    const onClaudeExport = vi.fn().mockResolvedValue({
      path: "C:/out/a.b.claude-batch.json",
      stringCount: 1,
      glossaryTerms: 2,
    });
    render(<StringTable mod={MOD} onClaudeExport={onClaudeExport} />);

    // Select both rows; only "bye" (untranslated) is eligible.
    fireEvent.click(await screen.findByText("greeting"));
    fireEvent.click(screen.getByText("bye"), { ctrlKey: true });
    fireEvent.contextMenu(screen.getByText("bye"));
    fireEvent.click(
      screen.getByRole("menuitem", { name: /Export for Claude Code/ }),
    );

    await screen.findByText("Batch exported");
    expect(onClaudeExport).toHaveBeenCalledWith([
      { relativeDir: "i18n", key: "bye", source: "Bye" },
    ]);
    expect(
      screen.getByText("C:/out/a.b.claude-batch.json"),
    ).toBeInTheDocument();
  });

  it("a cancelled Claude export (null outcome) shows no dialog", async () => {
    const onClaudeExport = vi.fn().mockResolvedValue(null);
    render(<StringTable mod={MOD} onClaudeExport={onClaudeExport} />);

    fireEvent.click(await screen.findByText("bye"));
    fireEvent.contextMenu(screen.getByText("bye"));
    fireEvent.click(
      screen.getByRole("menuitem", { name: /Export for Claude Code/ }),
    );

    await waitFor(() => expect(onClaudeExport).toHaveBeenCalled());
    expect(screen.queryByText("Batch exported")).not.toBeInTheDocument();
  });

  it("the Claude export menu item is disabled without a target language", async () => {
    render(<StringTable mod={MOD} />);
    fireEvent.contextMenu(await screen.findByText("bye"));

    expect(
      screen.getByRole("menuitem", { name: /Export for Claude Code/ }),
    ).toBeDisabled();
  });

  it("the header shows a needs-review tail so 100% never hides pending review", () => {
    const { rerender } = render(
      <StringTableHeader mod={{ ...MOD, reviewNeeded: 277 }} />,
    );
    expect(screen.getByText(/277 need review/)).toBeInTheDocument();

    // Without unreviewed suggestions there is no tail.
    rerender(<StringTableHeader mod={{ ...MOD, reviewNeeded: 0 }} />);
    expect(screen.queryByText(/need review/)).not.toBeInTheDocument();
  });
});
