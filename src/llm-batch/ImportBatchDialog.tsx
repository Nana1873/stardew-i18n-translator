import { FileSearch, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useDialogAccessibility } from "../dialogAccessibility";
import type { LlmImportPreflight } from "../tauri/commands";

interface ImportBatchDialogProps {
  targetName: string;
  targetLanguage: string;
  initialPath?: string | null;
  initialError?: string | null;
  onChooseFile: () => Promise<string | null>;
  onPreflight: (path: string) => Promise<LlmImportPreflight>;
  onImport: (path: string) => Promise<void>;
  canSwitchToMatchingMod?: (modUniqueId: string) => boolean;
  onSwitchToMatchingMod?: (modUniqueId: string) => void;
  onClose: () => void;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).at(-1) || path;
}

export function ImportBatchDialog({
  targetName,
  targetLanguage,
  initialPath = null,
  initialError = null,
  onChooseFile,
  onPreflight,
  onImport,
  canSwitchToMatchingMod,
  onSwitchToMatchingMod,
  onClose,
}: ImportBatchDialogProps) {
  const [path, setPath] = useState(initialPath);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [invalidSelection, setInvalidSelection] = useState(
    Boolean(initialError),
  );
  const [checking, setChecking] = useState(false);
  const [preflight, setPreflight] = useState<LlmImportPreflight | null>(null);
  const preflightRequest = useRef(0);
  const dialogRef = useRef<HTMLElement>(null);
  const { onDialogKeyDown } = useDialogAccessibility({
    dialogRef,
    onEscape: onClose,
    escapeDisabled: pending,
  });

  async function check(selectedPath: string) {
    const request = ++preflightRequest.current;
    setChecking(true);
    setPreflight(null);
    setError(null);
    try {
      const result = await onPreflight(selectedPath);
      if (request === preflightRequest.current) setPreflight(result);
    } catch (cause) {
      if (request === preflightRequest.current) setError(String(cause));
    } finally {
      if (request === preflightRequest.current) setChecking(false);
    }
  }

  useEffect(() => {
    if (
      !initialPath ||
      initialError ||
      !initialPath.toLowerCase().endsWith(".json")
    )
      return;
    void check(initialPath);
    // A changed selected component remounts this dialog from App via its key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    () => () => {
      preflightRequest.current += 1;
    },
    [],
  );

  async function choose() {
    setError(null);
    try {
      const chosen = await onChooseFile();
      if (chosen) {
        setPath(chosen);
        setPreflight(null);
        if (!chosen.toLocaleLowerCase("en").endsWith(".json")) {
          setInvalidSelection(true);
          setError(
            "Invalid file type. Exactly one JSON batch file is required.",
          );
        } else {
          setInvalidSelection(false);
          await check(chosen);
        }
      }
    } catch (cause) {
      setError(String(cause));
    }
  }

  async function confirm() {
    if (!path || pending || !preflight?.ready) return;
    setPending(true);
    setError(null);
    try {
      await onImport(path);
      onClose();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="translator-flow-overlay">
      <section
        ref={dialogRef}
        className="translator-flow-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="translator-import-title"
        aria-describedby="translator-import-description"
        onKeyDown={onDialogKeyDown}
      >
        <div className="translator-flow-head">
          <div>
            <h2 className="translator-heading" id="translator-import-title">
              Import LLM batch
            </h2>
            <div className="translator-kicker">
              Target: {targetName} · {targetLanguage}
            </div>
          </div>
          <button
            className="translator-icon-button"
            type="button"
            aria-label="Cancel import"
            onClick={onClose}
            disabled={pending}
          >
            <X aria-hidden />
          </button>
        </div>
        <div className="translator-flow-body">
          <p id="translator-import-description">
            Choose the translated JSON returned by your LLM. It must match this
            mod, {targetLanguage}, and the current English source.
          </p>
          <div
            className="translator-file-choice translator-drop-zone"
            data-import-valid={
              invalidSelection ? "false" : path ? "true" : undefined
            }
          >
            <span>
              <strong>{path ? fileName(path) : "No file selected"}</strong>
              <br />
              <code>
                {path ?? "*.llm-result.json or translated *.llm-batch.json"}
              </code>
            </span>
            <button
              className="translator-button translator-button-quiet"
              type="button"
              onClick={() => void choose()}
              disabled={pending}
            >
              <FileSearch aria-hidden /> Choose file …
            </button>
          </div>
          <div className="translator-flow-callout">
            Existing translations stay unchanged. Valid imported values go to
            Review.
          </div>
          {checking && (
            <div className="translator-flow-callout" role="status">
              Checking mod, language, source snapshot, keys, and protected
              tokens…
            </div>
          )}
          {preflight && (
            <div
              className={
                "translator-import-preflight" +
                (preflight.ready ? " is-ready" : " is-blocked")
              }
              aria-label="LLM import preflight"
            >
              <div className="translator-import-preflight-head">
                <strong>
                  {preflight.ready ? "Ready to import" : "Import blocked"}
                </strong>
                <span
                  className={
                    "translator-state " +
                    (preflight.ready ? "is-ready" : "is-change")
                  }
                >
                  {preflight.ready ? "Validated" : "No writes"}
                </span>
              </div>
              <dl className="translator-import-preflight-grid">
                <div>
                  <dt>Mod / component</dt>
                  <dd>
                    {preflight.modMatches
                      ? preflight.selectedModUniqueId
                      : `${preflight.batchModUniqueId} does not match ${preflight.selectedModUniqueId}`}
                  </dd>
                </div>
                <div>
                  <dt>Target language</dt>
                  <dd>
                    {preflight.batchTargetLang} ·{" "}
                    {preflight.languageMatches ? "matched" : "mismatch"}
                  </dd>
                </div>
                <div>
                  <dt>Source snapshot</dt>
                  <dd>{preflight.snapshotResult}</dd>
                </div>
                <div>
                  <dt>Strings supplied / matched</dt>
                  <dd>
                    {preflight.suppliedStrings} / {preflight.matchedStrings}
                  </dd>
                </div>
                <div>
                  <dt>Ready for Review</dt>
                  <dd>{preflight.importable}</dd>
                </div>
                <div>
                  <dt>Local translations preserved</dt>
                  <dd>{preflight.preservedLocal}</dd>
                </div>
                <div>
                  <dt>Empty values skipped</dt>
                  <dd>{preflight.skippedEmpty}</dd>
                </div>
                <div>
                  <dt>Identical to source</dt>
                  <dd>{preflight.identicalToSource}</dd>
                </div>
              </dl>
              {preflight.protectedTokenIssues.length > 0 && (
                <details className="translator-result-help">
                  <summary>
                    {preflight.protectedTokenIssues.length} protected-token{" "}
                    {preflight.protectedTokenIssues.length === 1
                      ? "issue"
                      : "issues"}
                  </summary>
                  <ul className="translator-import-preflight-issues">
                    {preflight.protectedTokenIssues.map((issue) => (
                      <li key={`${issue.relativeDir}\0${issue.key}`}>
                        <code>
                          {issue.relativeDir} / {issue.key}
                        </code>
                        <span>
                          {issue.differences
                            .map(
                              (difference) =>
                                `${difference.token}: source ${difference.sourceCount}, import ${difference.targetCount}`,
                            )
                            .join(" · ")}
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {preflight.blockingReason && (
                <div className="translator-flow-callout is-error" role="alert">
                  {preflight.blockingReason}
                </div>
              )}
              {!preflight.modMatches &&
                onSwitchToMatchingMod &&
                (canSwitchToMatchingMod?.(preflight.batchModUniqueId) ??
                  true) && (
                  <button
                    className="translator-button translator-button-quiet"
                    type="button"
                    onClick={() =>
                      onSwitchToMatchingMod(preflight.batchModUniqueId)
                    }
                  >
                    Switch to matching mod
                  </button>
                )}
            </div>
          )}
          {error && (
            <div className="translator-flow-callout is-error" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="translator-flow-foot">
          <button
            className="translator-button translator-button-quiet"
            type="button"
            onClick={onClose}
            disabled={pending}
          >
            Cancel
          </button>
          <button
            className="translator-button translator-button-primary"
            type="button"
            disabled={
              !path ||
              invalidSelection ||
              pending ||
              checking ||
              !preflight?.ready
            }
            onClick={() => void confirm()}
          >
            {pending ? "Importing…" : checking ? "Checking…" : "Import file"}
          </button>
        </div>
      </section>
    </div>
  );
}
