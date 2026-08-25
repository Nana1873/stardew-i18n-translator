/**
 * Batch local-AI translation dialog (SPEC §17).
 *
 * Translates the given strings serially via the local LLM (the local GPU is
 * the bottleneck — no concurrency), saving each result immediately as
 * `review-needed` through `onResult`. Because every finished string is
 * persisted before the next request starts, the run is resume-friendly:
 * cancelling (or a crash/server failure) keeps all completed work, and
 * re-running only picks up strings that are still untranslated/outdated.
 *
 * Cancel finishes the in-flight string, then stops — never mid-save. A server
 * error aborts the run and shows the partial summary.
 */
import {
  type CSSProperties,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Sparkles, X } from "lucide-react";
import { useDialogAccessibility } from "../dialogAccessibility";
import type { TranslationResult } from "../tauri/commands";

/** One string of a batch run. Captured when the batch starts; the identifying
 * fields (key/file/source) are immutable for the table's lifetime. */
export interface BatchItem {
  /** The row's index into the table's data array. */
  index: number;
  key: string;
  file: string;
  source: string;
  status: "untranslated" | "outdated";
  section?: string | null;
}

export interface BatchFinishedResult {
  done: number;
  total: number;
  outcome: "complete" | "cancelled" | "error";
  error?: string;
}

interface BatchTranslateDialogProps {
  items: BatchItem[];
  modName: string;
  scopeSummary: string;
  targetLanguageLabel?: string;
  includeOpen: boolean;
  includeChanged: boolean;
  onIncludeOpenChange: (include: boolean) => void;
  onIncludeChangedChange: (include: boolean) => void;
  translationReady?: boolean;
  translationUnavailableReason?: string;
  onTranslate: (
    source: string,
    section?: string | null,
  ) => Promise<TranslationResult>;
  /** Persist one finished translation (as review-needed) and update the row. */
  onResult: (item: BatchItem, text: string) => Promise<void>;
  onFinished: (result: BatchFinishedResult) => void;
  onClose: () => void;
}

