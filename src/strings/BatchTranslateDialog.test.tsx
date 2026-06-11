/**
 * BatchTranslateDialog in isolation — serial run, cancel semantics (finish the
 * in-flight string, then stop), error abort, and the token-problem summary.
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { vi } from "vitest";
import { BatchTranslateDialog, type BatchItem } from "./BatchTranslateDialog";
import type { TranslationResult } from "../tauri/commands";

const ITEMS: BatchItem[] = [
  {
    index: 0,
    key: "first.key",
    file: "i18n",
    source: "One",
    section: "Dialogue",
  },
  { index: 1, key: "second.key", file: "i18n", source: "Two" },
];

function ok(text: string): TranslationResult {
  return { text, missingTokens: [], glossaryMisses: [] };
}

function renderDialog(
  onTranslate: (
    source: string,
    section?: string | null,
  ) => Promise<TranslationResult>,
  onResult = vi.fn().mockResolvedValue(undefined),
) {
  const onClose = vi.fn();
  render(
    <BatchTranslateDialog
      items={ITEMS}
      modName="Test Mod"
      onTranslate={onTranslate}
      onResult={onResult}
      onClose={onClose}
    />,
  );
  return { onResult, onClose };
}

describe("BatchTranslateDialog", () => {
  it("translates all items serially and saves each result", async () => {
    const calls: string[] = [];
    const onTranslate = vi.fn(async (source: string) => {
      calls.push(source);
      return ok(`X-${source}`);
    });
    const { onResult, onClose } = renderDialog(onTranslate);

    await screen.findByText("Batch translation complete");
    expect(calls).toEqual(["One", "Two"]);
    expect(onTranslate).toHaveBeenNthCalledWith(1, "One", "Dialogue");
    expect(onTranslate).toHaveBeenNthCalledWith(2, "Two", undefined);
    expect(onResult).toHaveBeenNthCalledWith(1, ITEMS[0], "X-One");
    expect(onResult).toHaveBeenNthCalledWith(2, ITEMS[1], "X-Two");
    expect(screen.getByText(/saved as “Needs review”/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("cancel finishes the in-flight string, saves it, then stops", async () => {
    let release: (result: TranslationResult) => void = () => {};
    const onTranslate = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<TranslationResult>((resolve) => (release = resolve)),
      )
      .mockResolvedValue(ok("never reached"));
    const { onResult } = renderDialog(onTranslate);

    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    release(ok("Eins"));

    await screen.findByText("Batch translation cancelled");
    // The in-flight string was saved; the second was never requested.
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith(ITEMS[0], "Eins");
    expect(onTranslate).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Re-run later to continue/)).toBeInTheDocument();
  });

  it("a server error aborts the run and keeps the partial progress", async () => {
    const onTranslate = vi
      .fn()
      .mockResolvedValueOnce(ok("Eins"))
      .mockRejectedValueOnce("Could not reach http://localhost:1234");
    const { onResult } = renderDialog(onTranslate);

    await screen.findByText("Batch translation failed");
    expect(
      screen.getByText(/Could not reach http:\/\/localhost:1234/),
    ).toBeInTheDocument();
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Re-run later to continue/)).toBeInTheDocument();
  });

  it("lists strings whose result still misses protected tokens", async () => {
    const onTranslate = vi
      .fn()
      .mockResolvedValueOnce({
        text: "kaputt",
        missingTokens: ["{{name}}"],
        glossaryMisses: [],
      })
      .mockResolvedValueOnce(ok("gut"));
    renderDialog(onTranslate);

    await screen.findByText("Batch translation complete");
    expect(screen.getByText(/Dropped protected tokens/)).toBeInTheDocument();
    expect(screen.getByText("first.key")).toBeInTheDocument();
  });
});
