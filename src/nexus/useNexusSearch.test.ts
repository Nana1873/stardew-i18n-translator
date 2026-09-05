import { act, renderHook } from "@testing-library/react";
import { vi } from "vitest";
import type { NexusSearchResult, ScannedMod } from "../tauri/commands";
const search = vi.fn();
vi.mock("../tauri/commands", () => ({
  nexusFindTranslations: (...args: unknown[]) => search(...args),
}));
import { useNexusSearch } from "./useNexusSearch";
import { nexusSourceDiskCoverage } from "./resolveTranslation";
const mod = (id: number | null, name = "Mod") =>
  ({ nexusId: id, name }) as ScannedMod;
const result = (modId: number): NexusSearchResult => ({
  modId,
  originalName: "Canonical",
  candidates: [],
  limited: true,
  notice: "Limited search",
});
beforeEach(() => {
  search.mockReset();
});

it("does not search until requested and searches all distinct positive IDs", async () => {
  search.mockImplementation((id: number) => Promise.resolve(result(id)));
  const hook = renderHook(() => useNexusSearch("mods|de"));
  expect(search).not.toHaveBeenCalled();
  await act(() =>
    hook.result.current.start(
      [mod(1, "A"), mod(1, "B"), mod(2), mod(null), mod(-3)],
      "de",
      { traversalComplete: true },
    ),
  );
  expect(search.mock.calls).toEqual([
    [1, "de", false],
    [2, "de", false],
  ]);
  expect(hook.result.current).toMatchObject({
    completed: 2,
    total: 2,
    noId: 2,
    running: false,
  });
  expect(hook.result.current.entries[0].localNames).toEqual(["A", "B"]);
});

it("retains partial results and continues after an individual failure", async () => {
  search
    .mockRejectedValueOnce(new Error("Unavailable"))
    .mockResolvedValueOnce(result(2));
  const hook = renderHook(() => useNexusSearch("mods|de"));
  await act(() => hook.result.current.start([mod(1), mod(2)], "de"));
  expect(hook.result.current.entries[0].error).toContain("Unavailable");
  expect(hook.result.current.entries[1].result?.modId).toBe(2);
  expect(hook.result.current.completed).toBe(2);
});

it("retains completed results and stops remaining requests on a global rate limit", async () => {
  search
    .mockResolvedValueOnce(result(1))
    .mockRejectedValueOnce(
      new Error(
        "Nexus request failed (HTTP 429). Retry later or check API setup.",
      ),
    );
  const hook = renderHook(() => useNexusSearch("mods|de"));
  await act(() => hook.result.current.start([mod(1), mod(2), mod(3)], "de"));
  expect(search).toHaveBeenCalledTimes(2);
  expect(hook.result.current).toMatchObject({
    completed: 2,
    total: 3,
    running: false,
  });
  expect(hook.result.current.entries[0].result?.modId).toBe(1);
  expect(hook.result.current.stoppedReason).toContain(
    "Partial results are retained",
  );
});

it("cancels the queue and ignores an in-flight response", async () => {
  let resolve!: (value: NexusSearchResult) => void;
  search.mockImplementation(
    () =>
      new Promise<NexusSearchResult>((r) => {
        resolve = r;
      }),
  );
  const hook = renderHook(() => useNexusSearch("mods|de"));
  let pending!: Promise<void>;
  act(() => {
    pending = hook.result.current.start([mod(1), mod(2)], "de");
  });
  act(() => hook.result.current.cancel());
  await act(async () => {
    resolve(result(1));
    await pending;
  });
  expect(search).toHaveBeenCalledTimes(1);
  expect(hook.result.current).toMatchObject({
    cancelled: true,
    running: false,
    entries: [],
  });
});

it("ignores results from a previous folder/language and resets on rescan", async () => {
  let resolve!: (value: NexusSearchResult) => void;
  search.mockImplementation(
    () =>
      new Promise<NexusSearchResult>((r) => {
        resolve = r;
      }),
  );
  const hook = renderHook(({ context }) => useNexusSearch(context), {
    initialProps: { context: "mods|de" },
  });
  let pending!: Promise<void>;
  act(() => {
    pending = hook.result.current.start([mod(1)], "de");
  });
  hook.rerender({ context: "other-mods|fr" });
  await act(async () => {
    resolve(result(1));
    await pending;
  });
  expect(hook.result.current.entries).toEqual([]);
  search.mockResolvedValue(result(2));
  await act(() => hook.result.current.start([mod(2)], "fr"));
  act(() => hook.result.current.reset());
  expect(hook.result.current.entries).toEqual([]);
});