export function BatchTranslateDialog({
  items,
  modName,
  scopeSummary,
  targetLanguageLabel,
  includeOpen,
  includeChanged,
  onIncludeOpenChange,
  onIncludeChangedChange,
  translationReady = true,
  translationUnavailableReason = "This engine is not ready; check its status in Settings first.",
  onTranslate,
  onResult,
  onFinished,
  onClose,
}: BatchTranslateDialogProps) {
  const [done, setDone] = useState(0);
  const [currentKey, setCurrentKey] = useState<string | null>(null);
  /** Keys whose result still misses a protected token (needs a manual fix). */
  const [flaggedKeys, setFlaggedKeys] = useState<string[]>([]);
  /** Strings whose result possibly ignored injected glossary terms (soft). */
  const [glossaryMissCount, setGlossaryMissCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const [outcome, setOutcome] = useState<BatchFinishedResult["outcome"] | null>(
    null,
  );
  const [cancelRequested, setCancelRequested] = useState(false);
  const [started, setStarted] = useState(false);
  const cancelRef = useRef(false);
  const dialogRef = useRef<HTMLElement>(null);
  const runItemsRef = useRef<BatchItem[]>([]);
  const finishedReportedRef = useRef(false);
  const eligibleItems = useMemo(
    () =>
      items.filter(
        (item) =>
          (includeOpen && item.status === "untranslated") ||
          (includeChanged && item.status === "outdated"),
      ),
    [includeChanged, includeOpen, items],
  );

  const { focusInitial, onDialogKeyDown } = useDialogAccessibility({
    dialogRef,
    onEscape: () => {
      if (started && !finished) cancel();
      else onClose();
    },
  });

  useEffect(() => {
    const frame = requestAnimationFrame(focusInitial);
    return () => cancelAnimationFrame(frame);
  }, [finished, focusInitial, started]);

  // The run is bound to the dialog's lifetime: one serial pass over the items
  // captured at open. Unmount (or cancel) stops after the in-flight string.
  useEffect(() => {
    if (!started) return;
    let active = true;
    (async () => {
      let completed = 0;
      let failure: string | null = null;
      const runItems = runItemsRef.current;
      for (const item of runItems) {
        if (!active || cancelRef.current) break;
        setCurrentKey(item.key);
        try {
          const result = await onTranslate(item.source, item.section);
          await onResult(item, result.text);
          if (!active) return;
          completed += 1;
          setDone((count) => count + 1);
          if (result.missingTokens.length > 0) {
            setFlaggedKeys((keys) => [...keys, item.key]);
          }
          if (result.glossaryMisses.length > 0) {
            setGlossaryMissCount((count) => count + 1);
          }
        } catch (cause) {
          failure = String(cause);
          if (active) setError(failure);
          break;
        }
      }
      if (active) {
        const finalOutcome: BatchFinishedResult["outcome"] = failure
          ? "error"
          : completed === runItems.length
            ? "complete"
            : "cancelled";
        setCurrentKey(null);
        setOutcome(finalOutcome);
        setFinished(true);
        if (!finishedReportedRef.current) {
          finishedReportedRef.current = true;
          onFinished({
            done: completed,
            total: runItems.length,
            outcome: finalOutcome,
            ...(failure ? { error: failure } : {}),
          });
        }
      }
    })();
    return () => {
      active = false;
    };
    // Deliberately run once per dialog open; items are a snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started]);

  function cancel() {
    cancelRef.current = true;
    setCancelRequested(true);
  }

  function start() {
    if (eligibleItems.length === 0 || !translationReady) return;
    runItemsRef.current = eligibleItems;
    setStarted(true);
  }

  const total = started ? runItemsRef.current.length : eligibleItems.length;
  const running = started && !finished;
  const stopped = finished && outcome !== "complete";
  const progress = total > 0 ? Math.round((done / total) * 100) : 0;

  if (!started) {
    return (
      <div className="stv3-flow-overlay">
        <section
          ref={dialogRef}
          className="stv3-flow-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="Translate with AI"
          onKeyDown={onDialogKeyDown}
        >
          <div className="stv3-flow-head">
            <div>
              <h2 className="stv3-heading">Translate with AI</h2>
              <div className="stv3-kicker">
                Every suggestion enters Review; nothing becomes Done
                automatically
              </div>
            </div>
            <button
              className="stv3-icon-button"
              type="button"
              aria-label="Cancel AI translation"
              onClick={onClose}
            >
              <X aria-hidden />
            </button>
          </div>
          <div className="stv3-flow-body">
            <div className="stv3-flow-fields">
              <label className="stv3-flow-field">
                Engine
                <select defaultValue="local">
                  <option value="local">Local AI</option>
                  <option value="codex" disabled>
                    Codex CLI · Unavailable
                  </option>
                  <option value="api" disabled>
                    OpenAI API · Unavailable
                  </option>
                </select>
              </label>
              <label className="stv3-flow-field">
                Scope
                <select defaultValue="selected">
                  <option value="selected">Selected strings</option>
                  <option value="component" disabled>
                    Current mod · Unavailable
                  </option>
                  <option value="package" disabled>
                    Current package · Unavailable
                  </option>
                </select>
              </label>
            </div>
            <div className="stv3-settings-group">
              <label className="stv3-setting-line">
                <span className="stv3-setting-copy">
                  <strong>Open</strong>
                  <span>
                    No{" "}
                    {targetLanguageLabel?.split(" (")[0] ?? "target-language"}{" "}
                    value yet
                  </span>
                </span>
                <input
                  type="checkbox"
                  checked={includeOpen}
                  onChange={(event) =>
                    onIncludeOpenChange(event.target.checked)
                  }
                />
              </label>
              <label className="stv3-setting-line">
                <span className="stv3-setting-copy">
                  <strong>Changed</strong>
                  <span>English source changed since translation</span>
                </span>
                <input
                  type="checkbox"
                  checked={includeChanged}
                  onChange={(event) =>
                    onIncludeChangedChange(event.target.checked)
                  }
                />
              </label>
            </div>
            <div className="stv3-ai-count">
              <span>
                <span>Exact scope after status filters</span>
                <small className="stv3-kicker">{scopeSummary}</small>
              </span>
              <strong>{eligibleItems.length} strings</strong>
            </div>
            <div
              className="stv3-flow-callout"
              role={translationReady ? undefined : "alert"}
            >
              Local AI stays on this computer. Suggestions are validated and
              queued for Review.
              {!translationReady && " " + translationUnavailableReason}
            </div>
            <div className="stv3-kicker">
              External LLM batch remains a separate file export/import workflow.
            </div>
          </div>
          <div className="stv3-flow-foot">
            <button
              className="stv3-button stv3-button-quiet"
              type="button"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              className="stv3-button stv3-button-primary"
              type="button"
              onClick={start}
              disabled={eligibleItems.length === 0 || !translationReady}
              title={
                translationReady
                  ? undefined
                  : "Configure or check this translation engine in Settings first."
              }
            >
              <Sparkles aria-hidden /> Start AI translation
            </button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="stv3-flow-overlay">
      <section
        ref={dialogRef}
        className="exportdlg stv3-flow-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Batch AI translation"
        onKeyDown={onDialogKeyDown}
      >
        <div className="exportdlg__head stv3-flow-head">
          <div>
            <h2 className="stv3-heading">
              {running
                ? cancelRequested
                  ? "Cancelling…"
                  : "Translating with local AI…"
                : outcome === "error"
                  ? "Batch translation failed"
                  : outcome === "cancelled"
                    ? "Batch translation cancelled"
                    : "Batch translation complete"}
            </h2>
            <span className="stv3-kicker">
              Completed suggestions are saved to Review immediately · {modName}
            </span>
          </div>
        </div>

        <div className="exportdlg__body stv3-flow-body">
          <p>
            <strong>{done}</strong> / {total} translated
            {running && currentKey && (
              <span className="exportdlg__muted">
                {" "}
                — <code>{currentKey}</code>
              </span>
            )}
          </p>
          <div className="stv3-progress-row">
            <span
              role="progressbar"
              aria-label="AI translation progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress}
              style={
                {
                  "--stv3-batch-progress": `${progress}%`,
                } as CSSProperties
              }
            />
          </div>

          {error && (
            <div className="stv3-flow-callout is-error" role="alert">
              {error}
            </div>
          )}
          {running && (
            <div className="stv3-flow-callout">
              Cancel finishes the current string, then stops before the next
              one. Already completed suggestions remain saved in Review.
            </div>
          )}
          {stopped && done < total && (
            <p className="exportdlg__muted stv3-flow-callout">
              {done} finished {done === 1 ? "string is" : "strings are"} saved
              as “Needs review”. Re-run later to continue with the remaining{" "}
              {total - done}.
            </p>
          )}
          {!running && outcome === "complete" && (
            <p className="exportdlg__muted stv3-flow-callout">
              All results are saved as “Needs review” — confirm each one with an
              explicit Save in the editor.
            </p>
          )}

          {(flaggedKeys.length > 0 || glossaryMissCount > 0) && (
            <ul className="exportdlg__stats">
              {flaggedKeys.length > 0 && (
                <li>
                  <span className="exportdlg__dot exportdlg__dot--err" />{" "}
                  Dropped protected tokens (fix manually): {flaggedKeys.length}
                </li>
              )}
              {glossaryMissCount > 0 && (
                <li>
                  <span className="exportdlg__dot exportdlg__dot--warn" />{" "}
                  Possibly ignored glossary terms: {glossaryMissCount}
                </li>
              )}
            </ul>
          )}

          {flaggedKeys.length > 0 && (
            <div className="exportdlg__skipped">
              <span className="exportdlg__muted">Token problems:</span>
              <ul>
                {flaggedKeys.map((key) => (
                  <li key={key}>
                    <code>{key}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="exportdlg__foot stv3-flow-foot">
          {running ? (
            <button
              className="stv3-button stv3-button-quiet"
              type="button"
              onClick={cancel}
              disabled={cancelRequested}
            >
              {cancelRequested ? "Finishing current string…" : "Cancel"}
            </button>
          ) : (
            <button
              className="stv3-button stv3-button-primary"
              type="button"
              onClick={onClose}
              autoFocus
            >
              Close
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
