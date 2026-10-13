/**
 * Glossary status and build controls, shared by Settings and the setup.
 */
import { type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { type GlossaryStatus } from "../tauri/commands";
import { TARGET_LANGUAGES, gameSupportsLanguage } from "../languages";

const englishNumberFormat = new Intl.NumberFormat("en-US");

export function GlossarySettings({
  active,
  targetLang,
  glossary,
  building,
  error,
  onBuild,
  heading,
}: {
  active: boolean;
  targetLang: string;
  glossary: GlossaryStatus | null;
  building: boolean;
  error: string | null;
  onBuild: () => void;
  /** Replaces the Settings page heading and makes the panel a plain section,
   *  for the setup's glossary step. */
  heading?: ReactNode;
}) {
  const supported = Boolean(targetLang && gameSupportsLanguage(targetLang));
  const cached = glossary?.cached ?? null;
  const available = Boolean(
    glossary?.sourceAvailable && (supported || glossary.packAvailable),
  );
  const usableCache = Boolean(cached && !glossary?.outdatedCache);
  const canBuild = Boolean(
    targetLang &&
    glossary &&
    available &&
    (supported || glossary.packAvailable),
  );
  const state = !glossary
    ? "Checking glossary sources"
    : glossary.outdatedCache
      ? "Glossary needs an update"
      : cached
        ? available
          ? "Glossary is up to date"
          : "Glossary ready"
        : canBuild
          ? "Glossary can be built"
          : "Glossary unavailable";
  const summaryTone =
    cached && !glossary?.outdatedCache
      ? " is-ready"
      : glossary && (glossary.outdatedCache || canBuild)
        ? " is-actionable"
        : "";
  const source = !glossary
    ? "Checking your game files"
    : available && !supported && glossary.packAvailable
      ? "Installed community language pack" +
        (glossary.packName ? " · " + glossary.packName : "")
      : available
        ? "From your game files (read only)"
        : "Unavailable";
  const language =
    TARGET_LANGUAGES.find((candidate) => candidate.code === targetLang)
      ?.label ??
    (targetLang || "No target language");

  return (
    <section
      id={heading ? undefined : "settings-panel-glossary"}
      className={"translator-settings-page" + (active ? " is-active" : "")}
      role={heading ? undefined : "tabpanel"}
      aria-label="Glossary"
      hidden={!active}
    >
      {heading ?? (
        <>
          <h3>Glossary</h3>
          <p className="translator-settings-intro">
            Optional hints with the game&apos;s official names for items,
            characters and places. The glossary does not translate ordinary
            text.
          </p>
        </>
      )}
      <div className={"translator-glossary-summary" + summaryTone}>
        <div className="translator-glossary-main">
          <strong>{state}</strong>
          <span>{language}</span>
          {state === "Glossary unavailable" && (
            <span>Translation works without a glossary.</span>
          )}
        </div>
        <div className="translator-glossary-number">
          <strong>
            {cached ? englishNumberFormat.format(cached.termCount) : "—"}
          </strong>
          <span>
            {cached
              ? cached.termCount === 1
                ? "name"
                : "names"
              : "no names yet"}
          </span>
        </div>
      </div>

      <div className="translator-settings-group">
        <div className="translator-setting-line">
          <span className="translator-setting-copy">
            <strong>{cached ? "Rebuild source" : "Source"}</strong>
            <span>{source}</span>
          </span>
          {available && (
            <span className="translator-state is-ready">Available</span>
          )}
        </div>

        {!supported && glossary?.packAvailable && available && (
          <div className="translator-setting-line">
            <span className="translator-setting-copy">
              <strong>Community language pack</strong>
              <span>
                Stardew Valley doesn’t include this language, but{" "}
                {glossary.packName || "an installed pack"} has the official
                names for it.
              </span>
            </span>
            <span className="translator-state is-ready">Found</span>
          </div>
        )}

        {!supported &&
          glossary?.packAvailable &&
          !available &&
          !usableCache && (
            <div className="translator-setting-line">
              <span className="translator-setting-copy">
                <strong>Notice</strong>
                <span>
                  A community language pack was found
                  {glossary.packName ? " (" + glossary.packName + ")" : ""}, but
                  the game&apos;s text files with the English names
                  (Content/Strings) were not. Check the Stardew Valley folder.
                </span>
              </span>
            </div>
          )}

        {!supported && glossary && !glossary.packAvailable && !usableCache && (
          <div className="translator-setting-line">
            <span className="translator-setting-copy">
              <strong>Notice</strong>
              <span>
                Stardew Valley doesn’t include this language, so no official
                glossary is available. Translation and export still work fully.
              </span>
            </span>
            <span className="translator-state">Unavailable</span>
          </div>
        )}

        {glossary && !available && (supported || usableCache) && (
          <div className="translator-setting-line">
            <span className="translator-setting-copy">
              <strong>Notice</strong>
              <span>
                {cached && !glossary.outdatedCache
                  ? supported || !glossary.sourceAvailable
                    ? "Your glossary stays available. Rebuilding it needs the game's text files (Content/Strings), which weren't found."
                    : "Your glossary stays available. Rebuilding it needs the community language pack, which wasn't found in your Mods folder."
                  : "The game's text files (Content/Strings) were not found. Check the Stardew Valley folder."}
              </span>
            </span>
          </div>
        )}

        {canBuild && (
          <div className="translator-setting-line">
            <span className="translator-setting-copy">
              <strong>{language} glossary</strong>
              <span>
                {cached
                  ? "Stored on your PC · rebuild it after a game update"
                  : "Not built yet · optional, takes only a moment"}
              </span>
              <span>Built glossaries are saved right away.</span>
            </span>
            <button
              className="translator-button translator-button-quiet"
              type="button"
              onClick={onBuild}
              disabled={building}
            >
              <RefreshCw aria-hidden="true" />{" "}
              {building
                ? "Building…"
                : !supported && glossary?.packAvailable
                  ? cached
                    ? "Rebuild from community pack"
                    : "Build from community pack"
                  : cached
                    ? "Rebuild glossary"
                    : "Build glossary"}
            </button>
          </div>
        )}

        {glossary?.outdatedCache && (
          <div className="translator-setting-line">
            <span className="translator-setting-copy">
              <strong>Notice</strong>
              <span>
                Your glossary is from an older version of the app. Rebuild it to
                get hints again.
              </span>
            </span>
            <span className="translator-state is-review">Outdated</span>
          </div>
        )}
      </div>
      {error && (
        <p className="translator-shortcut-error" role="alert">
          {error}
        </p>
      )}
      {false}
    </section>
  );
}
