import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { useDialogAccessibility } from "../dialogAccessibility";
import {
  nexusStatus,
  nexusResolveArchive,
  listCommunityLibrary,
  type CommunityLibraryEntry,
  nexusHandoffToVortex,
  nexusListFiles,
  nexusDownloadPreflight,
  nexusPreflightImport,
  nexusImportTranslation,
  openUrl,
  type NexusStatus,
  type NexusArchive,
  type NexusCandidate,
  type NexusFile,
  type NexusImportRequest,
  type InstalledNexusTranslation,
  type VortexInstalledFile,
  type ScannedMod,
  type SkippedComponent,
} from "../tauri/commands";
import {
  resolveArchiveTranslations,
  nexusSourceDiskCoverage,
  nexusSourceScanIncomplete,
  nexusSourceComponents,
} from "./resolveTranslation";
import { useNexusFiles } from "./useNexusFiles";
import { deriveNexusResult, nexusCandidates } from "./resultState";
import type { NexusSearchEntry, NexusSearchState } from "./useNexusSearch";

import { NexusQuotaSummary, nexusAccountKind } from "./NexusAccountSummary";

const quiet = "translator-button translator-button-quiet";
const primary = "translator-button translator-button-primary";
function metadataLine(version?: string, date?: string) {
  const parsed = date ? new Date(date) : null;
  const readableDate =
    parsed && Number.isFinite(parsed.getTime())
      ? parsed.toLocaleDateString("en-GB", {
          day: "numeric",
          month: "short",
          year: "numeric",
          timeZone: "UTC",
        })
      : "Date unavailable";
  return `${version ? `v${version.replace(/^v(?=\d)/i, "")}` : "Version unavailable"} · ${readableDate}`;
}
type MappingChoice = ReturnType<
  typeof resolveArchiveTranslations
