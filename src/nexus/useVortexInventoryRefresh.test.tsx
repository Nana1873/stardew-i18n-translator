import { act, fireEvent, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { VortexInstalledFile } from "../tauri/commands";
import { useVortexInventoryRefresh } from "./useVortexInventoryRefresh";

const installed = [{ modId: 30, fileId: 7 }];

describe("independent Vortex inventory refresh", () => {
  it("refreshes on return without a scan and preserves confirmed files when unavailable", async () => {
    const refresh = vi
      .fn<() => Promise<VortexInstalledFile[] | null>>()
      .mockResolvedValueOnce(installed)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce([]);
    const apply = vi.fn();
    const { result } = renderHook(() =>
      useVortexInventoryRefresh({
        enabled: true,
        blocked: false,
        workspaceKey: "game|de",
        refresh,
        apply,
      }),
    );
    await waitFor(() => expect(apply).toHaveBeenLastCalledWith(installed));
    fireEvent.focus(window);
    await waitFor(() =>
      expect(result.current).toContain(
        "Last verified installations are retained",
      ),
    );
    expect(apply).toHaveBeenCalledTimes(1);
    fireEvent.focus(window);
    await waitFor(() => expect(apply).toHaveBeenLastCalledWith([]));
    expect(result.current).toBeUndefined();
  });

  it("coalesces return events and discards a previous workspace's response", async () => {
    let finish!: (files: VortexInstalledFile[]) => void;
    const refresh = vi
      .fn<() => Promise<VortexInstalledFile[] | null>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce([]);
    const apply = vi.fn();
    const { rerender } = renderHook(
      ({ workspaceKey }) =>
        useVortexInventoryRefresh({
          enabled: true,
          blocked: false,
          workspaceKey,
          refresh,
          apply,
        }),
      { initialProps: { workspaceKey: "game-a|de" } },
    );
    fireEvent.focus(window);
    fireEvent(document, new Event("visibilitychange"));
    expect(refresh).toHaveBeenCalledTimes(1);
    rerender({ workspaceKey: "game-b|de" });
    await waitFor(() => expect(apply).toHaveBeenLastCalledWith([]));
    await act(async () => finish(installed));
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("defers while another operation is active and stops when closed", async () => {
    const refresh = vi.fn().mockResolvedValue(installed);
    const apply = vi.fn();
    const { rerender } = renderHook(
      ({ enabled, blocked }) =>
        useVortexInventoryRefresh({
          enabled,
          blocked,
          workspaceKey: "game|de",
          refresh,
          apply,
        }),
      { initialProps: { enabled: true, blocked: true } },
    );
    fireEvent.focus(window);
    expect(refresh).not.toHaveBeenCalled();
    rerender({ enabled: true, blocked: false });
    await waitFor(() => expect(apply).toHaveBeenCalledOnce());
    rerender({ enabled: false, blocked: false });
    fireEvent.focus(window);
    expect(refresh).toHaveBeenCalledOnce();
  });
});
