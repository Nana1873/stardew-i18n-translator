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
  type NexusArchive,
  type NexusCandidate,
  type NexusFile,
  type NexusImportRequest,
  type ScannedMod,
  type SkippedComponent,
} from "../tauri/commands";
import {
  resolveArchiveTranslations,
  nexusSourceDiskCoverage,
} from "./resolveTranslation";
import { fileChoices, useNexusFiles } from "./useNexusFiles";
import type { NexusSearchEntry, NexusSearchState } from "./useNexusSearch";

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
  vortexExecutable,
  installationMethod,
  onCheckInstalled,
  skippedComponents = [],
  traversalComplete = false,
}: {
  open?: boolean;
  vortexExecutable?: string | null;
  installationMethod?: "folder" | "vortex";
  onCheckInstalled?: () => Promise<void>;
  search: NexusSearchState;
  mods: ScannedMod[];
  skippedComponents?: SkippedComponent[];
  traversalComplete?: boolean;
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
}) {
  const configuredVortex = vortexExecutable?.trim();
  const method = installationMethod ?? (configuredVortex ? "vortex" : "folder");
  const isVortex = method === "vortex";
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
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
  const actionContext = useRef(`${targetLang}|${method}`);
  useEffect(() => {
    const next = `${targetLang}|${method}`;
    if (actionContext.current !== next) {
      actionContext.current = next;
      generation.current++;
      setFileSelections({});
    }
  }, [targetLang, method]);
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
    const current = () => stamp === generation.current;
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
      const status = await nexusStatus(true);
      if (!current()) return;
      if (!status.premium)
        throw new Error(
          "Direct import requires Nexus Premium. Open Nexus files for a manual download.",
        );
      await downloadAndImport(key, sourceId, candidate, file, current);
    });
  }
  async function requestHandoff(
    key: string,
    sourceId: number,
    candidate: NexusCandidate,
    file: NexusFile,
  ) {
    await run(key, async (current) => {
      if (!configuredVortex)
        throw new Error("Choose Vortex.exe in installation settings first.");
      patch(key, {
        intent: "vortex",
        status: "Sending to Vortex…",
        choices: undefined,
      });
      const receipt = await nexusHandoffToVortex(candidate.modId, file.fileId);
      if (!current()) return;
      if (receipt.status !== "handoff-requested")
        throw new Error("Vortex handoff was not confirmed by the launcher.");
      patch(key, {
        handoff: {
          at: Date.now(),
          before: nexusSourceDiskCoverage(
            mods,
            sourceId,
            skippedComponents,
            traversalComplete,
          ),
        },
        selectedArchive: file,
        completed: false,
      });
    });
  }
  const handedOffIds = [
    ...new Set(
      Object.entries(rows)
        .filter(([, row]) => row.handoff)
        .map(([key]) => Number(key.split(":")[0])),
    ),
  ];
  async function checkInstalled() {
    if (!onCheckInstalled) return;
    const stamp = generation.current;
    setChecking(true);
    setCheckError(null);
    try {
      await onCheckInstalled();
      if (stamp === generation.current) setCheckedAt(Date.now());
    } catch (cause) {
      if (stamp === generation.current) setCheckError(String(cause));
    } finally {
      if (stamp === generation.current) setChecking(false);
    }
  }
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
  const locked = Boolean(active) || batchRunning || checking;
  const candidatesFor = (entry: NexusSearchEntry) =>
    [...(entry.result?.candidates ?? [])].sort(
      (a, b) =>
        Number(a.relationshipTier !== "possible-original-translation") -
          Number(b.relationshipTier !== "possible-original-translation") ||
        b.updatedAt.localeCompare(a.updatedAt),
    );
  const sources = search.entries.filter(
    (entry) =>
      entry.result?.candidates.length &&
      (handedOffIds.includes(entry.modId) ||
        !nexusSourceDiskCoverage(
          mods,
          entry.modId,
          skippedComponents,
          traversalComplete,
        )?.complete),
  );
  const fileMetadata = useNexusFiles(
    sources.flatMap((entry) =>
      candidatesFor(entry).map((candidate) => candidate.modId),
    ),
    open,
    `${targetLang}|${method}`,
  );
  const groups = sources.map((entry) => {
    const candidates = candidatesFor(entry);
    const options = candidates.flatMap((candidate) => {
      const files = fileMetadata.entries[candidate.modId]?.files;
      if (!files) return [];
      const choices = fileChoices(files, targetLang, isVortex);
      return choices.files.map((file) => ({
        candidate,
        file,
        value: `${candidate.modId}:${file.fileId}`,
        recommended: file.fileId === choices.recommended,
      }));
    });
    // Only the best-ranked candidate may supply a default. Variants need explicit selection.
    const preferred = options.find(
      (option) =>
        option.candidate.modId === candidates[0]?.modId && option.recommended,
    );
    const value =
      fileSelections[entry.modId] ??
      (options.length === 1 ? options[0].value : (preferred?.value ?? ""));
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
  const shown = groups.filter((group) => group.options.length > 0);
  const metadataErrors = groups.reduce(
    (sum, group) => sum + group.errors.length,
    0,
  );
  const discoveryErrors = search.entries.filter((entry) => entry.error).length;
  const unavailableCount = metadataErrors + discoveryErrors;
  const loading = groups.some((group) => group.loading);
  const unresolved = shown.some((group) => !group.selected);
  const pending = shown.filter(
    (group) =>
      group.selected &&
      !group.row.handoff &&
      !group.row.completed &&
      !group.row.choices?.length &&
      !group.row.error,
  );
  async function downloadAll(queue = pending) {
    if (activeRef.current || batchRef.current) return;
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
      for (const item of snapshot) {
        if (stamp !== generation.current || stopBatchRef.current) break;
        await (isVortex ? requestHandoff : startReview)(
          item.key,
          item.sourceId,
          item.candidate,
          item.file,
        );
      }
    } finally {
      batchRef.current = false;
      if (mounted.current) setBatchRunning(false);
    }
  }
  function renderRow(group: (typeof groups)[number]) {
    const { entry, selected, key, row } = group;
    const sourceId = entry.modId;
    const candidate = selected?.candidate ?? group.candidates[0];
    const sourceName =
      entry.result?.originalName ?? entry.localNames.join(", ");
    const file = selected?.file;
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
    return (
      <Fragment key={sourceId}>
        <tr aria-label={sourceName}>
          <td>
            <strong>{sourceName}</strong>
            {version && (
              <small>Installed v{version.replace(/^v(?=\d)/i, "")}</small>
            )}
          </td>
          <td>
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
                <option value="">Choose translation version…</option>
                {group.candidates.map((item) => (
                  <optgroup key={item.modId} label={item.name}>
                    {group.options
                      .filter((option) => option.candidate.modId === item.modId)
                      .map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.file.name} ·{" "}
                          {metadataLine(
                            option.file.version,
                            option.file.uploadedAt,
                          )}
                          {option.recommended ? " · recommended" : ""}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            ) : (
              <>
                <strong className="nexus-selected-title">
                  {candidate.name}
                </strong>
                <small>
                  {file && metadataLine(file.version, file.uploadedAt)}
                </small>
              </>
            )}
            {file && <small className="nexus-file-name">{file.fileName}</small>}
            {!selected && (
              <small>Choose the version for your installed mod.</small>
            )}
          </td>
          <td>
            <p role="status">
              {row.status ??
                (row.handoff
                  ? rechecked
                    ? "Sent to Vortex · rechecked"
                    : "Sent to Vortex"
                  : row.choices?.length
                    ? "Confirm matching text"
                    : row.error
                      ? "Action failed"
                      : row.completed || row.imported > 0
                        ? `${row.imported} imported to Review`
                        : "Ready")}
            </p>
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
            <details>
              <summary>Details</summary>
              {row.handoff && (
                <p>
                  Vortex launch was requested. Download, installation and
                  deployment are not confirmed by this app.
                </p>
              )}
              <small>
                {disk
                  ? `On disk: ${disk.covered}/${disk.total} keys${rechecked && baseline ? ` (${disk.covered - baseline.covered >= 0 ? "+" : ""}${disk.covered - baseline.covered} since handoff)` : ""}`
                  : "Disk coverage unavailable"}
              </small>
              {disk && disk.differences > 0 && (
                <small>
                  {disk.differences} saved values differ from disk; drafts kept.
                </small>
              )}
              {(row.completed || row.imported > 0) && (
                <p>
                  {row.imported > 0
                    ? `${row.imported} imported to Review this session`
                    : "No new strings added"}{" "}
                  · {row.kept} existing values kept · {row.invalid} token errors
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
              <button
                className={quiet}
                disabled={locked}
                onClick={() =>
                  void run(key, () =>
                    openUrl(
                      `https://www.nexusmods.com/stardewvalley/mods/${candidate.modId}?tab=files`,
                    ),
                  )
                }
              >
                Open Nexus files
              </button>
            </details>
          </td>
        </tr>
        {Boolean(row.choices?.length) && (
          <tr>
            <td colSpan={3}>
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
      busy={locked}
      onClose={onClose}
    >
      <div className="nexus-session-summary">
        <div className="nexus-actions">
          <button
            className={primary}
            disabled={
              locked ||
              search.running ||
              loading ||
              unresolved ||
              !pending.length ||
              (isVortex && !configuredVortex)
            }
            onClick={() => void downloadAll()}
          >
            {isVortex
              ? "Download & install all with Vortex"
              : "Download & import all"}{" "}
            ({pending.length})
          </button>
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
          {handedOffIds.length > 0 && (
            <button
              className={quiet}
              disabled={locked || !onCheckInstalled}
              onClick={() => void checkInstalled()}
            >
              {checking ? "Checking files…" : "Check installed files"}
            </button>
          )}
        </div>
        <small className="nexus-muted">
          {isVortex
            ? configuredVortex
              ? "Vortex handles downloads and installation. Deploy there, then check files here."
              : "Choose Vortex.exe in installation settings first."
            : "Imports go to Review. Use the existing Export action when ready."}
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
        {shown.length > 0 && (
          <div className="nexus-table-scroll">
            <table className="nexus-table" aria-label="Translation downloads">
              <thead>
                <tr>
                  <th>Installed mod</th>
                  <th>Translation file / version</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>{shown.map(renderRow)}</tbody>
            </table>
          </div>
        )}
        {unavailableCount > 0 && (
          <p role="alert">
            {unavailableCount} translation checks failed. Open Options &amp;
            search details to retry.
          </p>
        )}
        {!shown.length && !loading && !search.running && (
          <p>
            {unavailableCount
              ? "No downloadable files could be confirmed."
              : "No suitable translation downloads found."}
          </p>
        )}
        <details className="nexus-options">
          <summary>Options & search details</summary>
          <div className="nexus-actions">
            <button
              className={quiet}
              disabled={locked || search.running}
              onClick={() => {
                setFileSelections({});
                fileMetadata.refresh();
                onSearch({ forceRefresh: true, retainIds: handedOffIds });
              }}
            >
              Refresh search
            </button>
            <button className={quiet} disabled={locked} onClick={onConfigure}>
              Nexus settings
            </button>
            {search.running && (
              <button className={quiet} onClick={onCancel}>
                Cancel search
              </button>
            )}
          </div>
          <p>
            {search.completed}/{search.total} IDs checked ·{" "}
            {search.skippedComplete ?? 0} fully translated mod groups skipped ·{" "}
            {search.noId} components without a Nexus ID.
          </p>
          <p>
            Only likely translations with suitable current files are listed.
            Missing results do not prove that no translation exists.
          </p>
          {search.stoppedReason && <p role="alert">{search.stoppedReason}</p>}
          {groups
            .filter((group) => group.errors.length)
            .map((group) => (
              <p role="alert" key={group.entry.modId}>
                {group.errors.join("; ")}
              </p>
            ))}
          {groups.some((group) => group.errors.length) && (
            <button
              className={quiet}
              disabled={locked || loading}
              onClick={fileMetadata.refresh}
            >
              Retry file metadata
            </button>
          )}
          {groups
            .filter(
              (group) =>
                !group.loading && !group.options.length && !group.errors.length,
            )
            .map((group) => (
              <p key={group.entry.modId}>
                {group.entry.result?.originalName}: no suitable current files.
              </p>
            ))}
          {search.entries
            .filter((entry) => !entry.result?.candidates.length)
            .map((entry) => (
              <p key={entry.modId}>
                {entry.result?.originalName ?? entry.localNames.join(", ")}:{" "}
                {entry.error ?? "No likely translation found."}
              </p>
            ))}
        </details>
      </div>
    </NexusModal>
  );
}
