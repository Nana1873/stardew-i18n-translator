/**
 * Batch local-AI translation dialog — M6 / Issue 17 (SPEC §17 M6).
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
import { useEffect, useRef, useState } from "react";
import type { TranslationResult } from "../tauri/commands";

/** One string of a batch run. Captured when the batch starts; the identifying
 * fields (key/file/source) are immutable for the table's lifetime. */
export interface BatchItem {
  /** The row's index into the table's data array. */
  index: number;
  key: string;
  file: string;
  source: string;
  section?: string | null;
}

interface BatchTranslateDialogProps {
  items: BatchItem[];
  modName: string;
  onTranslate: (
    source: string,
    section?: string | null,
  ) => Promise<TranslationResult>;
  /** Persist one finished translation (as review-needed) and update the row. */
  onResult: (item: BatchItem, text: string) => Promise<void>;
  onClose: () => void;
}

export function BatchTranslateDialog({
  items,
  modName,
  onTranslate,
  onResult,
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
  const [cancelRequested, setCancelRequested] = useState(false);
  const cancelRef = useRef(false);

  // The run is bound to the dialog's lifetime: one serial pass over the items
  // captured at open. Unmount (or cancel) stops after the in-flight string.
  useEffect(() => {
    let active = true;
    (async () => {
      for (const item of items) {
        if (!active || cancelRef.current) break;
        setCurrentKey(item.key);
        try {
          const result = await onTranslate(item.source, item.section);
          await onResult(item, result.text);
          if (!active) return;
          setDone((count) => count + 1);
          if (result.missingTokens.length > 0) {
            setFlaggedKeys((keys) => [...keys, item.key]);
          }
          if (result.glossaryMisses.length > 0) {
            setGlossaryMissCount((count) => count + 1);
          }
        } catch (cause) {
          if (active) setError(String(cause));
          break;
        }
      }
      if (active) {
        setCurrentKey(null);
        setFinished(true);
      }
    })();
    return () => {
      active = false;
    };
    // Deliberately run once per dialog open; items are a snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function cancel() {
    cancelRef.current = true;
    setCancelRequested(true);
  }

  const total = items.length;
  const running = !finished;
  const stopped = finished && (cancelRequested || error !== null);

  return (
    <div className="editor__backdrop">
      <div
        className="exportdlg"
        role="dialog"
        aria-modal="true"
        aria-label="Batch AI translation"
      >
        <div className="exportdlg__head">
          <strong>
            {running
              ? cancelRequested
                ? "Cancelling…"
                : "Translating with local AI…"
              : error
                ? "Batch translation failed"
                : cancelRequested
                  ? "Batch translation cancelled"
                  : "Batch translation complete"}
          </strong>
          <span className="editor__crumbs">{modName}</span>
        </div>

        <div className="exportdlg__body">
          <p>
            <strong>{done}</strong> / {total} translated
            {running && currentKey && (
              <span className="exportdlg__muted">
                {" "}
                — <code>{currentKey}</code>
              </span>
            )}
          </p>
          <div
            className="batchdlg__bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={done}
          >
            <div
              className="batchdlg__fill"
              style={{ width: `${total > 0 ? (done / total) * 100 : 0}%` }}
            />
          </div>

          {error && <p className="exportdlg__error">{error}</p>}
          {stopped && done < total && (
            <p className="exportdlg__muted">
              {done} finished {done === 1 ? "string is" : "strings are"} saved
              as “Needs review”. Re-run later to continue with the remaining{" "}
              {total - done}.
            </p>
          )}
          {!running && !error && !cancelRequested && (
            <p className="exportdlg__muted">
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

        <div className="exportdlg__foot">
          {running ? (
            <button type="button" onClick={cancel} disabled={cancelRequested}>
              {cancelRequested ? "Finishing current string…" : "Cancel"}
            </button>
          ) : (
            <button type="button" onClick={onClose} autoFocus>
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
