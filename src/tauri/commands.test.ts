import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  exportAllMods,
  exportLlmBatchToPath,
  pickLlmBatchDestination,
  pickLlmBatchFile,
  saveString,
  type ExportModInput,
} from "./commands";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

describe("V3 backend command bridges", () => {
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
});
