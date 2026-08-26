import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelAiRun,
  codexCliStatus,
  exportAllMods,
  exportLlmBatchToPath,
  listOperationHistory,
  pickLlmBatchDestination,
  pickLlmBatchFile,
  preflightLlmBatchPath,
  saveString,
  saveStringGroupsWithUndo,
  saveStringsWithUndo,
  translateWithCodexCli,
  translateWithLocalAi,
  undoBatchEdit,
  type AiTranslationRequest,
  type ExportModInput,
} from "./commands";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

describe("backend command bridges", () => {
  beforeEach(() => invokeMock.mockReset());

  it("passes all export groups to the atomic aggregate command", async () => {
    const mods: ExportModInput[] = [
      {
        modUniqueId: "example.mod",
        modName: "Example Mod",
        files: [
          {
            relativeDir: "i18n",
            defaultPath: "C:\\Mods\\Example\\i18n\\default.json",
            targetPath: "C:\\Mods\\Example\\i18n\\de.json",
          },
        ],
      },
    ];
    invokeMock.mockResolvedValue({ blocked: false });

    await exportAllMods(mods);

    expect(invokeMock).toHaveBeenCalledWith("export_all_mods", { mods });
  });

  it("uses the read-only JSON picker command without import arguments", async () => {
    invokeMock.mockResolvedValue("C:\\Temp\\result.json");

    await expect(pickLlmBatchFile()).resolves.toBe("C:\\Temp\\result.json");

    expect(invokeMock).toHaveBeenCalledWith("pick_llm_batch_file");
  });

  it("preflights the chosen LLM batch path without invoking import", async () => {
    const files = [
      {
        relativeDir: "i18n",
        defaultPath: "C:\\Mods\\Example\\i18n\\default.json",
        targetPath: "C:\\Mods\\Example\\i18n\\de.json",
      },
    ];
    invokeMock.mockResolvedValue({ ready: true });

    await preflightLlmBatchPath("example.mod", files, "C:\\Temp\\result.json");

    expect(invokeMock).toHaveBeenCalledWith("preflight_llm_batch_path", {
      modUniqueId: "example.mod",
      files,
      path: "C:\\Temp\\result.json",
    });
    expect(invokeMock).not.toHaveBeenCalledWith(
      "import_llm_batch_path",
      expect.anything(),
    );
  });

  it("chooses an LLM batch destination without exporting", async () => {
    invokeMock.mockResolvedValue("C:\\Temp\\chosen.json");

    await expect(
      pickLlmBatchDestination("Example.de.llm-batch.json"),
    ).resolves.toBe("C:\\Temp\\chosen.json");

    expect(invokeMock).toHaveBeenCalledWith("pick_llm_batch_destination", {
      suggestedFileName: "Example.de.llm-batch.json",
    });
  });

  it("exports the existing LLM batch format to a previously chosen path", async () => {
    const items = [{ relativeDir: "i18n", key: "greeting", source: "Hello" }];
    invokeMock.mockResolvedValue({
      path: "C:\\Temp\\chosen.json",
      stringCount: 1,
    });

    await exportLlmBatchToPath("example.mod", items, "C:\\Temp\\chosen.json");

    expect(invokeMock).toHaveBeenCalledWith("export_llm_batch_to_path", {
      modUniqueId: "example.mod",
      items,
      path: "C:\\Temp\\chosen.json",
    });
  });

  it("stores an accepted review-needed token mismatch without confirming AI output", async () => {
    invokeMock.mockResolvedValue(undefined);

    await saveString(
      "example.mod",
      "i18n",
      "greeting",
      "Hallo$7",
      "review-needed",
      "Hello$8",
      true,
    );

    expect(invokeMock).toHaveBeenCalledWith("save_string", {
      modUniqueId: "example.mod",
      relativeDir: "i18n",
      key: "greeting",
      target: "Hallo$7",
      status: "review-needed-token-mismatch-accepted",
      source: "Hello$8",
    });
  });

  it("exposes bounded result history and the conditional batch undo command", async () => {
    const entries = [
      {
        relativeDir: "i18n",
        key: "greeting",
        target: "Hallo",
        status: "translated" as const,
        source: "Hello",
      },
    ];
    invokeMock.mockResolvedValueOnce({ id: "operation-1", canUndo: true });

    await saveStringsWithUndo("example.mod", "Marked as done", entries);
    expect(invokeMock).toHaveBeenLastCalledWith("save_strings_with_undo", {
      modUniqueId: "example.mod",
      title: "Marked as done",
      entries,
    });

    const groups = [
      { modUniqueId: "example.mod", entries },
      { modUniqueId: "example.content-pack", entries },
    ];
    invokeMock.mockResolvedValueOnce({ id: "operation-2", canUndo: true });
    await saveStringGroupsWithUndo("Marked as done", groups);
    expect(invokeMock).toHaveBeenLastCalledWith(
      "save_string_groups_with_undo",
      { title: "Marked as done", groups },
    );

    invokeMock.mockResolvedValueOnce([{ id: "operation-1" }]);
    await listOperationHistory();
    expect(invokeMock).toHaveBeenLastCalledWith("list_operation_history");

    invokeMock.mockResolvedValueOnce({ id: "operation-2", canUndo: false });
    await undoBatchEdit("operation-1");
    expect(invokeMock).toHaveBeenLastCalledWith("undo_batch_edit", {
      operationId: "operation-1",
    });
  });

  it("keeps Codex status separate from a bounded translation request", async () => {
    const request: AiTranslationRequest = {
      runId: "run-1",
      scope: "selected",
      identities: [
        {
          modUniqueId: " example.mod ",
          relativeDir: "i18n/sub ",
          key: " greeting ",
        },
      ],
      includeOpen: true,
      includeChanged: false,
    };
    invokeMock.mockResolvedValueOnce({ installed: true, authenticated: true });
    await codexCliStatus();
    expect(invokeMock).toHaveBeenLastCalledWith("codex_cli_status");

    invokeMock.mockResolvedValueOnce({ outcome: "complete", suggestions: [] });
    await translateWithCodexCli(request);
    expect(invokeMock).toHaveBeenLastCalledWith("translate_with_codex_cli", {
      request,
    });

    invokeMock.mockResolvedValueOnce(true);
    await cancelAiRun("run-1");
    expect(invokeMock).toHaveBeenLastCalledWith("cancel_ai_run", {
      runId: "run-1",
    });
  });

  it("sends only exact selected identities to Local AI", async () => {
    const request: AiTranslationRequest = {
      runId: "run-selected",
      scope: "selected",
      identities: [
        {
          modUniqueId: "example.component",
          relativeDir: "i18n",
          key: "greeting",
        },
      ],
      includeOpen: true,
      includeChanged: true,
    };
    invokeMock.mockResolvedValue({ outcome: "complete", suggestions: [] });

    await translateWithLocalAi(request);
    expect(invokeMock).toHaveBeenLastCalledWith("translate_with_local_ai", {
      request,
    });
    expect(request.identities).toHaveLength(1);
    expect(request).not.toHaveProperty("subjectModUniqueId");
    expect(request).not.toHaveProperty("targetLanguage");
    expect(request).not.toHaveProperty("items");
  });
});