it("skips fully covered Nexus groups using disk counts independently of Review and Changed status", async () => {
  search.mockImplementation((id: number) => Promise.resolve(result(id)));
  const hook = renderHook(() => useNexusSearch("mods|de"));
  await act(() =>
    hook.result.current.start(
      [
        {
          ...mod(1, "Complete"),
          totalKeys: 10,
          translatedKeys: 10,
          diskTranslatedKeys: 10,
          reviewNeeded: 5,
          statusCounts: {
            untranslated: 0,
            translated: 0,
            outdated: 5,
            "review-needed": 5,
          },
        },
        {
          ...mod(1, "Also complete"),
          totalKeys: 2,
          translatedKeys: 2,
          diskTranslatedKeys: 2,
        },
      ],
      "de",
      { traversalComplete: true },
    ),
  );
  expect(search).not.toHaveBeenCalled();
  expect(hook.result.current).toMatchObject({
    total: 0,
    completed: 0,
    skippedComplete: 1,
    running: false,
  });
});

it("still searches mixed components with the same Nexus ID and keeps both names", async () => {
  search.mockResolvedValue(result(1));
  const hook = renderHook(() => useNexusSearch("mods|de"));
  await act(() =>
    hook.result.current.start(
      [
        {
          ...mod(1, "Full"),
          totalKeys: 10,
          translatedKeys: 10,
          diskTranslatedKeys: 10,
        },
        {
          ...mod(1, "Partial"),
          totalKeys: 10,
          translatedKeys: 9,
          diskTranslatedKeys: 9,
        },
      ],
      "de",
      { traversalComplete: true },
    ),
  );
  expect(search).toHaveBeenCalledTimes(1);
  expect(hook.result.current.entries[0].localNames).toEqual([
    "Full",
    "Partial",
  ]);
  expect(hook.result.current.skippedComplete).toBe(0);
});

it("does not use rounded progress or call zero-key/unknown-count groups fully covered", async () => {
  search.mockImplementation((id: number) => Promise.resolve(result(id)));
  const hook = renderHook(() => useNexusSearch("mods|de"));
  await act(() =>
    hook.result.current.start(
      [
        {
          ...mod(1),
          totalKeys: 1000,
          translatedKeys: 996,
          diskTranslatedKeys: 996,
          progress: 1,
        },
        {
          ...mod(2),
          totalKeys: 0,
          translatedKeys: 0,
          diskTranslatedKeys: 0,
          progress: 1,
        },
        mod(3),
      ],
      "de",
      { traversalComplete: true },
    ),
  );
  expect(search).toHaveBeenCalledTimes(3);
  expect(hook.result.current.skippedComplete).toBe(0);
});

it("includes no-ID package companions before skipping a fully covered primary component", async () => {
  search.mockResolvedValue(result(1));
  const hook = renderHook(() => useNexusSearch("mods|vi"));
  await act(() =>
    hook.result.current.start(
      [
        {
          ...mod(1, "CP"),
          packageId: "RSV",
          totalKeys: 10,
          translatedKeys: 10,
          diskTranslatedKeys: 10,
        },
        {
          ...mod(null, "Code"),
          packageId: "RSV",
          totalKeys: 10,
          translatedKeys: 9,
          diskTranslatedKeys: 9,
        },
        {
          ...mod(null, "Unrelated"),
          packageId: "Other",
          totalKeys: 1,
          translatedKeys: 0,
          diskTranslatedKeys: 0,
        },
      ],
      "vi",
    ),
  );
  expect(search).toHaveBeenCalledWith(1, "vi", false);
  expect(hook.result.current.entries[0].localNames).toEqual(["CP", "Code"]);
  expect(hook.result.current.skippedComplete).toBe(0);
});

it("ignores a zero-key support component when the package has real fully covered strings", async () => {
  const hook = renderHook(() => useNexusSearch("mods|de"));
  await act(() =>
    hook.result.current.start(
      [
        {
          ...mod(1, "CP"),
          packageId: "RSV",
          totalKeys: 10,
          translatedKeys: 10,
          diskTranslatedKeys: 10,
        },
        {
          ...mod(null, "FTM"),
          packageId: "RSV",
          totalKeys: 0,
          translatedKeys: 0,
          diskTranslatedKeys: 0,
        },
      ],
      "de",
      { traversalComplete: true },
    ),
  );
  expect(search).not.toHaveBeenCalled();
  expect(hook.result.current.skippedComplete).toBe(1);
});

