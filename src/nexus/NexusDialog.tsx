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
  selectTranslationFile,
  resolveArchiveTranslations,
  nexusSourceDiskCoverage,
} from "./resolveTranslation";
import type { NexusSearchEntry, NexusSearchState } from "./useNexusSearch";

const quiet = "translator-button translator-button-quiet";
const primary = "translator-button translator-button-primary";
type MappingChoice = ReturnType<
  typeof resolveArchiveTranslations
>["choices"][number];
interface RowState {
  status?: string;
  intent?: "vortex" | "review";
  handoff?: { at: number; before: ReturnType<typeof nexusSourceDiskCoverage> };
  fileVersion?: string;
  fileDate?: string;
  error?: string;
  free?: boolean;
  files?: NexusFile[];
  selectedFile?: string;
  selectedArchive?: NexusFile;
  archive?: NexusArchive;
  downloadedAt?: number;
  fileName?: string;
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
  onCheckInstalled,
  skippedComponents = [],
}: {
  open?: boolean;
  vortexExecutable?: string | null;
  onCheckInstalled?: () => Promise<void>;
  search: NexusSearchState;
  mods: ScannedMod[];
  skippedComponents?: SkippedComponent[];
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
  const [destination, setDestination] = useState<"review" | "vortex">(
    vortexExecutable ? "vortex" : "review",
  );
  const [includeComplete, setIncludeComplete] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  const [candidateSelections, setCandidateSelections] = useState<
    Record<number, string>
  >({});
  const [batchRunning, setBatchRunning] = useState(false);
  const batchRef = useRef(false);
  const stopBatchRef = useRef(false);
  const [active, setActive] = useState<string | null>(null);
  const activeRef = useRef<string | null>(null);
  const generation = useRef(0);
  const [now, setNow] = useState(Date.now);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
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
    patch(key, { error: undefined, free: false });
    const stamp = generation.current;
    const current = () => stamp === generation.current;
    try {
      await work(current);
    } catch (cause) {
      if (current()) patch(key, { error: String(cause) });
    } finally {
      if (current()) {
        patch(key, { status: undefined });
        setActive(null);
      }
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
      files: undefined,
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
      fileName: file.fileName,
      fileVersion: file.version,
      fileDate: file.uploadedAt,
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
    chosenFile?: NexusFile,
  ) {
    await run(key, async (current) => {
      patch(key, { intent: "review" });
      if (chosenFile && !chosenFile.fileName.toLowerCase().endsWith(".zip"))
        throw new Error(
          "The selected archive is not a ZIP. Personal Review import requires ZIP; use Vortex for this selected file.",
        );
      if (chosenFile) {
        await downloadAndImport(key, sourceId, candidate, chosenFile, current);
        return;
      }
      patch(key, {
        status: "Finding the matching ZIP…",
        files: undefined,
        choices: undefined,
        completed: false,
        notice: undefined,
      });
      const [status, files] = await Promise.all([
        nexusStatus(true),
        nexusListFiles(candidate.modId),
      ]);
      if (!current()) return;
      if (!status.premium) {
        patch(key, {
          free: true,
          error: "Direct import requires Nexus Premium.",
        });
        return;
      }
      const selection = selectTranslationFile(files, targetLang);
      if (selection.kind === "unavailable") throw new Error(selection.reason);
      if (selection.kind === "choice") {
        patch(key, {
          files: selection.files,
          selectedFile: "",
          notice: selection.reason,
        });
        return;
      }
      await downloadAndImport(
        key,
        sourceId,
        candidate,
        selection.file,
        current,
      );
    });
  }
  async function requestHandoff(
    key: string,
    sourceId: number,
    candidate: NexusCandidate,
    chosenFile?: NexusFile,
  ) {
    await run(key, async (current) => {
      if (!vortexExecutable)
        throw new Error("Choose Vortex.exe in Nexus settings first.");
      patch(key, {
        intent: "vortex",
        status: "Selecting the latest suitable archive…",
        files: undefined,
        choices: undefined,
      });
      const selection = chosenFile
        ? { kind: "selected" as const, file: chosenFile }
        : selectTranslationFile(
            await nexusListFiles(candidate.modId),
            targetLang,
            "vortex",
          );
      if (!current()) return;
      if (selection.kind === "unavailable") throw new Error(selection.reason);
      if (selection.kind === "choice") {
        patch(key, {
          files: selection.files,
          selectedFile: "",
          notice: selection.reason,
        });
        return;
      }
      patch(key, { status: "Requesting Vortex handoff…" });
      const receipt = await nexusHandoffToVortex(
        candidate.modId,
        selection.file.fileId,
      );
      if (!current()) return;
      if (receipt.status !== "handoff-requested")
        throw new Error("Vortex handoff was not confirmed by the launcher.");
      patch(key, {
        handoff: {
          at: Date.now(),
          before: nexusSourceDiskCoverage(mods, sourceId, skippedComponents),
        },
        selectedArchive: selection.file,
        fileName: selection.file.fileName,
        fileVersion: selection.file.version,
        fileDate: selection.file.uploadedAt,
        files: undefined,
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
  function candidatesFor(entry: NexusSearchEntry) {
    return [...(entry.result?.candidates ?? [])].sort(
      (a, b) =>
        Number(a.relationshipTier !== "possible-original-translation") -
          Number(b.relationshipTier !== "possible-original-translation") ||
        b.updatedAt.localeCompare(a.updatedAt),
    );
  }
  function selectedCandidate(entry: NexusSearchEntry): NexusCandidate {
    const candidates = candidatesFor(entry);
    const selection = candidateSelections[entry.modId];
    return (
      (selection !== "original"
        ? (candidates.find(
            (candidate) => String(candidate.modId) === selection,
          ) ?? candidates[0])
        : null) ?? {
        modId: entry.modId,
        name: entry.result?.originalName ?? entry.localNames.join(", "),
        summary: "Original mod files; contents are checked before import.",
        version: "",
        updatedAt: "",
        relationshipTier: "possible-original-translation",
      }
    );
  }
  const found = search.entries.filter(
    (entry) =>
      entry.result?.candidates.length &&
      (includeComplete ||
        handedOffIds.includes(entry.modId) ||
        !nexusSourceDiskCoverage(mods, entry.modId, skippedComponents)
          ?.complete),
  );
  const other = search.entries.filter(
    (entry) => !entry.result?.candidates.length,
  );
  const selectedEntries = found.filter(
    (entry) =>
      checked[entry.modId] &&
      (!candidateSelections[entry.modId] ||
        candidateSelections[entry.modId] === "original" ||
        entry.result?.candidates.some(
          (candidate) =>
            String(candidate.modId) === candidateSelections[entry.modId],
        )),
  );
  useEffect(() => {
    const available = new Map(
      search.entries.map((entry) => [String(entry.modId), entry]),
    );
    const valid = (id: string) => {
      const entry = available.get(id);
      const selected = candidateSelections[Number(id)];
      return Boolean(
        entry &&
        (!selected ||
          selected === "original" ||
          entry.result?.candidates.some(
            (candidate) => String(candidate.modId) === selected,
          )),
      );
    };
    setChecked((previous) => {
      const next = Object.fromEntries(
        Object.entries(previous).filter(([id]) => valid(id)),
      );
      return Object.keys(next).length === Object.keys(previous).length
        ? previous
        : next;
    });
    setCandidateSelections((previous) => {
      const next = Object.fromEntries(
        Object.entries(previous).filter(([id]) => valid(id)),
      );
      return Object.keys(next).length === Object.keys(previous).length
        ? previous
        : next;
    });
  }, [search.entries, candidateSelections]);
  async function sendSelected() {
    if (activeRef.current || batchRef.current) return;
    const queue = selectedEntries.map((entry) => ({
      sourceId: entry.modId,
      candidate: { ...selectedCandidate(entry) },
      state: rows[`${entry.modId}:${selectedCandidate(entry).modId}`],
    }));
    const stamp = generation.current;
    batchRef.current = true;
    stopBatchRef.current = false;
    setBatchRunning(true);
    try {
      for (const item of queue) {
        if (stamp !== generation.current || stopBatchRef.current) break;

        const chosenFile =
          item.state?.files?.find(
            (file) => String(file.fileId) === item.state?.selectedFile,
          ) ?? item.state?.selectedArchive;
        if (item.state?.files?.length && !chosenFile) continue;
        if (destination === "review" && item.state?.choices?.length) continue;
        await (destination === "vortex" ? requestHandoff : startReview)(
          `${item.sourceId}:${item.candidate.modId}`,
          item.sourceId,
          item.candidate,
          chosenFile ? { ...chosenFile } : undefined,
        );
      }
    } finally {
      batchRef.current = false;
      if (stamp === generation.current) setBatchRunning(false);
    }
  }
  function renderRow(entry: NexusSearchEntry) {
    const sourceId = entry.modId;
    const candidate = selectedCandidate(entry);
    const candidates = candidatesFor(entry);
    const key = `${sourceId}:${candidate.modId}`;
    const row = rows[key] ?? emptyRow();
    const expired = Boolean(
      row.downloadedAt && now - row.downloadedAt >= 15 * 60_000,
    );
    const awaiting = Boolean(row.files?.length || row.choices?.length);
    const sourceName =
      entry.result?.originalName ?? entry.localNames.join(", ");
    const disk = nexusSourceDiskCoverage(mods, sourceId, skippedComponents);
    const baseline = row.handoff?.before;
    const rechecked = Boolean(
      row.handoff && checkedAt && checkedAt >= row.handoff.at,
    );
    const chosenFile = row.files?.find(
      (file) => String(file.fileId) === row.selectedFile,
    );
    const originalVersion = mods.find(
      (mod) => mod.nexusId === sourceId,
    )?.version;
    return (
      <Fragment key={sourceId}>
        <tr aria-label={sourceName}>
          <td>
            <input
              type="checkbox"
              aria-label={`Select ${sourceName}`}
              checked={checked[sourceId] ?? false}
              disabled={locked || !candidates.length}
              onChange={(event) =>
                setChecked((previous) => ({
                  ...previous,
                  [sourceId]: event.target.checked,
                }))
              }
            />
          </td>
          <td>
            <strong>{sourceName}</strong>
            {originalVersion && <small>Installed mod v{originalVersion}</small>}
          </td>
          <td>
            {candidates.length > 1 && (
              <select
                aria-label={`Translation for ${sourceName}`}
                disabled={locked}
                value={
                  candidateSelections[sourceId] ?? String(candidates[0].modId)
                }
                onChange={(event) =>
                  setCandidateSelections((previous) => ({
                    ...previous,
                    [sourceId]: event.target.value,
                  }))
                }
              >
                {candidates.map((item) => (
                  <option key={item.modId} value={item.modId}>
                    {item.name} · {item.version}
                  </option>
                ))}
                <option value="original">Original mod files</option>
              </select>
            )}
            <strong className="nexus-selected-title">{candidate.name}</strong>
            <small>
              Translation{" "}
              {candidate.version
                ? `v${candidate.version}`
                : "version unavailable"}{" "}
              · {candidate.updatedAt || "Date unavailable"}
              {candidate.relationshipTier ===
              "possible-addon-or-other-translation"
                ? " · possible add-on"
                : ""}
            </small>
            {row.files?.length ? (
              <>
                <select
                  aria-label={`Archive variant for ${candidate.name}`}
                  value={row.selectedFile ?? ""}
                  disabled={locked}
                  onChange={(event) =>
                    patch(key, { selectedFile: event.target.value })
                  }
                >
                  <option value="">Choose archive variant…</option>
                  {row.files.map((file) => (
                    <option key={file.fileId} value={file.fileId}>
                      {file.name} · {file.version} · {file.fileName}
                    </option>
                  ))}
                </select>
                {chosenFile && (
                  <small>
                    File v{chosenFile.version} ·{" "}
                    {chosenFile.uploadedAt || "Date unavailable"}
                  </small>
                )}
                {row.intent === "review" && (
                  <button
                    type="button"
                    className={quiet}
                    disabled={locked || !chosenFile}
                    onClick={() =>
                      void startReview(key, sourceId, candidate, chosenFile)
                    }
                  >
                    Import selected ZIP to Review
                  </button>
                )}
              </>
            ) : (
              <small>
                {row.fileName ??
                  "Latest suitable archive resolved when sending"}
                {row.fileVersion ? ` · file v${row.fileVersion}` : ""}
                {row.fileDate ? ` · ${row.fileDate}` : ""}
              </small>
            )}
          </td>
          <td>
            <div className="nexus-row-status" aria-live="polite">
              <p role="status">
                {row.status ??
                  (row.handoff
                    ? rechecked
                      ? "Handoff requested · files rechecked"
                      : "Handoff requested · deployment not checked"
                    : awaiting
                      ? "Choose matching file/text"
                      : row.error
                        ? "Action failed"
                        : "Ready")}
              </p>
            </div>
            {(row.completed || row.imported > 0) && (
              <p role="status">
                {row.imported > 0
                  ? `${row.imported} imported to Review this session`
                  : "No new strings added"}{" "}
                · {row.kept} existing values kept · {row.invalid} token errors
                {row.failures ? ` · ${row.failures} failed` : ""}
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
            {(row.error || entry.error) && (
              <p role="alert">{row.error ?? entry.error}</p>
            )}
            <details>
              <summary>Details & personal import</summary>
              {row.handoff && (
                <p>
                  Vortex launch was requested. Download, installation,
                  deployment and Collection membership are not confirmed by this
                  app.
                </p>
              )}
              {candidate.summary && <p>{candidate.summary}</p>}
              {entry.localNames.some((name) => name !== sourceName) && (
                <p>Local components: {entry.localNames.join(", ")}</p>
              )}
              {row.notice && <p>{row.notice}</p>}
              {row.details.map((detail, index) => (
                <p key={index}>{detail}</p>
              ))}
              <button
                className={quiet}
                type="button"
                disabled={locked}
                onClick={() =>
                  void startReview(
                    key,
                    sourceId,
                    candidate,
                    chosenFile ?? row.selectedArchive,
                  )
                }
              >
                Import to Review instead
              </button>
              {row.modIds.map(
                (modId) =>
                  onOpenReview && (
                    <button
                      className={quiet}
                      type="button"
                      key={modId}
                      disabled={locked}
                      onClick={() => onOpenReview(modId)}
                    >
                      Open Review
                      {row.modIds.length > 1
                        ? ` · ${mods.find((mod) => mod.uniqueId === modId)?.name ?? modId}`
                        : ""}
                    </button>
                  ),
              )}
              {candidates.length === 1 && (
                <button
                  className={quiet}
                  type="button"
                  disabled={locked}
                  onClick={() => {
                    setCandidateSelections((previous) => ({
                      ...previous,
                      [sourceId]:
                        candidateSelections[sourceId] === "original"
                          ? String(candidates[0].modId)
                          : "original",
                    }));
                    setChecked((previous) => ({
                      ...previous,
                      [sourceId]: false,
                    }));
                  }}
                >
                  {candidateSelections[sourceId] === "original"
                    ? "Use suggested translation"
                    : "Use original mod files"}
                </button>
              )}
              <button
                className={quiet}
                type="button"
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
            <td colSpan={4}>
              {Boolean(row.choices?.length) && (
                <div className="nexus-inline-choice">
                  {expired ? (
                    <p role="alert">
                      The temporary ZIP expired. Download again to import it.
                    </p>
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
                          Boolean(active) ||
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
  const tableHead = (
    <thead>
      <tr>
        <th>
          <input
            type="checkbox"
            aria-label="Select all available translations"
            checked={
              found.length > 0 && selectedEntries.length === found.length
            }
            disabled={locked || !found.length}
            onChange={(event) =>
              setChecked(
                Object.fromEntries(
                  found.map((entry) => [entry.modId, event.target.checked]),
                ),
              )
            }
          />
        </th>
        <th>Mod</th>
        <th>Translation / file</th>
        <th>Status</th>
      </tr>
    </thead>
  );
  const fetchedTimes = search.entries.flatMap((entry) =>
    entry.result?.fetchedAt ? [entry.result.fetchedAt] : [],
  );
  const latestSearch = fetchedTimes.length
    ? new Date(Math.min(...fetchedTimes)).toLocaleString("en-GB")
    : null;
  if (!open) return null;
  return (
    <NexusModal
      title={`Nexus translations · ${targetLang}`}
      busy={locked}
      onClose={onClose}
    >
      <div className="nexus-session-summary" aria-label="Nexus session status">
        <div className="nexus-actions">
          <select
            aria-label="Destination"
            value={destination}
            disabled={locked}
            onChange={(event) =>
              setDestination(event.target.value as "review" | "vortex")
            }
          >
            <option value="review">Translator Review</option>
            <option value="vortex">Vortex</option>
          </select>
          <button
            className={primary}
            type="button"
            disabled={
              locked ||
              selectedEntries.length === 0 ||
              (destination === "vortex" && !vortexExecutable)
            }
            onClick={() => void sendSelected()}
          >
            {destination === "vortex"
              ? "Send selected to Vortex"
              : "Import selected to Review"}{" "}
            ({selectedEntries.length})
          </button>
          {batchRunning && (
            <button
              className={quiet}
              type="button"
              onClick={() => {
                stopBatchRef.current = true;
              }}
            >
              Stop after current
            </button>
          )}
          {(destination === "vortex" || handedOffIds.length > 0) && (
            <button
              className={quiet}
              type="button"
              disabled={locked || !onCheckInstalled}
              onClick={() => void checkInstalled()}
            >
              {checking ? "Checking files…" : "Check installed files"}
            </button>
          )}
          <button
            className={`${quiet} nexus-refresh`}
            type="button"
            disabled={search.running || locked}
            onClick={() => {
              setChecked({});
              setCandidateSelections({});
              onSearch({
                includeComplete,
                forceRefresh: true,
                retainIds: handedOffIds,
              });
            }}
          >
            Refresh search
          </button>
          {search.running && (
            <button className={quiet} type="button" onClick={onCancel}>
              Cancel search
            </button>
          )}
          <button
            className={quiet}
            type="button"
            disabled={locked}
            onClick={onConfigure}
          >
            Configure Nexus
          </button>
        </div>
        <small className="nexus-muted">
          {destination === "review"
            ? "Import into Review, check the text, then export explicitly to your Mods folder."
            : vortexExecutable
              ? "Install and deploy in Vortex, then check files here. Vortex uses its own account."
              : "Choose Vortex.exe in Nexus settings to enable handoff."}
        </small>
        {checkError && <p role="alert">{checkError}</p>}
      </div>
      <div className="nexus-dialog-body">
        <div className="nexus-search-strip">
          <label className="nexus-checkbox">
            <input
              type="checkbox"
              checked={includeComplete}
              disabled={locked || search.running}
              onChange={(event) => {
                const next = event.target.checked;
                setIncludeComplete(next);
                setChecked({});
                if (next)
                  onSearch({
                    includeComplete: true,
                    forceRefresh: false,
                    retainIds: handedOffIds,
                  });
              }}
            />{" "}
            Include fully translated mods for Collection curation
          </label>
          {latestSearch && (
            <small className="nexus-muted">
              Search data from {latestSearch}
              {search.entries.some(
                (entry) => entry.result?.cacheStatus === "cached",
              )
                ? " · cached"
                : ""}
            </small>
          )}
          <small role="status">
            {search.running
              ? "Searching…"
              : search.cancelled || search.stoppedReason
                ? "Partial search"
                : "Search complete"}{" "}
            · {search.completed}/{search.total} IDs checked ·{" "}
            {search.entries.filter((entry) => entry.error).length} failed ·{" "}
            {search.skippedComplete ?? 0} fully translated mod groups skipped
          </small>
        </div>
        {search.stoppedReason && <p role="alert">{search.stoppedReason}</p>}
        <table className="nexus-table" aria-label="Translation candidates">
          {tableHead}
          <tbody>{found.map(renderRow)}</tbody>
        </table>
        {!found.length && !search.running && (
          <p>No translation candidates found by this limited search.</p>
        )}
        {other.length > 0 && (
          <details>
            <summary>
              {other.length} mods without candidates / search errors
            </summary>
            <table
              className="nexus-table"
              aria-label="Mods without translation candidates"
            >
              <tbody>{other.map(renderRow)}</tbody>
            </table>
          </details>
        )}
        <details>
          <summary>
            Search scope · {search.noId} components without a Nexus ID
          </summary>
          <p>
            Limited candidate search; absence is not definitive. Search alone
            downloads nothing. No mod installation is performed.
          </p>
        </details>
      </div>
    </NexusModal>
  );
}
