import { useEffect, useRef, useState } from "react";
import {
  nexusPickArchive,
  nexusPreflightImport,
  nexusImportTranslation,
  type NexusImportRequest,
  type ScannedMod,
} from "../tauri/commands";

export function ManualTranslationImport({
  mod,
  language,
  context,
  disabled,
  onImported,
  onBusy,
}: {
  mod: ScannedMod | undefined;
  language: string;
  context: string;
  disabled: boolean;
  onImported: () => Promise<void>;
  onBusy: (busy: boolean) => void;
}) {
  const [choices, setChoices] = useState<NexusImportRequest[]>([]);
  const [selection, setSelection] = useState(0);
  const [message, setMessage] = useState("");
  const [running, setRunning] = useState(false);
  const currentContext = useRef(context);
  currentContext.current = context;
  useEffect(() => {
    setChoices([]);
    setMessage("");
  }, [context, mod?.uniqueId]);
  async function save(request: NexusImportRequest, stamp: string) {
    if (currentContext.current !== stamp) return;
    await nexusPreflightImport(request);
    if (currentContext.current !== stamp) return;
    const result = await nexusImportTranslation(request);
    if (currentContext.current !== stamp) return;
    setChoices([]);
    setMessage(
      `Saved to translation library. ${result.imported} strings added to Review; ${result.conflicts} existing values kept.`,
    );
    await onImported();
  }
  async function run(pick: boolean) {
    if (!mod || running || disabled) return;
    const stamp = context;
    setRunning(true);
    onBusy(true);
    setMessage("");
    try {
      if (!pick) {
        await save(choices[selection], stamp);
        return;
      }
      const archive = await nexusPickArchive();
      if (!archive || currentContext.current !== stamp) return;
      const options = archive.files.flatMap((file) => {
        if (
          file.manifestUniqueId &&
          file.manifestUniqueId.toLowerCase() !== mod.uniqueId.toLowerCase()
        )
          return [];
        if (
          !file.path
            .toLowerCase()
            .endsWith(`/${language.toLowerCase()}.json`) &&
          file.path.toLowerCase() !== `${language.toLowerCase()}.json`
        )
          return [];
        return mod.i18nFiles.map((directory) => ({
          archiveId: archive.archiveId,
          archivePath: file.path,
          modUniqueId: mod.uniqueId,
          relativeDir: directory.relativeDir,
          communityLibrary: true,
        }));
      });
      if (options.length === 1) await save(options[0], stamp);
      else if (options.length) {
        setChoices(options);
        setSelection(0);
      } else
        setMessage(
          `No ${language}.json file matches this selected component. Choose the matching mod or a locale ZIP. Default-language files are not imported automatically.`,
        );
    } catch (cause) {
      if (currentContext.current === stamp) setMessage(String(cause));
    } finally {
      setRunning(false);
      onBusy(false);
    }
  }
  return (
    <div className="translation-library-manual">
      <button
        className="translator-button translator-button-quiet"
        disabled={!mod || running || disabled}
        onClick={() => void run(true)}
      >
        {running ? "Importing…" : "Import downloaded ZIP"}
      </button>
      <small>
        {mod
          ? `Into ${mod.name} · ${language}`
          : "Select a mod for a manual translation import."}
      </small>
      {choices.length > 0 && (
        <div>
          <label>
            Translation file and component{" "}
            <select
              value={selection}
              disabled={running || disabled}
              onChange={(event) => setSelection(Number(event.target.value))}
            >
              {choices.map((choice, index) => (
                <option key={index} value={index}>
                  {choice.archivePath} → {choice.relativeDir}
                </option>
              ))}
            </select>
          </label>
          <button
            className="translator-button translator-button-primary"
            disabled={running || disabled}
            onClick={() => void run(false)}
          >
            Import selected translation
          </button>
        </div>
      )}
      {message && <p role="status">{message}</p>}
    </div>
  );
}
