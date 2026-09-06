import { useEffect, useState, type ReactNode } from "react";
import {
  listCommunityLibrary,
  buildPrivateOutput,
  pickTranslationZipDestination,
  openFolder,
  openUrl,
  type CommunityLibraryEntry,
  type ScannedMod,
  type ZipBuildOutcome,
} from "../tauri/commands";
import { ModList } from "../mods/ModList";
import { ManualTranslationImport } from "./ManualTranslationImport";

export function TranslationLibrary({
  mods,
  selectedId,
  onSelect,
  onOpenMod,
  language,
  revision,
  context,
  nexusOpen,
  onShowLibrary,
  onShowNexus,
  nexusPanel,
  busy,
  onBusy,
  onImported,
}: {
  mods: ScannedMod[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpenMod: (id: string) => void;
  language: string;
  revision: number;
  context: string;
  nexusOpen: boolean;
  onShowLibrary: () => void;
  onShowNexus: () => void;
  nexusPanel: ReactNode;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onImported: () => Promise<void>;
}) {
  const [entries, setEntries] = useState<CommunityLibraryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [output, setOutput] = useState<ZipBuildOutcome | null>(null);
  const [overwrite, setOverwrite] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    setEntries([]);
    setError(null);
    setOutput(null);
    void listCommunityLibrary()
      .then((result) => {
        if (current) setEntries(result);
      })
      .catch((cause) => {
        if (current) setError(String(cause));
      });
    return () => {
      current = false;
    };
  }, [context, revision]);
  async function build(destination?: string) {
    setBuilding(true);
    onBusy(true);
    setError(null);
    try {
      const path =
        destination ??
        (await pickTranslationZipDestination("Stardew Translator Output.zip"));
      if (!path) return;
      try {
        setOutput(await buildPrivateOutput(path, Boolean(destination)));
        setOverwrite(null);
      } catch (cause) {
        if (String(cause).includes("OVERWRITE_REQUIRED")) setOverwrite(path);
        else throw cause;
      }
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBuilding(false);
      onBusy(false);
    }
  }
  return (
    <main className="translation-library-overview" aria-label="Overview">
      <section
        className="panel translation-library-mods"
        aria-label="Overview mods"
      >
        <div className="panel__header">
          <strong>Mods · {mods.length}</strong>
        </div>
        <ModList
          mods={mods}
          selectedId={selectedId}
          onSelect={(id) => {
            if (!building && !busy) onSelect(id);
          }}
        />
        {selectedId && (
          <button
            className="translator-button translator-button-primary"
            disabled={busy || building}
            onClick={() => onOpenMod(selectedId)}
          >
            Open Workspace
          </button>
        )}
      </section>
      <section
        className="panel translation-library-pane"
        aria-label="Translation library"
      >
        <div className="panel__header translation-library-tabs">
          <button
            className="translator-button translator-button-quiet"
            aria-pressed={!nexusOpen}
            onClick={onShowLibrary}
          >
            Translations
          </button>
          <button
            className="translator-button translator-button-quiet"
            aria-pressed={nexusOpen}
            onClick={onShowNexus}
          >
            Nexus results
          </button>
        </div>
        <ManualTranslationImport
          mod={mods.find((mod) => mod.uniqueId === selectedId)}
          language={language}
          context={context}
          disabled={busy || building}
          onImported={onImported}
          onBusy={onBusy}
        />
        {nexusOpen ? (
          nexusPanel
        ) : (
          <div className="translation-library-content">
            <p className="translation-library-muted">
              Community library · {language} · current Mods folder
            </p>
            {entries.length === 0 && (
              <p>
                No translations imported yet. Local editing and export remain
                available.
              </p>
            )}
            {entries.map((entry, index) => (
              <article
                key={`${entry.modUniqueId}:${entry.relativeDir}:${index}`}
                className={`translation-library-entry${entry.modUniqueId === selectedId ? " is-selected" : ""}`}
              >
                <button
                  className="translator-button translator-button-quiet"
                  disabled={
                    !mods.some((mod) => mod.uniqueId === entry.modUniqueId) ||
                    busy ||
                    building
                  }
                  onClick={() => onOpenMod(entry.modUniqueId)}
                >
                  {mods.find((mod) => mod.uniqueId === entry.modUniqueId)
                    ?.name ?? entry.modUniqueId}
                </button>
                <span>
                  {entry.strings} library strings · {entry.relativeDir}
                </span>
                <small>Imported locally · deployment unverified</small>
                <details>
                  <summary>Source details</summary>
                  <p>{entry.archivePath}</p>
                  {entry.sourceUrl && (
                    <button
                      className="translator-button translator-button-quiet"
                      onClick={() =>
                        void openUrl(entry.sourceUrl!).catch((cause) =>
                          setError(String(cause)),
                        )
                      }
                    >
                      Open source page
                    </button>
                  )}
                </details>
              </article>
            ))}
          </div>
        )}
        <footer className="translation-library-output">
          <button
            className="translator-button translator-button-primary"
            disabled={busy || building || !mods.length}
            onClick={() => void build()}
          >
            {building ? "Building output…" : "Build Stardew Translator Output"}
          </button>
          <small>
            Prototype: library-mapped components in this Mods folder. Save the
            combined ZIP, then import it manually in Vortex; deployment is
            unverified. Folder export and package ZIPs remain available.
          </small>
          {overwrite && (
            <div role="alert">
              This ZIP already exists.{" "}
              <button
                className="translator-button translator-button-quiet"
                disabled={building}
                onClick={() => void build(overwrite)}
              >
                Replace ZIP
              </button>
              <button
                className="translator-button translator-button-quiet"
                disabled={building}
                onClick={() => setOverwrite(null)}
              >
                Cancel
              </button>
            </div>
          )}
          {output && (
            <p role="status">
              Created {output.fileName} · {output.entries} files ·{" "}
              {output.strings} strings{" "}
              <button
                className="translator-button translator-button-quiet"
                onClick={() =>
                  void openFolder(output.folder).catch((cause) =>
                    setError(String(cause)),
                  )
                }
              >
                Open output folder
              </button>
            </p>
          )}
          {error && <p role="alert">{error}</p>}
        </footer>
      </section>
    </main>
  );
}
