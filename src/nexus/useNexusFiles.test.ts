import { act, renderHook, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import type { NexusFile } from "../tauri/commands";
const list = vi.fn();
vi.mock("../tauri/commands", () => ({
  nexusListFiles: (...args: unknown[]) => list(...args),
}));
import { useNexusFiles } from "./useNexusFiles";
const file = { fileId: 1, fileName: "de.zip" } as NexusFile;
const defer = () => {
  let resolve!: (files: NexusFile[]) => void;
  const promise = new Promise<NexusFile[]>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
beforeEach(() => {
  list.mockReset();
});

it("loads at most two candidates concurrently, deduplicates IDs and caches reopening", async () => {
  const pending = [defer(), defer(), defer()];
  list.mockImplementation((id: number) => pending[id - 1].promise);
  const app = renderHook(
    ({ open }) => useNexusFiles([1, 1, 2, 3], open, "de|vortex"),
    { initialProps: { open: false } },
  );
  expect(list).not.toHaveBeenCalled();
  app.rerender({ open: true });
  expect(list.mock.calls).toEqual([[1], [2]]);
  await act(async () => pending[0].resolve([file]));
  expect(list.mock.calls).toEqual([[1], [2], [3]]);
  await act(async () => {
    pending[1].resolve([file]);
    pending[2].resolve([file]);
  });
  app.rerender({ open: false });
  app.rerender({ open: true });
  expect(list).toHaveBeenCalledTimes(3);
  expect(Object.keys(app.result.current.entries)).toHaveLength(3);
});

it("stops queued loads after close and ignores late results", async () => {
  const pending = defer();
  list.mockReturnValue(pending.promise);
  const app = renderHook(
    ({ open }) => useNexusFiles([1, 2, 3], open, "de|vortex"),
    { initialProps: { open: true } },
  );
  app.rerender({ open: false });
  await act(async () => pending.resolve([file]));
  expect(list).toHaveBeenCalledTimes(2);
  expect(app.result.current.entries).toEqual({});
});

it("discards old-method responses without exceeding the concurrency limit", async () => {
  const old = defer(),
    fresh = defer();
  list.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  const app = renderHook(({ context }) => useNexusFiles([1], true, context), {
    initialProps: { context: "de|vortex" },
  });
  app.rerender({ context: "de|folder" });
  expect(list).toHaveBeenCalledOnce();
  await act(async () => old.resolve([{ ...file, fileId: 99 }]));
  expect(app.result.current.entries).toEqual({});
  await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  await act(async () => fresh.resolve([file]));
  expect(app.result.current.entries[1].files).toEqual([file]);
});

it("ignores removed candidates and does not continue after unmount", async () => {
  const old = defer();
  list.mockReturnValue(old.promise);
  const app = renderHook(({ ids }) => useNexusFiles(ids, true, "de|vortex"), {
    initialProps: { ids: [1, 2, 3] },
  });
  app.rerender({ ids: [] });
  app.unmount();
  await act(async () => old.resolve([file]));
  expect(list).toHaveBeenCalledTimes(2);
});

it("retries failed metadata only on explicit refresh", async () => {
  list
    .mockRejectedValueOnce(new Error("Unavailable"))
    .mockResolvedValue([file]);
  const app = renderHook(() => useNexusFiles([1], true, "de|folder"));
  await waitFor(() =>
    expect(app.result.current.entries[1].error).toContain("Unavailable"),
  );
  app.rerender();
  expect(list).toHaveBeenCalledOnce();
  act(() => app.result.current.refresh());
  await waitFor(() =>
    expect(app.result.current.entries[1].files).toEqual([file]),
  );
});
