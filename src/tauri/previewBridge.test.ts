import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

// The browser preview answers every backend command with synthetic data. A
// command added to the Tauri handler list without a preview case would only
// fail when someone clicks it in the preview, so check the lists match.
it("has a browser-preview case for every registered backend command", () => {
  const lib = readFileSync(resolve("src-tauri/src/lib.rs"), "utf8");
  const handler = /generate_handler!\[([^\]]*)\]/.exec(lib);
  expect(handler).not.toBeNull();
  const commands = handler![1]
    .split(",")
    .map((name) => name.trim().split("::").pop() ?? "")
    .filter(Boolean);
  expect(commands.length).toBeGreaterThan(10);

  const bridge = readFileSync(resolve("src/tauri/previewBridge.ts"), "utf8");
  const missing = commands.filter(
    (command) => !bridge.includes(`case "${command}":`),
  );
  expect(missing).toEqual([]);
});

it("refuses a preview undo after one of its strings changed again", async () => {
  const { installPreviewBridge } = await import("./previewBridge");
  installPreviewBridge();
  const invoke = (
    window as unknown as {
      __TAURI_INTERNALS__: {
        invoke: (cmd: string, args?: object) => Promise<unknown>;
      };
    }
  ).__TAURI_INTERNALS__.invoke;
  const entry = (await invoke("save_string_groups_with_undo", {
    title: "Bulk edit",
    groups: [
      {
        modUniqueId: "Preview.EdgeCases",
        entries: [
          {
            key: "greeting",
            source: "Hello",
            target: "Hallo zusammen",
            status: "translated",
          },
        ],
      },
    ],
  })) as { id: string };
  await invoke("save_string", {
    modUniqueId: "Preview.EdgeCases",
    key: "greeting",
    target: "Servus",
    status: "translated",
    source: "Hello",
  });
  await expect(
    invoke("undo_batch_edit", { operationId: entry.id }),
  ).rejects.toThrow(/changed afterwards/);
});