it("resets skipped coverage on folder/language change and explicit rescan", async () => {
  const hook = renderHook(({ context }) => useNexusSearch(context), {
    initialProps: { context: "mods|de" },
  });
  await act(() =>
    hook.result.current.start(
      [
        {
          ...mod(1),
          totalKeys: 10,
          translatedKeys: 10,
          diskTranslatedKeys: 10,
        },
      ],
      "de",
      { traversalComplete: true },
    ),
  );
  expect(hook.result.current.skippedComplete).toBe(1);
  hook.rerender({ context: "other|fr" });
  expect(hook.result.current.skippedComplete).toBe(0);
  search.mockResolvedValue(result(1));
  await act(() =>
    hook.result.current.start(
      [{ ...mod(1), totalKeys: 10, translatedKeys: 0, diskTranslatedKeys: 0 }],
      "fr",
    ),
  );
  expect(search).toHaveBeenCalledWith(1, "fr", false);
  act(() => hook.result.current.reset());
  expect(hook.result.current).toMatchObject({
    skippedComplete: 0,
    entries: [],
    total: 0,
  });
});

it("searches Review-only coverage and forwards explicit cache refresh and collection options", async () => {
  search.mockImplementation((id: number) => Promise.resolve(result(id)));
  const hook = renderHook(() => useNexusSearch("mods|de"));
  const reviewed = {
    ...mod(1),
    totalKeys: 10,
    translatedKeys: 10,
    diskTranslatedKeys: 0,
  };
  const complete = { ...reviewed, nexusId: 2, diskTranslatedKeys: 10 };
  await act(() =>
    hook.result.current.start([reviewed, complete], "de", {
      traversalComplete: true,
    }),
  );
  expect(search.mock.calls).toEqual([[1, "de", false]]);
  search.mockClear();
  await act(() =>
    hook.result.current.start([complete], "de", {
      includeComplete: true,
      forceRefresh: true,
    }),
  );
  expect(search.mock.calls).toEqual([[2, "de", true]]);
  search.mockClear();
  await act(() =>
    hook.result.current.start([complete], "de", { retainIds: [2] }),
  );
  expect(search.mock.calls).toEqual([[2, "de", false]]);
});

it.each([false, undefined])(
  "searches surviving fully translated components when traversal completeness is %s",
  async (traversalComplete) => {
    search.mockResolvedValue(result(1));
    const hook = renderHook(() => useNexusSearch("mods|de"));
    const surviving = {
      ...mod(1),
      packageId: "sample",
      uniqueId: "sample.mod",
      totalKeys: 1,
      diskTranslatedKeys: 1,
    };
    await act(() =>
      hook.result.current.start([surviving], "de", {
        skippedComponents: [],
        traversalComplete,
      }),
    );
    expect(search).toHaveBeenCalledWith(1, "de", false);
    expect(hook.result.current.skippedComplete).toBe(0);
    expect(
      nexusSourceDiskCoverage([surviving], 1, [], traversalComplete),
    ).toBeNull();
    expect(nexusSourceDiskCoverage([surviving], 1, [], true)?.complete).toBe(
      true,
    );
  },
);

it.each([
  ["same package", "sample", null, true, true],
  ["same component", null, "sample.mod", true, true],
  ["unknown location", null, null, true, true],
  ["other package", "other", "other.mod", true, false],
  ["intentional exclusion", "sample", null, false, false],
])(
  "handles scan diagnostics: %s",
  async (
    _label,
    packageId,
    componentUniqueId,
    requiresAttention,
    shouldSearch,
  ) => {
    search.mockResolvedValue(result(1));
    const hook = renderHook(() => useNexusSearch("mods|de"));
    const complete = {
      ...mod(1),
      packageId: "sample",
      uniqueId: "sample.mod",
      totalKeys: 10,
      diskTranslatedKeys: 10,
    };
    await act(() =>
      hook.result.current.start([complete], "de", {
        traversalComplete: true,
        skippedComponents: [
          {
            packageId: packageId as string | null,
            componentUniqueId: componentUniqueId as string | null,
            componentName: null,
            relativeLocation: "Sample/i18n",
            reason: "fixture",
            requiresAttention: Boolean(requiresAttention),
            restOfPackageLoaded: true,
          },
        ],
      }),
    );
    expect(search).toHaveBeenCalledTimes(shouldSearch ? 1 : 0);
  },
);
