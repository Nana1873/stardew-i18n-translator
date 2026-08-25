import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  exportAllMods,
  pickLlmBatchFile,
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
});
