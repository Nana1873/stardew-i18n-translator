import { describe, expect, it, vi } from "vitest";

const unlisten = vi.fn();
let nativeHandler:
  | ((event: {
      payload:
        | { type: "enter"; paths: string[]; position: unknown }
        | { type: "over"; position: unknown }
        | { type: "drop"; paths: string[]; position: unknown }
        | { type: "leave" };
    }) => void)
  | null = null;

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: vi.fn(
      (handler: NonNullable<typeof nativeHandler>): Promise<() => void> => {
        nativeHandler = handler;
        return Promise.resolve(unlisten);
      },
    ),
  }),
}));

import { listenForFileDrops } from "./dragDrop";

describe("listenForFileDrops", () => {
  it("maps native enter, drop, and leave events and returns cleanup", async () => {
    const handler = vi.fn();
    const stop = await listenForFileDrops(handler);

    nativeHandler?.({
      payload: {
        type: "enter",
        paths: ["C:/result.json"],
        position: { x: 1, y: 2 },
      },
    });
    nativeHandler?.({
      payload: {
        type: "drop",
        paths: ["C:/result.json"],
        position: { x: 1, y: 2 },
      },
    });
    nativeHandler?.({ payload: { type: "leave" } });

    expect(handler).toHaveBeenNthCalledWith(1, {
      type: "enter",
      paths: ["C:/result.json"],
    });
    expect(handler).toHaveBeenNthCalledWith(2, {
      type: "drop",
      paths: ["C:/result.json"],
    });
    expect(handler).toHaveBeenNthCalledWith(3, { type: "leave" });

    stop();
    expect(unlisten).toHaveBeenCalled();
  });
});