>["choices"][number];
interface RowState {
  unresolved?: { archivePath: string; reason: string }[];
  status?: string;
  intent?: "vortex" | "review";
  handoff?: { at: number; before: ReturnType<typeof nexusSourceDiskCoverage> };
  error?: string;
  selectedArchive?: NexusFile;
  archive?: NexusArchive;
  downloadedAt?: number;
  choices?: MappingChoice[];
  selected?: Record<number, string>;
  confirmed?: Record<number, boolean>;
  downloads: number;
  imported: number;
  kept: number;
  invalid: number;
  completed?: boolean;
  notice?: string;
  modIds: string[];
  details: string[];
  failures: number;
}
const emptyRow = (): RowState => ({
  downloads: 0,
  imported: 0,
  kept: 0,
  invalid: 0,
  modIds: [],
  details: [],
  failures: 0,
});
function NexusModal({
  embedded = false,
  title,
  busy,
  onClose,
  children,
}: {
  embedded?: boolean;
  title: string;
  busy: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const { onDialogKeyDown } = useDialogAccessibility({
    dialogRef,
    onEscape: onClose,
    escapeDisabled: busy,
  });
  if (embedded)
    return (
      <section className="nexus-dialog nexus-embedded" aria-label={title}>
        {children}
      </section>
    );
  return (
    <div className="translator-flow-overlay">
      <section
        ref={dialogRef}
        className="translator-flow-dialog nexus-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={onDialogKeyDown}
      >
        <header className="nexus-dialog-header">
          <h2>{title}</h2>
          <button
            className={quiet}
            type="button"
            disabled={busy}
            onClick={onClose}
            aria-label="Close Nexus translations"
          >
            Close
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
export function NexusDialog({
  libraryMode = false,
  embedded = false,
  open = true,
  search,
  mods,
  targetLang,
  onSearch,
  onCancel,
  onClose,
  onConfigure,
  onImported,
  onOpenReview,
  onOpenMissing,
  vortexExecutable,
  installationMethod,
  onCheckInstalled,
  onDeploymentStamp,
  recheckBlocked = false,
  workspaceKey = "",
  skippedComponents = [],
  traversalComplete = false,
  nexusIdentityIncomplete = false,
  installedNexusTranslations = [],
  vortexInstalledFiles = [],
  inventoryRefreshWarning,
}: {
  libraryMode?: boolean;
  embedded?: boolean;
  open?: boolean;
  vortexExecutable?: string | null;
  installationMethod?: "folder" | "vortex";
  onCheckInstalled?: (current: () => boolean) => Promise<void>;
  onDeploymentStamp?: () => Promise<string | null>;
  recheckBlocked?: boolean;
  workspaceKey?: string;
  search: NexusSearchState;
  mods: ScannedMod[];
  skippedComponents?: SkippedComponent[];
  traversalComplete?: boolean;
  nexusIdentityIncomplete?: boolean;
  installedNexusTranslations?: InstalledNexusTranslation[];
  vortexInstalledFiles?: VortexInstalledFile[];
  inventoryRefreshWarning?: string;
  targetLang: string;
  onSearch: (options?: {
    includeComplete?: boolean;
    forceRefresh?: boolean;
    retainIds?: number[];
  }) => void;
  onCancel: () => void;
  onClose: () => void;
  onConfigure: () => void;
  onImported: () => Promise<void>;
  onOpenReview?: (modUniqueId: string) => void;
  onOpenMissing?: (modUniqueId: string) => void;
}) {
  const configuredVortex = vortexExecutable?.trim();
  const method = installationMethod ?? (configuredVortex ? "vortex" : "folder");
  const isVortex = method === "vortex" && !libraryMode;
  const [account, setAccount] = useState<NexusStatus | null>(null);
  const canDirectImport = nexusAccountKind(account) === "premium";

  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [linkErrors, setLinkErrors] = useState<Record<number, string>>({});
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [fileSelections, setFileSelections] = useState<Record<number, string>>(
    {},
  );
  const [batchRunning, setBatchRunning] = useState(false);
  const batchRef = useRef(false);
  const stopBatchRef = useRef(false);
  const [active, setActive] = useState<string | null>(null);
  const activeRef = useRef<string | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  const context = `${workspaceKey}|${targetLang}|${method}`;
  const live = useRef({ open, context, onCheckInstalled, onDeploymentStamp });
  live.current = { open, context, onCheckInstalled, onDeploymentStamp };
  const actionContext = useRef(context);
  const [recheckPending, setRecheckPending] = useState<string | null>(null);
  const [presentationContext, setPresentationContext] = useState<string | null>(
    null,
  );
  const deployment = useRef<{
    context: string;
    baseline?: string | null;
    failed?: string;
  }>({ context });
  const probeDeployment = useRef<() => void>(() => {});
  const checkInFlight = useRef(false);
  const [monitor, setMonitor] = useState<{
    until: number;
  } | null>(null);
  useEffect(() => {
    const next = context;
    if (actionContext.current !== next) {
      actionContext.current = next;
      generation.current++;
      setFileSelections({});
      setRows({});
      setCheckedAt(null);
      setCheckError(null);
      setRecheckPending(null);
      setPresentationContext(null);
      setMonitor(null);
      deployment.current = { context };
    }
  }, [context]);
  useEffect(() => {
    if (!open) {
      generation.current++;
      stopBatchRef.current = true;
      setMonitor(null);
      setPresentationContext(null);
    }
  }, [open, isVortex]);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const expires = Object.values(rows)
      .filter(
        (row) =>
          row.choices?.length &&
          row.downloadedAt &&
          row.downloadedAt + 15 * 60_000 > Date.now(),
      )
      .map((row) => row.downloadedAt! + 15 * 60_000);
    if (!expires.length) return;
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.max(0, Math.min(...expires) - Date.now() + 50),
    );
    return () => window.clearTimeout(timer);
  }, [open, rows]);
  function patch(
    key: string,
    change: Partial<RowState> | ((row: RowState) => RowState),
  ) {
    setRows((previous) => ({
      ...previous,
      [key]:
        typeof change === "function"
          ? change(previous[key] ?? emptyRow())
          : { ...(previous[key] ?? emptyRow()), ...change },
    }));
  }
  async function run(
    key: string,
    work: (current: () => boolean) => Promise<void>,
  ) {
    if (activeRef.current) return;
    activeRef.current = key;
    setActive(key);
    patch(key, { error: undefined });
    const stamp = generation.current;
    const current = () =>
      mounted.current &&
      live.current.open &&
      live.current.context === context &&
      stamp === generation.current;
    try {
      await work(current);
    } catch (cause) {
      if (current()) patch(key, { error: String(cause) });
    } finally {
      if (current()) {
        patch(key, { status: undefined });
      }
      if (mounted.current) setActive(null);
      activeRef.current = null;
    }
  }
  async function importMappings(
    key: string,
    mappings: NexusImportRequest[],
    current: () => boolean,
  ) {
    let saved = 0;
    for (const mapping of mappings) {
      if (!current()) return;
      const name =
        mods.find((mod) => mod.uniqueId === mapping.modUniqueId)?.name ??
        mapping.modUniqueId;
      patch(key, { status: `Checking ${mapping.archivePath}…` });
      try {
        const request = libraryMode
          ? { ...mapping, communityLibrary: true }
          : mapping;
        const preview = await nexusPreflightImport(request);
        if (!current()) return;
        const result =
          preview.importable > 0 || libraryMode
            ? await nexusImportTranslation(request)
            : { ...preview, imported: 0 };
        if (!current()) return;
        saved += result.imported;
        patch(key, (row) => ({
          ...row,
          imported: row.imported + result.imported,
          kept: row.kept + result.conflicts,
          invalid: row.invalid + result.tokenInvalid,
          modIds:
            result.imported > 0
              ? [...new Set([...row.modIds, mapping.modUniqueId])]
              : row.modIds,
          details: [
            ...row.details,
            `${name} / ${mapping.relativeDir.replace("/@split/", "/")}: ${result.imported} imported, ${result.conflicts} kept, ${result.tokenInvalid} token errors (${mapping.archivePath}). ${result.matched} matching, ${result.missing} missing, ${result.extra} extra, ${result.empty} empty, ${result.sourceEqual} source-identical.`,
          ],
        }));
      } catch (cause) {
        if (!current()) return;
        patch(key, (row) => ({
          ...row,
          failures: row.failures + 1,
          details: [
            ...row.details,
            `${name} / ${mapping.relativeDir.replace("/@split/", "/")}: ${String(cause)}`,
          ],
          error:
            "Some text could not be imported. Completed imports were kept; see details.",
        }));
      }
    }
    if ((saved > 0 || libraryMode) && current()) {
      try {
        await onImported();
      } catch {
        if (current())
          patch(key, {
            error:
              "Import saved, but workspace refresh failed. Rescan to review it.",
          });
      }
    }
  }
  async function downloadAndImport(
    key: string,
    sourceId: number,
    candidate: NexusCandidate,
    file: NexusFile,
    current: () => boolean,
  ) {
    patch(key, {
      status: `Downloading ${file.fileName}…`,
      choices: undefined,
      completed: false,
      imported: 0,
      kept: 0,
      invalid: 0,
      failures: 0,
      details: [],
      unresolved: undefined,
      notice: undefined,
    });
    const archive = await nexusDownloadPreflight(candidate.modId, file.fileId);
    if (!current()) return;
    const nativeResolution =
      libraryMode || archive.files.some((file) => !file.isDefault)
        ? await nexusResolveArchive(
            archive.archiveId,
            nexusSourceComponents(
              mods,
              sourceId,
              knownComponents(sourceId),
            ).map((component) => component.uniqueId),
          )
        : null;
    if (!current()) return;
    const resolved = nativeResolution
      ? {
          mappings: nativeResolution.mappings,
          choices: [],
          rejected: nativeResolution.unresolved.length,
          reason: "",
        }
      : resolveArchiveTranslations(archive, sourceId, mods, targetLang);
    patch(key, (row) => ({
      ...row,
      archive,
      downloadedAt: Date.now(),
      selectedArchive: file,
      downloads: row.downloads + 1,
      choices: resolved.choices,
      unresolved: nativeResolution?.unresolved,
      modIds: [
        ...new Set([
          ...row.modIds,
          ...resolved.mappings.map((mapping) => mapping.modUniqueId),
        ]),
      ],
      selected: {},
      confirmed: {},
      notice: resolved.reason,
      details: [
        ...row.details,
        `Downloaded ${file.fileName}; ${archive.files.length} JSON files inspected. ${resolved.rejected} unmatched entries.`,
      ],
    }));
    await importMappings(key, resolved.mappings, current);
    if (current()) patch(key, { completed: true });
  }

  async function startReview(
    key: string,
    sourceId: number,
    candidate: NexusCandidate,
    file: NexusFile,
  ) {
    await run(key, async (current) => {
      if (!/\.(zip|rar|7z)$/i.test(file.fileName))
        throw new Error(
          "Translation import supports ZIP, RAR and 7z archives; the selected file was not replaced.",
        );
      patch(key, { intent: "review", status: "Checking download access…" });
      const status = await nexusStatus();
      if (!current()) return;
      if (!status?.validated || !status.premium)
        throw new Error(
          "Direct import requires Nexus Premium. Open Nexus files for a manual download.",
        );
      await downloadAndImport(key, sourceId, candidate, file, current);
    });
  }
  async function requestHandoff(
    key: string,
    origins: { key: string; sourceId: number }[],
    candidate: NexusCandidate,
    file: NexusFile,
  ) {
    await run(key, async (current) => {
      try {
        if (!configuredVortex)
          throw new Error("Choose Vortex.exe in installation settings first.");
        patch(key, {
          intent: "vortex",
          status: "Sending to Vortex…",
          choices: undefined,
        });
        // Capture before launch: deployment can finish before the receipt returns.
        const baseline =
          (await live.current.onDeploymentStamp?.().catch(() => null)) ?? null;
        if (!current()) return;
        if (
          deployment.current.context === context &&
          deployment.current.baseline === undefined
        )
          deployment.current.baseline = baseline;
        const previous = Object.entries(rows).find(
          ([rowKey, row]) =>
            row.handoff &&
            rowKey.endsWith(`:${candidate.modId}:${file.fileId}`),
        )?.[1].handoff;
        if (!previous) {
          const receipt = await nexusHandoffToVortex(
            candidate.modId,
            file.fileId,
          );
          if (!current()) return;
          if (receipt.status !== "handoff-requested")
            throw new Error(
              "Vortex handoff was not confirmed by the launcher.",
            );
        }
        for (const origin of origins)
          patch(origin.key, {
            intent: "vortex",
            error: undefined,
            handoff: rows[origin.key]?.handoff ?? {
              at: previous?.at ?? Date.now(),
              before: nexusSourceDiskCoverage(
                mods,
                origin.sourceId,
                skippedComponents,
                traversalComplete,
                nexusIdentityIncomplete,
              ),
            },
            selectedArchive: file,
            completed: false,
          });
        setMonitor({
          until: Date.now() + 120_000,
        });
      } catch (cause) {
        if (current())
          for (const origin of origins)
            patch(origin.key, { error: String(cause), status: undefined });
        throw cause;
      }
    });
  }
  const handedOffIds = [
    ...new Set(
      Object.entries(rows)
        .filter(([, row]) => row.handoff)
        .map(([key]) => Number(key.split(":")[0])),
    ),
  ];
  // Focus/reopen only observes a cheap hint. A changed, settled hint permits a scan.
  useEffect(() => {
    if (!open || !isVortex || !live.current.onDeploymentStamp) return;
    let cancelled = false,
      reading = false;
    let timer: number | undefined,
      pollTimer: number | undefined,
      readTimer: number | undefined;
    let candidate: string | undefined,
      candidateAt = 0,
      settleUntil = 0;
    const schedule = (delay: number) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(probe, delay);
    };
    const probe = async () => {
      if (cancelled || reading) return;
      reading = true;
      // An unavailable hint must not indefinitely hide the last scan's results.
      readTimer = window.setTimeout(() => {
        if (!cancelled) setPresentationContext(context);
      }, 5000);
      try {
        const next = await live.current.onDeploymentStamp!();
        if (cancelled || live.current.context !== context || !live.current.open)
          return;
        const known = deployment.current;
        if (known.baseline == null) {
          if (next != null) known.baseline = next;
          setPresentationContext(context);
          return;
        }
        // Missing/locked deployment metadata cannot establish that installation settled.
        if (next == null || next === known.baseline) {
          candidate = undefined;
          if (!checkInFlight.current) setRecheckPending(null);
          setPresentationContext(context);
          return;
        }
        if (known.failed === next || !live.current.onCheckInstalled) {
          candidate = undefined;
          if (!checkInFlight.current) setRecheckPending(null);
          setPresentationContext(context);
          return;
        }
        if (candidate === next && Date.now() - candidateAt >= 1500) {
          setPresentationContext(null);
          setRecheckPending(next);
        } else {
          if (!candidate) settleUntil = Date.now() + 10_000;
          candidate = next;
          candidateAt = Date.now();
          if (!checkInFlight.current) setRecheckPending(null);
          if (Date.now() < settleUntil) {
            setPresentationContext(null);
            schedule(1500);
          } else setPresentationContext(context);
        }
      } catch {
        candidate = undefined;
        if (!cancelled) {
          if (!checkInFlight.current) setRecheckPending(null);
          setPresentationContext(context);
        }
      } finally {
        window.clearTimeout(readTimer);
        reading = false;
      }
    };
    const request = () => {
      schedule(250);
    };
    probeDeployment.current = request;
    const focus = (event: FocusEvent) => {
      if (!(event.target instanceof Node)) request();
    };
    const visible = () => {
      if (document.visibilityState === "visible") request();
    };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", visible);
    void probe();
    const poll = () => {
      if (cancelled || !monitor || Date.now() >= monitor.until) return;
      void probe();
      pollTimer = window.setTimeout(poll, 3000);
    };
    if (monitor) pollTimer = window.setTimeout(poll, 3000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.clearTimeout(pollTimer);
      window.clearTimeout(readTimer);
      probeDeployment.current = () => {};
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [open, isVortex, context, monitor]);
  useEffect(() => {
    if (
      !recheckPending ||
      !open ||
      !isVortex ||
      recheckBlocked ||
      active ||
      batchRunning ||
      search.running ||
      checking ||
      !live.current.onCheckInstalled
    )
      return;
    const timer = window.setTimeout(() => {
      if (checkInFlight.current) return;
      const stamp = generation.current;
      const current = () =>
        mounted.current &&
        live.current.open &&
        live.current.context === context &&
        stamp === generation.current;
      checkInFlight.current = true;
      setChecking(true);
      setCheckError(null);
      void (async () => {
        // Busy UI may have deferred this check while Vortex continued deployment.
        let hintTimer: number | undefined;
        const latest = await Promise.race([
          live.current.onDeploymentStamp?.(),
          new Promise<never>((_, reject) => {
            hintTimer = window.setTimeout(
              () =>
                reject(
                  new Error(
                    "Deployment information is unavailable. Use Scan to check installed translations.",
                  ),
                ),
              5000,
            );
          }),
        ]).finally(() => window.clearTimeout(hintTimer));
        if (!current()) return;
        if (latest !== recheckPending) {
          setRecheckPending(null);
          probeDeployment.current();
          return;
        }
        await live.current.onCheckInstalled!(current);
        if (current()) {
          deployment.current.baseline = recheckPending;
          deployment.current.failed = undefined;
          setRecheckPending(null);
          setCheckedAt(Date.now());
          setPresentationContext(context);
        }
      })()
        .catch((cause) => {
          if (current()) {
            deployment.current.failed = recheckPending;
            setRecheckPending(null);
            setCheckError(String(cause));
            setPresentationContext(context);
          }
        })
        .finally(() => {
          checkInFlight.current = false;
          if (mounted.current) setChecking(false);
        });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [
    recheckPending,
    open,
    isVortex,
    context,
    recheckBlocked,
    active,
    batchRunning,
    search.running,
    checking,
  ]);
  function selectedMapping(
    row: RowState,
    choice: MappingChoice,
    index: number,
  ) {
    const value =
      row.selected?.[index] ?? (choice.options.length === 1 ? "0" : "");
    return {
      value,
      mapping:
        value !== "" && value !== "skip"
          ? choice.options[Number(value)]
          : undefined,
    };
  }
  const resolvingInstalled =
    isVortex &&
    Boolean(onDeploymentStamp) &&
    (presentationContext !== context || recheckPending !== null || checking);
  const locked =
    Boolean(active) ||
    batchRunning ||
    checking ||
    recheckBlocked ||
    resolvingInstalled;
  const scanIncomplete =
    !traversalComplete ||
    nexusIdentityIncomplete ||
    skippedComponents.some((item) => item.requiresAttention);
  const fileMetadata = useNexusFiles(
    search.entries.flatMap((entry) =>
      nexusCandidates(entry).map((candidate) => candidate.modId),
    ),
    open,
    `${targetLang}|${method}`,
  );
  // Only reads the native session snapshot; never validates or sends HTTP here.
  useEffect(() => {
    if (!open) return;
    let current = true;
    void nexusStatus()
      .then((value) => {
        if (current) setAccount(value);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [
    open,
    search.completed,
    search.running,
    fileMetadata.entries,
    batchRunning,
  ]);
  const [importedState, setImportedState] = useState<{
    context: string;
    entries: CommunityLibraryEntry[];
    verified: boolean;
    error?: string;
  }>({ context: "", entries: [], verified: false });
  const importedContext = `${workspaceKey}|${targetLang}`;
  const importedSources =
    importedState.context === importedContext ? importedState.entries : [];
  const importStatusUnknown =
    libraryMode &&
    (importedState.context !== importedContext || !importedState.verified);
  useEffect(() => {
    if (!open || !libraryMode) return;
    let current = true;
    void listCommunityLibrary()
      .then((entries) => {
        if (!Array.isArray(entries))
          throw new Error("Invalid saved import status");
        if (current)
          setImportedState({
            context: importedContext,
            entries,
            verified: true,
          });
      })
      .catch(() => {
        if (current)
          setImportedState((previous) => ({
            context: importedContext,
            entries:
              previous.context === importedContext ? previous.entries : [],
            verified: previous.context === importedContext && previous.verified,
            error:
              "Saved import status is unavailable. Reopen Nexus results to retry.",
          }));
      });
    return () => {
      current = false;
    };
  }, [open, libraryMode, importedContext, mods]);
  function sourceUrls(saved: CommunityLibraryEntry) {
    return [
      saved.sourceUrl,
      ...(saved.sources ?? []).map((source) => source.sourceUrl),
    ];
  }
  function knownComponents(sourceId: number) {
    const candidates = (
      search.entries.find((entry) => entry.modId === sourceId)?.result
        ?.candidates ?? []
    ).filter(
      (candidate) =>
        candidate.relationshipTier === "possible-original-translation",
    );
    return [
      ...new Set([
        ...importedSources
          .filter((saved) =>
            candidates.some((candidate) =>
              sourceUrls(saved).some((url) =>
                url?.startsWith(
                  `https://www.nexusmods.com/stardewvalley/mods/${candidate.modId}?tab=files&file_id=`,
                ),
              ),
            ),
          )
          .map((saved) => saved.modUniqueId),
        ...Object.entries(rows)
          .filter(([key]) =>
            candidates.some((candidate) =>
              key.startsWith(`${sourceId}:${candidate.modId}:`),
            ),
          )
          .flatMap(([, row]) => row.modIds),
      ]),
    ];
  }
  const results = search.entries.map((entry) =>
    deriveNexusResult({
      entry,
      mods,
      knownComponentIds: knownComponents(entry.modId),
      skippedComponents,
      traversalComplete,
      nexusIdentityIncomplete,
      isVortex,
      installedNexusTranslations,
      vortexInstalledFiles,
      fileMetadata: fileMetadata.entries,
      targetLang,
      allowArchives: isVortex || !canDirectImport,
      explicitSelection: fileSelections[entry.modId],
    }),
  );
  const coveredIds = new Set(
    results
      .filter((result) => result.covered)
      .map((result) => result.entry.modId),
  );
  const groups = results
    .filter(
      (result) =>
        !result.covered && (result.candidates.length || result.evidence.length),
    )
    .map((result) => {
      const { entry, selected, sourceUnknown } = result;
      const archiveSource = selected
        ? `https://www.nexusmods.com/stardewvalley/mods/${selected.candidate.modId}?tab=files&file_id=${selected.file.fileId}`
        : null;
      const recordedComponents = importedSources
        .filter(
          (saved) => archiveSource && sourceUrls(saved).includes(archiveSource),
        )
        .map((saved) => saved.modUniqueId);
      const packageComponents = nexusSourceComponents(
        mods,
        entry.modId,
        knownComponents(entry.modId),
      );
      const components = recordedComponents.length
        ? mods.filter((mod) => recordedComponents.includes(mod.uniqueId))
        : packageComponents;
      const acquired =
        libraryMode && Boolean(selected) && recordedComponents.length > 0;
      const key = selected
        ? `${entry.modId}:${selected.value}`
        : `${entry.modId}:pending`;
      const row = rows[key] ??
        (sourceUnknown && !selected
          ? Object.entries(rows).find(
              ([rowKey, value]) =>
                rowKey.startsWith(`${entry.modId}:`) && value.handoff,
            )?.[1]
          : undefined) ?? {
          ...emptyRow(),
          completed: acquired,
          modIds: acquired
            ? components.map((component) => component.uniqueId)
            : [],
        };
      return {
        ...result,
        key,
        row: acquired ? { ...row, completed: true } : row,
        acquired,
        importedComponents: packageComponents
          .filter((component) =>
            recordedComponents.includes(component.uniqueId),
          )
          .map((component) => component.uniqueId),
        retryNewUnits:
          acquired &&
          packageComponents.some(
            (component) =>
              recordedComponents.includes(component.uniqueId) &&
              component.i18nFiles.some(
                (directory) =>
                  !importedSources.some(
                    (saved) =>
                      saved.modUniqueId === component.uniqueId &&
                      saved.relativeDir === directory.relativeDir &&
                      sourceUrls(saved).includes(archiveSource),
                  ),
              ),
          ),
      };
    });
  const shown = groups.filter(
    (group) =>
      group.options.length > 0 ||
      group.evidence.length > 0 ||
      group.inventory.length > 0,
  );
  const failedIds = new Set([
    ...search.entries
      .filter((entry) => entry.error)
      .map((entry) => entry.modId),
    ...groups
      .filter((group) => group.errors.length)
      .map((group) => group.entry.modId),
  ]);
  const unavailableCount = failedIds.size;
  const noDownloadIds = new Set(
    [
      ...search.entries
        .filter(
          (entry) =>
            entry.result && !entry.error && !entry.result.candidates.length,
        )
        .map((entry) => entry.modId),
      ...groups
        .filter(
          (group) =>
            !group.loading &&
            !group.options.length &&
            !group.errors.length &&
            !group.evidence.length &&
            !group.inventory.length,
        )
        .map((group) => group.entry.modId),
    ].filter(
      (id) =>
        !failedIds.has(id) &&
        !coveredIds.has(id) &&
        !results.find((result) => result.entry.modId === id)?.evidence.length,
    ),
  );
  const actionRows = Object.values(rows);
  const installedResults = shown.filter(
    (group) =>
      !group.selected &&
      !group.problem &&
      !group.row.error &&
      !group.row.choices?.length &&
      !group.row.handoff &&
      (group.evidence.length > 0 || group.inventory.length > 0),
  );
  const installedGroups = installedResults.length;
  const acquisitionResults = shown.filter(
    (group) => !installedResults.includes(group),
  );
  const handoffCount = new Set(
    Object.entries(rows)
      .filter(([, row]) => row.handoff)
      .map(([key]) => key.split(":").slice(1).join(":")),
  ).size;
  const actionStatus = active ? rows[active]?.status : undefined;
  const allHandoffsRechecked =
    checkedAt != null &&
    actionRows.every((row) => !row.handoff || checkedAt >= row.handoff.at);
  const resultStatus = [
    handoffCount
      ? `${handoffCount} sent to Vortex${allHandoffsRechecked ? " · files rechecked" : ""}`
      : "",
    actionRows.some((row) => row.completed || row.imported > 0)
      ? `${actionRows.reduce((sum, row) => sum + row.imported, 0)} imported as Done`
      : "",
    actionRows.some((row) => row.choices?.length)
      ? "Confirm matching text"
      : "",
    actionRows.some((row) => row.error) ? "Action failed" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const loading = groups.some((group) => group.loading);
  const unresolvedCount = shown.filter(
    (group) =>
      !group.selected && !group.evidence.length && !group.inventory.length,
  ).length;
  const skippedComplete = scanIncomplete ? 0 : (search.skippedComplete ?? 0);
  const pending = shown.filter(
    (group) =>
      !importStatusUnknown &&
      group.selected &&
      !group.row.handoff &&
      !group.row.completed &&
      !group.row.choices?.length &&
      !group.row.error,
  );
  const pendingDownloads = isVortex
    ? new Set(pending.map((group) => group.selected!.value)).size
    : pending.length;
  async function downloadAll(queue = pending) {
    if (importStatusUnknown) return;
    if (
      activeRef.current ||
      batchRef.current ||
      (!isVortex && !canDirectImport)
    )
      return;
    const snapshot = queue.flatMap((group) =>
      group.selected && !group.acquired
        ? [
            {
              key: group.key,
              sourceId: group.entry.modId,
              candidate: { ...group.selected.candidate },
              file: { ...group.selected.file },
            },
          ]
        : [],
    );
    const stamp = generation.current;
    batchRef.current = true;
    stopBatchRef.current = false;
    setBatchRunning(true);
    try {
      const sent = new Set<string>();
      for (const item of snapshot) {
        if (stamp !== generation.current || stopBatchRef.current) break;
        if (isVortex) {
          const target = `${item.candidate.modId}:${item.file.fileId}`;
          if (sent.has(target)) continue;
          sent.add(target);
          const origins = groups
            .filter((group) => group.selected?.value === target)
            .map((group) => ({ key: group.key, sourceId: group.entry.modId }));
          await requestHandoff(item.key, origins, item.candidate, item.file);
        } else {
          await startReview(item.key, item.sourceId, item.candidate, item.file);
        }
      }
    } finally {
      batchRef.current = false;
      if (mounted.current) setBatchRunning(false);
    }
  }
  function renderRow(group: (typeof groups)[number]) {
    const { entry, selected, key, row } = group;
    const sourceId = entry.modId;
    const recorded = group.recordedOptions[0];
    const soleOption =
      group.options.length === 1 ? group.options[0] : undefined;
    const candidate =
      selected?.candidate ??
      soleOption?.candidate ??
      recorded?.candidate ??
      (group.evidence.length
        ? group.candidates.find((item) =>
            group.evidence.some((record) => record.modId === item.modId),
          )
        : group.candidates[0]);
    const linkModId =
      candidate?.modId ?? group.evidence[0]?.modId ?? group.inventory[0]?.modId;
    const sourceName =
      entry.result?.originalName ?? entry.localNames.join(", ");
    const file = selected?.file;
    const displayFile = file ?? soleOption?.file ?? recorded?.file;
    const unidentifiedEvidence = group.evidence.filter(
      (item) =>
        !group.recordedOptions.some(
          (option) =>
            option.candidate.modId === item.modId &&
            option.file.fileId === item.fileId,
        ),
    );
    const expired = Boolean(
      row.downloadedAt && now - row.downloadedAt >= 15 * 60_000,
    );
    const disk = nexusSourceDiskCoverage(
      mods,
      sourceId,
      skippedComponents,
      traversalComplete,
      nexusIdentityIncomplete,
      knownComponents(sourceId),
    );
    const baseline = row.handoff?.before;
    const rechecked = Boolean(
      row.handoff && checkedAt && checkedAt >= row.handoff.at,
    );
    const version = mods.find((mod) => mod.nexusId === sourceId)?.version;
    const displayedComponents = nexusSourceComponents(
      mods,
      sourceId,
      knownComponents(sourceId),
    );
    const workingTotal = displayedComponents.reduce(
      (sum, component) => sum + component.totalKeys,
      0,
    );
    const workingKnown =
      displayedComponents.length > 0 &&
      displayedComponents.every(
        (component) =>
          Number.isFinite(component.totalKeys) &&
          Number.isFinite(component.translatedKeys),
      );
    const displayedScanIncomplete = displayedComponents.some((component) =>
      nexusSourceScanIncomplete(
        mods,
        component.nexusId && component.nexusId > 0
          ? component.nexusId
          : sourceId,
        skippedComponents,
        traversalComplete,
        nexusIdentityIncomplete,
        knownComponents(sourceId),
      ),
    );
    const workingCovered = displayedComponents.reduce(
      (sum, component) =>
        sum +
        component.translatedKeys +
        (component.noTranslationNeededKeys ?? 0),
      0,
    );
    const missingComponents = displayedComponents.filter(
      (mod) =>
        (mod.statusCounts?.untranslated ??
          Math.max(
            0,
            mod.totalKeys -
              mod.translatedKeys -
              (mod.noTranslationNeededKeys ?? 0),
          )) > 0,
    );
    return (
      <Fragment key={sourceId}>
        <tr aria-label={sourceName}>
          <td>
            <strong>{sourceName}</strong>
            {version && !group.sourceUnknown && (
              <small>Installed v{version.replace(/^v(?=\d)/i, "")}</small>
            )}
            {group.evidence.length > 0 && (
              <small
                className={
                  group.problem ? "nexus-installation-problem" : undefined
                }
              >
                {group.problem
                  ? "Translation file missing from Vortex installation"
                  : "Translation installed"}
              </small>
            )}
            {!group.evidence.length && group.inventory.length > 0 && (
              <small>Installed in Vortex</small>
            )}
            {row.handoff && (
              <small className="nexus-handoff-status">
                Sent to Vortex · installation and deployment unconfirmed
              </small>
            )}
            {group.acquired && (
              <small>
                Already imported ·{" "}
                {displayedScanIncomplete || !workingKnown ? (
                  "package coverage unavailable"
                ) : (
                  <>
                    {missingComponents.reduce(
                      (sum, component) =>
                        sum +
                        (component.statusCounts?.untranslated ??
                          Math.max(
                            0,
                            component.totalKeys -
                              component.translatedKeys -
                              (component.noTranslationNeededKeys ?? 0),
                          )),
                      0,
                    )}{" "}
                    strings still missing across installed components
                  </>
                )}
              </small>
            )}
            {!group.evidence.length && group.inventory.length > 0 && (
              <small>
                Deployment not verified. Check Vortex, then recheck installed
                files.
              </small>
            )}
            {displayedComponents.length > 0 && (
              <small>
                Components:{" "}
                {displayedComponents
                  .map((component) => {
                    if (
                      !group.acquired ||
                      displayedScanIncomplete ||
                      !workingKnown
                    )
                      return component.name;
                    const missing =
                      component.statusCounts?.untranslated ??
                      Math.max(
                        0,
                        component.totalKeys -
                          component.translatedKeys -
                          (component.noTranslationNeededKeys ?? 0),
                      );
                    return `${component.name} (${missing ? `${missing} missing` : "complete"})`;
                  })
                  .join(", ")}
              </small>
            )}
            <small>
              {libraryMode || row.modIds.length > 0
                ? !displayedScanIncomplete && workingKnown
                  ? `Working translation: ${workingCovered}/${workingTotal} strings · ${Math.max(0, workingTotal - workingCovered)} missing`
                  : "Working translation coverage unavailable: scan incomplete."
                : disk
                  ? `Local translation: ${disk.covered}/${disk.total} strings${disk.noTextNeeded ? ` · ${disk.noTextNeeded} need no translation text` : ""} · ${disk.missing} missing`
                  : group.sourceUnknown
                    ? "Local translation coverage unavailable: scan incomplete."
                    : "Local translation coverage unavailable"}
            </small>
            {row.unresolved && row.unresolved.length > 0 && (
              <small>
                Could not match {row.unresolved.length} translation{" "}
                {row.unresolved.length === 1 ? "file" : "files"}. See Details;
                no uncertain component was chosen.
              </small>
            )}
            {group.problem && (
              <small>
                The archive contains a translation file for this language, but
                it is missing from this installation.
              </small>
            )}
            {!group.problem &&
              (group.acquired ||
                row.modIds.length > 0 ||
                group.evidence.length > 0 ||
                group.inventory.length > 0) &&
              missingComponents.length > 0 &&
              onOpenMissing &&
              missingComponents.map((component) => (
                <button
                  key={component.uniqueId}
                  className={quiet}
                  disabled={locked}
                  onClick={() => onOpenMissing(component.uniqueId)}
                >
                  Open missing strings
                  {missingComponents.length > 1 ? ` · ${component.name}` : ""}
                </button>
              ))}
          </td>
          <td>
            <div className="nexus-file-link">
              <div className="nexus-file-selection">
                {group.options.length > 1 ||
                (group.options.length > 0 &&
                  (group.evidence.length > 0 ||
                    group.inventory.length > 0 ||
                    group.sourceUnknown)) ? (
                  <select
                    aria-label={`Translation file for ${sourceName}`}
                    title={
                      selected
                        ? `${selected.candidate.name} · ${selected.file.fileName}`
                        : "Choose a translation version"
                    }
                    disabled={locked}
                    value={group.value}
                    onChange={(event) =>
                      setFileSelections((previous) => ({
                        ...previous,
                        [sourceId]: event.target.value,
                      }))
                    }
                  >
                    <option value="">No new download</option>
                    {group.candidates.map((item) => (
                      <optgroup
                        key={item.modId}
                        label={
                          item.relationshipTier ===
                          "possible-original-translation"
                            ? item.name
                            : `Other match: ${item.name}`
                        }
                      >
                        {!group.options.some(
                          (option) => option.candidate.modId === item.modId,
                        ) && (
                          <option disabled value={`unavailable:${item.modId}`}>
                            {group.unavailableCandidates.find(
                              (value) => value.candidate.modId === item.modId,
                            )?.reason ?? "This file is already installed."}
                          </option>
                        )}
                        {group.options
                          .filter(
                            (option) => option.candidate.modId === item.modId,
                          )
                          .map((option) => (
                            <option key={option.value} value={option.value}>
                              {item.name} ·{" "}
                              {metadataLine(
                                option.file.version,
                                option.file.uploadedAt,
                              )}
                              {group.options.some(
                                (other) =>
                                  other.value !== option.value &&
                                  other.candidate.modId ===
                                    option.candidate.modId &&
                                  metadataLine(
                                    other.file.version,
                                    other.file.uploadedAt,
                                  ) ===
                                    metadataLine(
                                      option.file.version,
                                      option.file.uploadedAt,
                                    ),
                              )
                                ? ` · ${option.file.name}`
                                : ""}
                            </option>
                          ))}
                      </optgroup>
                    ))}
                  </select>
                ) : (
                  <>
                    <strong className="nexus-selected-title">
                      {candidate?.name ?? "Installed translation"}
                    </strong>
                    <small>
                      {displayFile &&
                        metadataLine(
                          displayFile.version,
                          displayFile.uploadedAt,
                        )}
                    </small>
                  </>
                )}
                {group.options.length > 0 &&
                  candidate?.relationshipTier !==
                    "possible-original-translation" && (
                    <small>
                      This may translate a related mod rather than the installed
                      original.
                    </small>
                  )}
              </div>
              <button
                className={quiet}
                disabled={locked || !linkModId}
                onClick={() => {
                  setLinkErrors((previous) => ({
                    ...previous,
                    [sourceId]: "",
                  }));
                  void openUrl(
                    `https://www.nexusmods.com/stardewvalley/mods/${linkModId}?tab=files`,
                  ).catch((error: unknown) => {
                    if (mounted.current)
                      setLinkErrors((previous) => ({
                        ...previous,
                        [sourceId]: String(error),
                      }));
                  });
                }}
              >
                Open Nexus Link
              </button>
            </div>
            {linkErrors[sourceId] && (
              <p role="alert">
                Could not open Nexus Link: {linkErrors[sourceId]}
              </p>
            )}
            {row.error && (
              <>
                <p role="alert">{row.error}</p>
                {selected && (
                  <button
                    className={quiet}
                    disabled={locked}
                    onClick={() => void downloadAll([group])}
                  >
                    Retry
                  </button>
                )}
              </>
            )}
            {libraryMode &&
              selected &&
              (group.retryNewUnits || (row.unresolved?.length ?? 0) > 0) && (
                <button
                  className={quiet}
                  disabled={locked || importStatusUnknown || !canDirectImport}
                  onClick={() =>
                    void startReview(
                      key,
                      sourceId,
                      selected.candidate,
                      selected.file,
                    )
                  }
                >
                  Recheck import
                </button>
              )}
            {(displayFile ||
              group.unavailableCandidates.length > 0 ||
              unidentifiedEvidence.length > 0 ||
              group.inventory.length > 0 ||
              row.handoff ||
              row.completed ||
              row.imported > 0 ||
              row.choices?.length ||
              row.notice ||
              row.details.length > 0) && (
              <details>
                <summary>Details</summary>
                {!selected && unidentifiedEvidence.length > 0 && (
                  <small>
                    {unidentifiedEvidence
                      .map(
                        (item) => `Nexus ${item.modId} · file ${item.fileId}`,
                      )
                      .join("; ")}
                  </small>
                )}

                {!group.evidence.length &&
                  group.inventory.length > 0 &&
                  !disk?.complete && (
                    <p>
                      Check deployment in Vortex to verify local translation
                      files.
                    </p>
                  )}
                {displayFile && <p>{displayFile.fileName}</p>}
                {row.handoff && (
                  <p>
                    Vortex launch was requested. Download, installation and
                    deployment are not confirmed by this app.
                  </p>
                )}
                {rechecked && disk && baseline && (
                  <small>
                    {`${disk.covered - baseline.covered >= 0 ? "+" : ""}${disk.covered - baseline.covered} strings on disk since handoff`}
                  </small>
                )}
                {disk && disk.differences > 0 && (
                  <small>
                    {disk.differences} saved values differ from disk; drafts
                    kept.
                  </small>
                )}
                {(row.completed || row.imported > 0) && (
                  <p>
                    {row.imported > 0
                      ? `${row.imported} imported as Done in this attempt`
                      : "No new strings added"}{" "}
                    · {row.kept} existing values kept · {row.invalid} token
                    errors
                    {row.failures ? ` · ${row.failures} failed` : ""}
                  </p>
                )}
                {candidate?.summary && <p>{candidate.summary}</p>}
                {row.notice && <p>{row.notice}</p>}
                {group.unavailableCandidates.map(
                  ({ candidate: unavailable, reason }) => (
                    <p key={unavailable.modId}>
                      {unavailable.name}: {reason}{" "}
                      <button
                        className={quiet}
                        onClick={() =>
                          void openUrl(
                            `https://www.nexusmods.com/stardewvalley/mods/${unavailable.modId}?tab=files`,
                          ).catch((error) =>
                            setLinkErrors((previous) => ({
                              ...previous,
                              [sourceId]: String(error),
                            })),
                          )
                        }
                      >
                        Open Nexus files
                      </button>
                    </p>
                  ),
                )}
                {row.unresolved?.map((item) => (
                  <p key={item.archivePath}>
                    {item.archivePath}: {item.reason}
                  </p>
                ))}
                {row.details.map((detail, index) => (
                  <p key={index}>{detail}</p>
                ))}
                {row.modIds.map(
                  (id) =>
                    onOpenReview && (
                      <button
                        className={quiet}
                        key={id}
                        disabled={locked}
                        onClick={() => onOpenReview(id)}
                      >
                        Open imported strings
                        {row.modIds.length > 1
                          ? ` · ${mods.find((mod) => mod.uniqueId === id)?.name ?? id}`
                          : ""}
                      </button>
                    ),
                )}
              </details>
            )}
          </td>
        </tr>
        {Boolean(row.choices?.length) && (
          <tr>
            <td colSpan={2}>
              {Boolean(row.choices?.length) && (
                <div className="nexus-inline-choice">
                  {expired ? (
                    <>
                      <p role="alert">
                        The temporary archive expired. Download again to import
                        it.
                      </p>
                      {file && (
                        <button
                          className={quiet}
                          disabled={locked}
                          onClick={() =>
                            void startReview(key, sourceId, candidate, file)
                          }
                        >
                          Download again
                        </button>
                      )}
                    </>
                  ) : (
                    <>
                      {row.choices!.map((choice, index) => {
                        const selected = selectedMapping(row, choice, index);
                        return (
                          <div key={index}>
                            {choice.options.length > 1 ? (
                              <label>
                                {choice.reason}
                                <select
                                  aria-label={`Translation choice ${index + 1} for ${candidate.name}`}
                                  disabled={locked}
                                  value={selected.value}
                                  onChange={(event) =>
                                    patch(key, {
                                      selected: {
                                        ...row.selected,
                                        [index]: event.target.value,
                                      },
                                      confirmed: {
                                        ...row.confirmed,
                                        [index]: false,
                                      },
                                    })
                                  }
                                >
                                  <option value="">
                                    Choose matching text…
                                  </option>
                                  {choice.options.map(
                                    (mapping, optionIndex) => (
                                      <option
                                        key={optionIndex}
                                        value={optionIndex}
                                      >
                                        {mapping.archivePath} →{" "}
                                        {mods.find(
                                          (mod) =>
                                            mod.uniqueId ===
                                            mapping.modUniqueId,
                                        )?.name ?? mapping.modUniqueId}{" "}
                                        /{" "}
                                        {mapping.relativeDir.replace(
                                          "/@split/",
                                          "/",
                                        )}
                                      </option>
                                    ),
                                  )}
                                  <option value="skip">Skip this text</option>
                                </select>
                              </label>
                            ) : (
                              <p>
                                {choice.options[0]?.archivePath} →{" "}
                                {choice.options[0]?.modUniqueId} /{" "}
                                {choice.options[0]?.relativeDir}
                              </p>
                            )}
                            {choice.requiresDefaultConfirmation &&
                              selected.mapping && (
                                <label className="nexus-checkbox">
                                  <input
                                    type="checkbox"
                                    checked={row.confirmed?.[index] ?? false}
                                    disabled={locked}
                                    onChange={(event) =>
                                      patch(key, {
                                        confirmed: {
                                          ...row.confirmed,
                                          [index]: event.target.checked,
                                        },
                                      })
                                    }
                                  />{" "}
                                  This default.json contains {targetLang}{" "}
                                  translation text. Keep the installed English
                                  source unchanged.
                                </label>
                              )}
                          </div>
                        );
                      })}
                      <button
                        className={primary}
                        type="button"
                        disabled={
                          locked ||
                          row.choices!.some((choice, index) => {
                            const selected = selectedMapping(
                              row,
                              choice,
                              index,
                            );
                            return (
                              !selected.value ||
                              Boolean(
                                selected.mapping &&
                                choice.requiresDefaultConfirmation &&
                                !row.confirmed?.[index],
                              )
                            );
                          })
                        }
                        onClick={() =>
                          void run(key, async (current) => {
                            if (
                              row.downloadedAt &&
                              Date.now() - row.downloadedAt >= 15 * 60_000
                            )
                              throw new Error(
                                "The temporary archive expired. Download again.",
                              );
                            const mappings = row.choices!.flatMap(
                              (choice, index) => {
                                const selected = selectedMapping(
                                  row,
                                  choice,
                                  index,
                                );
                                return selected.mapping
                                  ? [selected.mapping]
                                  : [];
                              },
                            );
                            patch(key, { choices: undefined });
                            await importMappings(key, mappings, current);
                            if (current()) patch(key, { completed: true });
                          })
                        }
                      >
                        Import selected text
                      </button>
                    </>
                  )}
                </div>
              )}
            </td>
          </tr>
        )}
      </Fragment>
    );
  }
  const showInstallationHint =
    pendingDownloads > 0 ||
    batchRunning ||
    handoffCount > 0 ||
    (!isVortex && acquisitionResults.length > 0);
  const showSessionSummary =
    scanIncomplete ||
    actionStatus ||
    resultStatus ||
    inventoryRefreshWarning ||
    resolvingInstalled ||
    unresolvedCount > 0 ||
    showInstallationHint ||
    checkError;
  if (!open) return null;
  return (
    <NexusModal
      embedded={embedded}
      title={`Nexus translations · ${targetLang}`}
      busy={Boolean(active) || batchRunning}
      onClose={onClose}
    >
      {showSessionSummary && (
        <div className="nexus-session-summary">
          {scanIncomplete && (
            <p role="status">
              Some Nexus translation statuses are unavailable. Resolve scan
              errors and scan again; verified mods remain available.
            </p>
          )}
          {(actionStatus || resultStatus) && (
            <p role="status">{actionStatus || resultStatus}</p>
          )}
          {libraryMode &&
            importedState.context === importedContext &&
            importedState.error && <p role="alert">{importedState.error}</p>}
          {importStatusUnknown && !importedState.error && (
            <p role="status">Checking saved import status…</p>
          )}
          {inventoryRefreshWarning && (
            <small className="nexus-muted">{inventoryRefreshWarning}</small>
          )}
          {resolvingInstalled && (
            <p role="status">Checking installed translations…</p>
          )}
          <div className="nexus-actions">
            {!resolvingInstalled &&
              (isVortex || canDirectImport) &&
              pendingDownloads > 0 && (
                <button
                  className={primary}
                  disabled={
                    locked ||
                    search.running ||
                    loading ||
                    !pending.length ||
                    (isVortex && !configuredVortex)
                  }
                  onClick={() => void downloadAll()}
                >
                  {isVortex
                    ? "Download all with Vortex"
                    : "Download & import all"}{" "}
                  ({pendingDownloads})
                </button>
              )}
            {!resolvingInstalled &&
              (isVortex || canDirectImport) &&
              unresolvedCount > 0 && (
                <small>
                  {unresolvedCount}{" "}
                  {unresolvedCount === 1 ? "mod is" : "mods are"} not included
                  in the download.
                </small>
              )}
            {batchRunning && (
              <button
                className={quiet}
                onClick={() => {
                  stopBatchRef.current = true;
                }}
              >
                Stop after current
              </button>
            )}
          </div>
          {showInstallationHint && (
            <small className="nexus-muted">
              {isVortex
                ? configuredVortex
                  ? handedOffIds.length > 0
                    ? "Install and deploy in Vortex; this list updates when you return."
                    : "Vortex handles installation according to your settings."
                  : "Choose Vortex.exe in installation settings first."
                : canDirectImport
                  ? "Valid imports are marked Done. Use the existing Export action when ready."
                  : nexusAccountKind(account) === "free"
                    ? "Free account: use each Open Nexus Link below to download manually. Direct archive import requires Premium."
                    : "Use Open Nexus Link below for manual downloads, or Search again to check import access."}
            </small>
          )}
          {checkError && <p role="alert">{checkError}</p>}
        </div>
      )}
      <div className="nexus-dialog-body">
        {(loading || search.running) && (
          <p role="status">
            {loading
              ? "Loading translation versions…"
              : "Finding translations…"}
          </p>
        )}
        {!resolvingInstalled && acquisitionResults.length > 0 && (
          <section aria-label="Available translations">
            <h3>
              {pendingDownloads > 0
                ? "Available downloads and updates"
                : "Translation actions"}
            </h3>
            <div className="nexus-table-scroll">
              <table className="nexus-table" aria-label="Translation downloads">
                <thead>
                  <tr>
                    <th>Installed mod</th>
                    <th>Translation file / version</th>
                  </tr>
                </thead>
                <tbody>{acquisitionResults.map(renderRow)}</tbody>
              </table>
            </div>
          </section>
        )}
        {!resolvingInstalled && installedResults.length > 0 && (
          <details className="nexus-installed-results">
            <summary>
              Installed translations ({installedResults.length})
            </summary>
            <p>
              These files are already installed. Missing strings can be
              completed in Workspace; installation alone does not confirm
              deployment or complete coverage.
            </p>
            <div className="nexus-table-scroll">
              <table
                className="nexus-table"
                aria-label="Installed translations"
              >
                <thead>
                  <tr>
                    <th>Installed mod</th>
                    <th>Translation file / version</th>
                  </tr>
                </thead>
                <tbody>{installedResults.map(renderRow)}</tbody>
              </table>
            </div>
          </details>
        )}
        {!resolvingInstalled &&
          !importStatusUnknown &&
          !loading &&
          !search.running &&
          pendingDownloads === 0 &&
          shown.length > 0 &&
          !actionStatus &&
          !resultStatus && (
            <p role="status" className="nexus-complete-state">
              {unavailableCount ||
              scanIncomplete ||
              search.cancelled ||
              search.stoppedReason ||
              search.completed < search.total
                ? "No downloads ready. Some results could not be verified."
                : installedResults.length === shown.length
                  ? "No new downloads needed. Check missing strings in Workspace."
                  : "No downloads selected. Review the available translation files."}
            </p>
          )}
        {!resolvingInstalled &&
          !shown.length &&
          !loading &&
          !search.running && (
            <p>
              {scanIncomplete
                ? "Nexus translation status is unknown until the scan is complete."
                : unavailableCount ||
                    search.stoppedReason ||
                    search.completed < search.total
                  ? "No downloadable files could be confirmed."
                  : installedGroups > 0
                    ? "Available translation files are already installed."
                    : coveredIds.size > 0 ||
                        (search.total === 0 && skippedComplete > 0)
                      ? "No missing translation text in the checked mods."
                      : "No suitable translation downloads found."}
            </p>
          )}
        <section
          aria-label="Translation search results"
          className="nexus-search-results"
        >
          {Boolean(search.unassignedNames?.length) && (
            <details>
              <summary>Mods without Nexus ID ({search.noId})</summary>
              <p>{search.unassignedNames!.join(", ")}</p>
              <small>
                These packages have no Nexus update key. Their strings are still
                available locally.
              </small>
            </details>
          )}
          {!resolvingInstalled && (
            <div className="translator-preflight-metrics">
              {[
                [`${search.completed}/${search.total}`, "IDs checked"],
                [
                  acquisitionResults.filter(
                    (group) =>
                      group.options.length > 0 &&
                      !group.row.handoff &&
                      !group.row.completed,
                  ).length,
                  "Mods with downloads",
                ],
                [noDownloadIds.size, "No suitable download found"],
                [
                  skippedComplete + coveredIds.size + installedGroups,
                  "No new download needed",
                ],
                [search.noId, "Mods without Nexus ID"],
                [unavailableCount, "Checks failed"],
              ].map(([value, label]) => (
                <div
                  className="translator-preflight-metric"
                  key={label}
                  title={
                    label === "No new download needed"
                      ? scanIncomplete
                        ? "Verified mods only; some scan results are unavailable"
                        : `${skippedComplete + coveredIds.size} mods with no missing text; ${installedGroups} installed translations with no new file selected; text gaps may remain`
                      : undefined
                  }
                >
                  <strong>{value}</strong>
                  <span>{label}</span>
                </div>
              ))}
            </div>
          )}
          {search.stoppedReason ? (
            <p role="alert">{search.stoppedReason}</p>
          ) : search.cancelled ? (
            <p role="status">Search cancelled · results are partial.</p>
          ) : !search.running && search.completed < search.total ? (
            <p role="status">Search incomplete · results are partial.</p>
          ) : null}
          <div className="nexus-actions nexus-footer">
            <button
              className={quiet}
              disabled={locked || search.running}
              onClick={() => {
                setFileSelections({});
                fileMetadata.refresh();
                onSearch({
                  forceRefresh: true,
                  retainIds: handedOffIds.filter((id) => !coveredIds.has(id)),
                });
              }}
            >
              Search again
            </button>
            <button className={quiet} disabled={locked} onClick={onConfigure}>
              Nexus settings
            </button>
            {search.running && (
              <button className={quiet} onClick={onCancel}>
                Cancel search
              </button>
            )}
            <span className="nexus-footer-quota">
              <NexusQuotaSummary status={account} />
            </span>
          </div>
          {unavailableCount > 0 && (
            <>
              <p role="alert">
                {unavailableCount} translation checks failed. Search again or
                retry file metadata.
              </p>
              {groups.some((group) => group.errors.length) && (
                <button
                  className={quiet}
                  disabled={locked || loading}
                  onClick={fileMetadata.refresh}
                >
                  Retry file metadata
                </button>
              )}
              <details>
                <summary>Error details</summary>
                {search.entries
                  .filter((entry) => entry.error)
                  .map((entry) => (
                    <p key={entry.modId}>
                      {entry.localNames.join(", ")}: {entry.error}
                    </p>
                  ))}
                {groups
                  .filter((group) => group.errors.length)
                  .map((group) => (
                    <p key={group.entry.modId}>{group.errors.join("; ")}</p>
                  ))}
              </details>
            </>
          )}
        </section>
      </div>
    </NexusModal>
  );
}
