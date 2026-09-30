import { useEffect, useRef, useState } from "react";
import { useDialogAccessibility } from "../dialogAccessibility";
import type { ScannedMod } from "../tauri/commands";
import {
  paraTranzConnection,
  paraTranzImport,
  paraTranzPreview,
  paraTranzUpload,
  type ParaTranzConnection,
  type ParaTranzPreview,
} from "./commands";

export function ParaTranzDialog({
  mod,
  onClose,
  onImported,
  onSettings,
}: {
  mod: ScannedMod;
  onClose: () => void;
  onImported: () => Promise<void>;
  onSettings: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const [connection, setConnection] = useState<ParaTranzConnection | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [mapping, setMapping] = useState<Record<string, number | null>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<ParaTranzPreview | null>(null);
  const [confirmUpload, setConfirmUpload] = useState(false);
  const { onDialogKeyDown } = useDialogAccessibility({
    dialogRef,
    onEscape: onClose,
    escapeDisabled: pending,
  });
  useEffect(() => {
    let current = true;
    void paraTranzConnection()
      .then((value) => {
        if (current) setConnection(value);
      })
      .catch((cause) => {
        if (current) setError(String(cause));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, []);
  const bindings = mod.i18nFiles.map((file) => ({
    relativeDir: file.relativeDir,
    fileId: mapping[file.relativeDir] ?? null,
  }));
  async function action(kind: "pull" | "upload" | "import") {
    setPending(true);
    setError(null);
    setMessage(null);
    try {
      if (kind === "pull") {
        setPreview(null);
        setPreview(await paraTranzPreview(mod.uniqueId, bindings));
      }
      if (kind === "upload") {
        setPreview(null);
        const files = await paraTranzUpload(mod.uniqueId, bindings);
        setMapping(
          Object.fromEntries(
            bindings.map((binding, index) => [
              binding.relativeDir,
              files[index].id,
            ]),
          ),
        );
        setConnection(await paraTranzConnection());
        setMessage(
          `Sources uploaded: ${files.length} file(s). Remote translations were preserved.`,
        );
        setConfirmUpload(false);
      }
      if (kind === "import" && preview) {
        const result = await paraTranzImport(preview.previewId);
        setPreview(null);
        setMessage(
          `Imported ${result.imported} into Review; preserved ${result.skippedTranslated} local translation(s).`,
        );
        await onImported();
      }
    } catch (cause) {
      if (kind === "import") setPreview(null);
      setError(String(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="translator-flow-overlay">
      <section
        className="translator-flow-dialog paratranz-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="ParaTranz collaboration"
        ref={dialogRef}
        onKeyDown={onDialogKeyDown}
      >
        <header className="translator-flow-head">
          <h2>ParaTranz · {mod.name}</h2>
        </header>
        <div className="translator-flow-body">
          {loading && <p role="status">Loading ParaTranz connection…</p>}
          {!loading && !connection && (
            <>
              <p>
                ParaTranz is optional. Set up a project and a session token in
                Settings first.
              </p>
              <button
                type="button"
                className="translator-button"
                onClick={onSettings}
              >
                Set up ParaTranz
              </button>
            </>
          )}
          {connection && (
            <>
              <p>
                {connection.project.name} · {connection.project.source} →{" "}
                {connection.project.dest} ·{" "}
                {connection.project.privacy === 2
                  ? "Private"
                  : "Public or internal"}
              </p>
              <div className="paratranz-fields">
                {mod.i18nFiles.map((file) => (
                  <label key={file.relativeDir}>
                    {file.relativeDir}
                    <select
                      aria-label={`ParaTranz file for ${file.relativeDir}`}
                      value={mapping[file.relativeDir] ?? ""}
                      disabled={pending}
                      onChange={(event) => {
                        setMapping({
                          ...mapping,
                          [file.relativeDir]: event.target.value
                            ? Number(event.target.value)
                            : null,
                        });
                        setPreview(null);
                        setConfirmUpload(false);
                        setMessage(null);
                      }}
                    >
                      <option value="">
                        Create a new source file on upload
                      </option>
                      {connection.files.map((remote) => (
                        <option key={remote.id} value={remote.id}>
                          {remote.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
              <p>
                Existing files must have the same English sources and keys.
                Local translations stay unchanged. Remote review stages do not
                mark local text Done.
              </p>
              <div className="paratranz-actions">
                <button
                  type="button"
                  className="translator-button"
                  disabled={
                    pending || bindings.some((binding) => !binding.fileId)
                  }
                  onClick={() => void action("pull")}
                >
                  Pull translations
                </button>
                <button
                  type="button"
                  className="translator-button translator-button-quiet"
                  disabled={pending}
                  onClick={() => {
                    setConfirmUpload(true);
                    setPreview(null);
                  }}
                >
                  Upload English sources…
                </button>
              </div>
              {confirmUpload && (
                <div
                  className="translator-flow-callout"
                  aria-label="ParaTranz upload confirmation"
                >
                  <p>
                    Send {mod.totalKeys} English source strings to{" "}
                    {connection.project.name}? Existing remote translations stay
                    intact. No entries are deleted.
                  </p>
                  <button
                    type="button"
                    className="translator-button"
                    disabled={pending}
                    onClick={() => void action("upload")}
                  >
                    Upload sources
                  </button>
                  <button
                    type="button"
                    className="translator-button translator-button-quiet"
                    disabled={pending}
                    onClick={() => setConfirmUpload(false)}
                  >
                    Cancel upload
                  </button>
                </div>
              )}
              {preview && (
                <div
                  className="translator-import-preflight"
                  aria-label="ParaTranz import preview"
                >
                  <strong>
                    {preview.preflight.ready
                      ? "Ready to import"
                      : "Import blocked"}
                  </strong>
                  <p>
                    Ready for Review: {preview.preflight.importable} · Local
                    translations preserved: {preview.preflight.preservedLocal} ·
                    Empty or excluded values: {preview.preflight.skippedEmpty}
                  </p>
                  {preview.preflight.blockingReason && (
                    <p>{preview.preflight.blockingReason}</p>
                  )}
                  <button
                    type="button"
                    className="translator-button"
                    disabled={pending || !preview.preflight.ready}
                    onClick={() => void action("import")}
                  >
                    Import into Review
                  </button>
                </div>
              )}
            </>
          )}
          {pending && <p role="status">Working with ParaTranz…</p>}
          {message && <p role="status">{message}</p>}
          {error && <p role="alert">{error}</p>}
        </div>
        <footer className="translator-flow-foot">
          <button
            type="button"
            className="translator-button translator-button-quiet"
            disabled={pending}
            onClick={onClose}
          >
            Close ParaTranz
          </button>
        </footer>
      </section>
    </div>
  );
}
