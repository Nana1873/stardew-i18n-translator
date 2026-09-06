import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { useDialogAccessibility } from "../dialogAccessibility";
import {
  nexusStatus,
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
  type ScannedMod,
  type SkippedComponent,
} from "../tauri/commands";
import {
  resolveArchiveTranslations,
  nexusSourceDiskCoverage,
  nexusSourceComponents,
} from "./resolveTranslation";
import { fileChoices, useNexusFiles } from "./useNexusFiles";
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
  title,
  busy,
  onClose,
  children,
}: {
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
  installedNexusTranslations = [],
}: {
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
  installedNexusTranslations?: InstalledNexusTranslation[];
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
  const isVortex = method === "vortex";
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
        const preview = await nexusPreflightImport(mapping);
        if (!current()) return;
        const result =
          preview.importable > 0
            ? await nexusImportTranslation(mapping)
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
            `${name} / ${mapping.relativeDir}: ${result.imported} imported, ${result.conflicts} kept, ${result.tokenInvalid} token errors (${mapping.archivePath}). ${result.matched} matching, ${result.missing} missing, ${result.extra} extra, ${result.empty} empty, ${result.sourceEqual} source-identical.`,
          ],
        }));
      } catch (cause) {
        if (!current()) return;
        patch(key, (row) => ({
          ...row,
          failures: row.failures + 1,
          details: [
            ...row.details,
            `${name} / ${mapping.relativeDir}: ${String(cause)}`,
          ],
          error:
            "Some text could not be imported. Completed imports were kept; see details.",
        }));
      }
    }
    if (saved > 0 && current()) {
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
    });
    const archive = await nexusDownloadPreflight(candidate.modId, file.fileId);
    if (!current()) return;
    const resolved = resolveArchiveTranslations(
      archive,
      sourceId,
      mods,
      targetLang,
    );
    patch(key, (row) => ({
      ...row,
      archive,
      downloadedAt: Date.now(),
      selectedArchive: file,
      downloads: row.downloads + 1,
      choices: resolved.choices,
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
      if (!file.fileName.toLowerCase().endsWith(".zip"))
        throw new Error(
          "The selected archive is not a ZIP. Review import requires ZIP; the selected file was not replaced.",
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
  const candidatesFor = (entry: NexusSearchEntry) =>
    [...(entry.result?.candidates ?? [])].sort(
      (a, b) =>
        Number(a.relationshipTier !== "possible-original-translation") -
          Number(b.relationshipTier !== "possible-original-translation") ||
        b.updatedAt.localeCompare(a.updatedAt),
    );
  const scanIncomplete =
    !traversalComplete ||
    skippedComponents.some((item) => item.requiresAttention);
  const coveredIds = new Set(
    search.entries
      .filter(
        (entry) =>
          nexusSourceDiskCoverage(
            mods,
            entry.modId,
            skippedComponents,
            traversalComplete,
          )?.complete,
      )
      .map((entry) => entry.modId),
  );
  const evidenceFor = (sourceId: number) =>
    isVortex && !scanIncomplete
      ? installedNexusTranslations.filter(
          (item) =>
            item.sourceNexusId === sourceId &&
            (item.state === undefined ||
              item.state === "deployed" ||
              item.state === "missing_dictionary"),
        )
      : [];
  const sources = search.entries.filter(
    (entry) =>
      (entry.result?.candidates.length || evidenceFor(entry.modId).length) &&
      !coveredIds.has(entry.modId),
  );
  const fileMetadata = useNexusFiles(
    search.entries.flatMap((entry) =>
      candidatesFor(entry).map((candidate) => candidate.modId),
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
  const groups = sources.map((entry) => {
    const candidates = candidatesFor(entry);
    const evidence = evidenceFor(entry.modId);
    const problem = evidence.some(
      (item) => item.state === "missing_dictionary",
    );
    const allOptions = candidates.flatMap((candidate) => {
      const files = fileMetadata.entries[candidate.modId]?.files;
      if (!files) return [];
      const choices = fileChoices(
        files,
        targetLang,
        isVortex || !canDirectImport,
      );
      return choices.files.map((file) => ({
        candidate,
        file,
        value: `${candidate.modId}:${file.fileId}`,
        recommended: file.fileId === choices.recommended,
      }));
    });
    const recordedOptions = allOptions.filter((option) =>
      evidence.some(
        (item) =>
          item.modId === option.candidate.modId &&
          item.fileId === option.file.fileId,
      ),
    );
    const options = allOptions.filter(
      (option) => !recordedOptions.includes(option),
    );
    // Only a positively classified direct match may supply a default.
    const preferred = allOptions.find(
      (option) =>
        option.candidate.modId === candidates[0]?.modId &&
        option.candidate.relationshipTier === "possible-original-translation" &&
        option.recommended,
    );
    const explicit = fileSelections[entry.modId];
    const value =
      explicit !== undefined
        ? options.some((option) => option.value === explicit)
          ? explicit
          : ""
        : evidence.some(
              (item) =>
                !recordedOptions.some(
                  (option) =>
                    option.candidate.modId === item.modId &&
                    option.file.fileId === item.fileId,
                ),
            )
          ? ""
          : allOptions.length === 1
            ? options[0]?.candidate.relationshipTier ===
              "possible-original-translation"
              ? options[0].value
              : ""
            : options.some((option) => option.value === preferred?.value)
              ? preferred!.value
              : "";
    const selected = options.find((option) => option.value === value);
    const key = selected
      ? `${entry.modId}:${selected.value}`
      : `${entry.modId}:pending`;
    const row = rows[key] ?? emptyRow();
    return {
      entry,
      candidates,
      options,
      selected,
      value,
      key,
      row,
      evidence,
      problem,
      recordedOptions,
      loading: candidates.some(
        (candidate) => !fileMetadata.entries[candidate.modId],
      ),
      errors: candidates.flatMap((candidate) =>
        fileMetadata.entries[candidate.modId]?.error
          ? [
              `${candidate.name}: ${fileMetadata.entries[candidate.modId].error}`,
            ]
          : [],
      ),
    };
  });
  const shown = groups.filter(
    (group) => group.options.length > 0 || group.evidence.length > 0,
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
            !group.evidence.length,
        )
        .map((group) => group.entry.modId),
    ].filter(
      (id) =>
        !failedIds.has(id) && !coveredIds.has(id) && !evidenceFor(id).length,
    ),
  );
  const actionRows = Object.values(rows);
  const installedGroups = groups.filter(
    (group) =>
      !scanIncomplete &&
      !group.loading &&
      !group.errors.length &&
      !group.selected &&
      group.evidence.length > 0 &&
      !group.problem,
  ).length;
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
      ? `${actionRows.reduce((sum, row) => sum + row.imported, 0)} imported to Review`
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
    (group) => !group.selected && !group.evidence.length,
  ).length;
  const skippedComplete = scanIncomplete ? 0 : (search.skippedComplete ?? 0);
  const pending = shown.filter(
    (group) =>
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
    if (
      activeRef.current ||
      batchRef.current ||
      (!isVortex && !canDirectImport)
    )
      return;
    const snapshot = queue.flatMap((group) =>
      group.selected
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
    const linkModId = candidate?.modId ?? group.evidence[0]?.modId;
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
    );
    const baseline = row.handoff?.before;
    const rechecked = Boolean(
      row.handoff && checkedAt && checkedAt >= row.handoff.at,
    );
    const version = mods.find((mod) => mod.nexusId === sourceId)?.version;
    const missingComponents = nexusSourceComponents(mods, sourceId).filter(
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
            {version && !scanIncomplete && (
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
            <small>
              {disk
                ? `Local translation: ${disk.covered}/${disk.total} strings${disk.noTextNeeded ? ` · ${disk.noTextNeeded} need no translation text` : ""} · ${disk.missing} missing`
                : scanIncomplete
                  ? "Local translation coverage unavailable: scan incomplete."
                  : "Local translation coverage unavailable"}
            </small>
            {group.problem && (
              <small>
                The archive contains a translation file for this language, but
                it is missing from this installation.
              </small>
            )}
            {!group.problem &&
              group.evidence.length > 0 &&
              disk &&
              disk.missing > 0 &&
              missingComponents.length === 1 &&
              onOpenMissing && (
                <button
                  className={quiet}
                  disabled={locked}
                  onClick={() => onOpenMissing(missingComponents[0].uniqueId)}
                >
                  Open missing strings
                </button>
              )}
          </td>
          <td>
            <div className="nexus-file-link">
              <div className="nexus-file-selection">
                {group.options.length > 1 ? (
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
                    <option value="">
                      {group.evidence.length
                        ? "No new download"
                        : "Choose translation version…"}
                    </option>
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
                        {group.options
                          .filter(
                            (option) => option.candidate.modId === item.modId,
                          )
                          .map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.file.name} ·{" "}
                              {metadataLine(
                                option.file.version,
                                option.file.uploadedAt,
                              )}
                            </option>
                          ))}
                      </optgroup>
                    ))}
                  </select>
                ) : (
                  <>
                    <strong className="nexus-selected-title">
                      {candidate?.name ?? "Translation archive"}
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
                {displayFile && (
                  <small className="nexus-file-name">
                    {displayFile.fileName}
                  </small>
                )}
                {!selected && unidentifiedEvidence.length > 0 && (
                  <small>
                    {unidentifiedEvidence
                      .map(
                        (item) => `Nexus ${item.modId} · file ${item.fileId}`,
                      )
                      .join("; ")}
                  </small>
                )}
                {group.options.length > 0 &&
                  candidate?.relationshipTier !==
                    "possible-original-translation" && (
                    <small>
                      This may translate a related mod rather than the installed
                      original.
                    </small>
                  )}
                {soleOption &&
                  (soleOption.candidate.relationshipTier !==
                    "possible-original-translation" ||
                    group.evidence.length > 0 ||
                    fileSelections[sourceId] !== undefined) && (
                    <button
                      className={quiet}
                      disabled={locked}
                      onClick={() =>
                        setFileSelections((previous) => ({
                          ...previous,
                          [sourceId]: selected ? "" : soleOption.value,
                        }))
                      }
                    >
                      {selected
                        ? "Exclude translation"
                        : "Use this translation"}
                    </button>
                  )}
                {!selected &&
                  !group.evidence.length &&
                  group.options.length > 1 && (
                    <small>
                      Choose a version to include this mod in the download.
                    </small>
                  )}
              </div>
              <button
                className={primary}
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
            {(row.handoff ||
              row.completed ||
              row.imported > 0 ||
              row.choices?.length ||
              row.notice ||
              row.details.length > 0) && (
              <details>
                <summary>Details</summary>
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
                      ? `${row.imported} imported to Review this session`
                      : "No new strings added"}{" "}
                    · {row.kept} existing values kept · {row.invalid} token
                    errors
                    {row.failures ? ` · ${row.failures} failed` : ""}
                  </p>
                )}
                {candidate.summary && <p>{candidate.summary}</p>}
                {row.notice && <p>{row.notice}</p>}
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
                        Open Review
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
                        The temporary ZIP expired. Download again to import it.
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
                                        / {mapping.relativeDir}
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
                                "The temporary ZIP expired. Download again.",
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
  if (!open) return null;
  return (
    <NexusModal
      title={`Nexus translations · ${targetLang}`}
      busy={Boolean(active) || batchRunning}
      onClose={onClose}
    >
      <div className="nexus-session-summary">
        {scanIncomplete && (
          <p role="status">
            Scan incomplete. Resolve scan errors and scan again to check Nexus
            translations.
          </p>
        )}
        {(actionStatus || resultStatus) && (
          <p role="status">{actionStatus || resultStatus}</p>
        )}
        {resolvingInstalled && (
          <p role="status">Checking installed translations…</p>
        )}
        <div className="nexus-actions">
          {!resolvingInstalled && (isVortex || canDirectImport) && (
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
              {isVortex ? "Download all with Vortex" : "Download & import all"}{" "}
              ({pendingDownloads})
            </button>
          )}
          {!resolvingInstalled &&
            (isVortex || canDirectImport) &&
            unresolvedCount > 0 && (
              <small>
                {unresolvedCount}{" "}
                {unresolvedCount === 1 ? "mod is" : "mods are"} not included in
                the download.
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
        <small className="nexus-muted">
          {isVortex
            ? configuredVortex
              ? handedOffIds.length > 0
                ? "Install and deploy in Vortex; this list updates when you return."
                : "Vortex handles installation according to your settings."
              : "Choose Vortex.exe in installation settings first."
            : canDirectImport
              ? "Imports go to Review. Use the existing Export action when ready."
              : nexusAccountKind(account) === "free"
                ? "Free account: use each Open Nexus Link below to download manually. Direct ZIP import requires Premium."
                : "Use Open Nexus Link below for manual downloads, or Search again to check import access."}
        </small>
        {checkError && <p role="alert">{checkError}</p>}
      </div>
      <div className="nexus-dialog-body">
        {(loading || search.running) && (
          <p role="status">
            {loading
              ? "Loading translation versions…"
              : "Finding translations…"}
          </p>
        )}
        {!resolvingInstalled && shown.length > 0 && (
          <div className="nexus-table-scroll">
            <table className="nexus-table" aria-label="Translation downloads">
              <thead>
                <tr>
                  <th>Installed mod</th>
                  <th>Translation file / version</th>
                </tr>
              </thead>
              <tbody>{shown.map(renderRow)}</tbody>
            </table>
          </div>
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
                    : coveredIds.size > 0
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
                  shown.filter((group) => group.options.length > 0).length,
                  "Mods with downloads",
                ],
                [noDownloadIds.size, "No suitable download found"],
                [
                  scanIncomplete
                    ? "\u2014"
                    : skippedComplete + coveredIds.size + installedGroups,
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
                        ? "Scan incomplete"
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
