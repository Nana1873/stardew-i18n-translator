export type FileDragDropEvent =
  | { type: "enter"; paths: string[] }
  | { type: "over" }
  | { type: "drop"; paths: string[] }
  | { type: "leave" };

/**
 * Subscribe to native Tauri file-drop events. Dynamic import keeps ordinary
 * browser previews and jsdom tests usable without a Tauri runtime.
 */
export async function listenForFileDrops(
  handler: (event: FileDragDropEvent) => void,
): Promise<() => void> {
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  return getCurrentWebview().onDragDropEvent(({ payload }) => {
    if (payload.type === "enter" || payload.type === "drop") {
      handler({ type: payload.type, paths: payload.paths });
    } else {
      handler({ type: payload.type });
    }
  });
}
