/**
 * First-run setup wizard.
 *
 * Modal, 4 steps: Stardew folder, Mods folder, languages, optional glossary.
 * The Mods-folder step is a generic folder override only, not mod-manager
 * integration.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  type AppSettings,
  type GlossaryInfo,
  type GlossaryStatus,
  buildGlossary,
  defaultModsPath,
  detectStardew,
  glossaryStatus,
  pickFolder,
  validateStardewPath,
} from "../tauri/commands";
import {
  SOURCE_LANGUAGE_LABEL,
  TARGET_LANGUAGES,
  gameSupportsLanguage,
} from "../languages";
import { useDialogAccessibility } from "../dialogAccessibility";

type Step = 1 | 2 | 3 | 4;

const SETUP_STEPS: Array<{
  number: Step;
  title: string;
  description: string;
}> = [
  { number: 1, title: "Game folder", description: "Find Stardew Valley" },
  { number: 2, title: "Mods folder", description: "Where your mods are" },
  { number: 3, title: "Languages", description: "Pick your language" },
  { number: 4, title: "Glossary", description: "Official names as hints" },
];

interface SetupWizardProps {
  initial: AppSettings | null;
  onComplete: (settings: AppSettings) => Promise<void> | void;
  /** Provided only when settings already exist (wizard re-opened from Settings). */
  onCancel?: () => void;
}

export function SetupWizard({
  initial,
  onComplete,
  onCancel,
}: SetupWizardProps) {
  const [step, setStep] = useState<Step>(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [stardewPath, setStardewPath] = useState(initial?.stardewPath ?? "");
  const [stardewValid, setStardewValid] = useState<boolean | null>(
    initial?.stardewPath ? true : null,
  );
  const [modsPath, setModsPath] = useState(initial?.modsPath ?? "");
  const [targetLang, setTargetLang] = useState(initial?.targetLang ?? "");

  const [glossary, setGlossary] = useState<GlossaryStatus | null>(null);
  const [glossaryBuilding, setGlossaryBuilding] = useState(false);
  const [glossaryBuilt, setGlossaryBuilt] = useState<GlossaryInfo | null>(null);
  const autoBuildKey = useRef<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [discardPrompt, setDiscardPrompt] = useState(false);
  const hasChanges =
    stardewPath !== (initial?.stardewPath ?? "") ||
    modsPath !== (initial?.modsPath ?? "") ||
    targetLang !== (initial?.targetLang ?? "");

  /** Re-running setup from Settings: ask before dropping changed choices. */
  function requestCancel() {
    if (!onCancel) return;
    if (hasChanges) {
      setDiscardPrompt(true);
      return;
    }
    onCancel();
  }

  const { onDialogKeyDown } = useDialogAccessibility({
    dialogRef,
    onEscape: () => (discardPrompt ? setDiscardPrompt(false) : requestCancel()),
    escapeDisabled: !onCancel || busy,
  });

  useEffect(() => {
    if (step !== 4 || !stardewPath) return;
    let active = true;
    setGlossary(null);
    setGlossaryBuilt(null);
    glossaryStatus(stardewPath, targetLang)
      .then((status) => {
        if (active) setGlossary(status);
      })
      .catch(() => {
        if (active)
          setGlossary({
            gameXnbPresent: false,
            sourceAvailable: false,
            cached: null,
            outdatedCache: false,
            packAvailable: false,
            packXnbAvailable: false,
          });
      });
    return () => {
      active = false;
    };
  }, [step, stardewPath, targetLang]);

  useEffect(() => {
    if (
      step !== 4 ||
      !stardewPath ||
      !targetLang ||
      !glossary ||
      glossary.cached ||
      glossaryBuilding ||
      !glossary.sourceAvailable
    ) {
      return;
    }
    if (!gameSupportsLanguage(targetLang) && !glossary.packAvailable) return;
    const key = `${stardewPath}|${targetLang}`;
    if (autoBuildKey.current === key) return;
    autoBuildKey.current = key;
    void handleBuildGlossary();
  }, [step, stardewPath, targetLang, glossary, glossaryBuilding]);

  async function handleBuildGlossary() {
    setGlossaryBuilding(true);
    setError(null);
    try {
      setGlossaryBuilt(await buildGlossary(stardewPath, targetLang));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setGlossaryBuilding(false);
    }
  }

  async function autoDetect() {
    setBusy(true);
    setError(null);
    try {
      const found = await detectStardew();
      if (found) {
        setStardewPath(found.stardewPath);
        setStardewValid(true);
        setModsPath(found.modsPath);
      } else {
        setStardewValid(null);
        setError(
          "Could not auto-detect Stardew Valley. Use Browse to locate it.",
        );
      }
    } catch {
      setError("Auto-detection failed. Use Browse to locate the folder.");
    } finally {
      setBusy(false);
    }
  }

  async function browseStardew() {
    setBusy(true);
    setError(null);
    try {
      const path = await pickFolder("Select your Stardew Valley folder");
      if (path) {
        setStardewPath(path);
        setStardewValid(null);
        const valid = await validateStardewPath(path);
        setStardewValid(valid);
        if (valid && !modsPath) {
          setModsPath(await defaultModsPath(path));
        }
      }
    } catch {
      setError("Could not open the folder picker.");
    } finally {
      setBusy(false);
    }
  }

  async function browseMods() {
    setBusy(true);
    setError(null);
    try {
      const path = await pickFolder("Select your Mods folder");
      if (path) setModsPath(path);
    } catch {
      setError("Could not open the folder picker.");
    } finally {
      setBusy(false);
    }
  }

  async function goToModsStep() {
    if (!modsPath && stardewPath) {
      try {
        setModsPath(await defaultModsPath(stardewPath));
      } catch {
        // Leave empty so the user can select it manually.
      }
    }
    setStep(2);
  }

  async function finish() {
    setBusy(true);
    setError(null);
    try {
      await onComplete({
        stardewPath,
        modsPath,
        sourceLang: "default",
        targetLang,
      });
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }

  const canLeaveStep1 = stardewValid === true && stardewPath !== "";
  const canLeaveStep2 = modsPath !== "";
  const canLeaveStep3 = targetLang !== "";

  return (
    <div
      ref={dialogRef}
      className="wizard__backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="translator-setup-title"
      tabIndex={-1}
      onKeyDown={onDialogKeyDown}
    >
      <div className="wizard wizard--setup">
        <header className="setup__hero">
          <div>
            <span className="setup__eyebrow">
              {onCancel ? "Workspace setup" : "First-time setup"}
            </span>
            <h2 id="translator-setup-title">
              {onCancel
                ? "Configure your workspace"
                : "Welcome to Stardew i18n Translator"}
            </h2>
            <p>Set up your translation workspace in four quick steps.</p>
          </div>
          <span className="setup__counter">
            {step}
            <span>/4</span>
          </span>
        </header>

        <div
          className="setup__progress-track"
          role="progressbar"
          aria-label="Setup progress"
          aria-valuemin={1}
          aria-valuemax={4}
          aria-valuenow={step}
        >
          <span style={{ width: `${step * 25}%` }} />
        </div>

        <div className="setup__layout">
          <nav className="setup__steps" aria-label="Setup steps">
            {SETUP_STEPS.map((item) => {
              const state =
                item.number === step
                  ? "current"
                  : item.number < step
                    ? "complete"
                    : "upcoming";
              return (
                <div
                  key={item.number}
                  className={`setup__step setup__step--${state}`}
                  aria-current={state === "current" ? "step" : undefined}
                >
                  <span className="setup__step-number">
                    {state === "complete" ? "✓" : item.number}
                  </span>
                  <span>
                    <strong>{item.title}</strong>
                    <small>{item.description}</small>
                  </span>
                </div>
              );
            })}
          </nav>

          <div className="wizard__body setup__body">
            {step === 1 && (
              <section aria-label="Stardew Valley folder">
                <StepHeading
                  eyebrow="Step 1"
                  title="Find your game"
                  description="The app uses the game folder to find your Mods folder and, if you like, to build a glossary of the game's official names."
                />
                <div className="wizard__row">
                  <button
                    type="button"
                    className="wizard__primary"
                    onClick={autoDetect}
                    disabled={busy}
                  >
                    {busy ? "Detecting…" : "Auto-detect"}
                  </button>
                  <button type="button" onClick={browseStardew} disabled={busy}>
                    Browse…
                  </button>
                </div>
                <PathDisplay
                  path={stardewPath}
                  valid={stardewValid}
                  label="Stardew Valley folder"
                />
              </section>
            )}

            {step === 2 && (
              <section aria-label="Mods folder">
                <StepHeading
                  eyebrow="Step 2"
                  title="Choose your Mods folder"
                  description="The app looks in this folder for mods with translation files."
                />
                <div className="setup__note">
                  Usually this is <code>&lt;Stardew Valley&gt;/Mods</code>.
                  Change it if your mods live elsewhere, for example in Mod
                  Organizer 2&apos;s mods folder.
                </div>
                <div className="wizard__row">
                  <button type="button" onClick={browseMods} disabled={busy}>
                    Browse…
                  </button>
                </div>
                <PathDisplay
                  path={modsPath}
                  valid={null}
                  selectionOnly
                  label="Mods folder"
                />
              </section>
            )}

            {step === 3 && (
              <section aria-label="Languages">
                <StepHeading
                  eyebrow="Step 3"
                  title="Set your languages"
                  description="Stardew mods use English as their source. Choose the language you want to translate into."
                />
                <div className="setup__language-grid">
                  <label className="wizard__field setup__language-card">
                    <span>Source language</span>
                    <input type="text" value={SOURCE_LANGUAGE_LABEL} disabled />
                    <small>Mods are written in English</small>
                  </label>
                  <label className="wizard__field setup__language-card">
                    <span>Target language</span>
                    <select
                      value={targetLang}
                      onChange={(event) => setTargetLang(event.target.value)}
                      aria-label="Target language"
                    >
                      <option value="" disabled>
                        Choose a language…
                      </option>
                      <optgroup label="In the game">
                        {TARGET_LANGUAGES.filter((language) =>
                          gameSupportsLanguage(language.code),
                        ).map((language) => (
                          <option key={language.code} value={language.code}>
                            {language.label}
                          </option>
                        ))}
                      </optgroup>
                      <optgroup label="Needs a language mod in the game">
                        {TARGET_LANGUAGES.filter(
                          (language) => !gameSupportsLanguage(language.code),
                        ).map((language) => (
                          <option key={language.code} value={language.code}>
                            {language.label}
                          </option>
                        ))}
                      </optgroup>
                    </select>
                    <small>Used for imports, exports, and glossary hints</small>
                  </label>
                </div>
              </section>
            )}

            {step === 4 && (
              <section aria-label="Glossary">
                <StepHeading
                  eyebrow="Step 4 / Optional"
                  title="Add a glossary"
                  description="A local glossary helps you use Stardew Valley's official names for items, characters, places, seasons, and UI terms."
                />

                <div
                  className="setup__howto"
                  role="region"
                  aria-label="How the glossary works"
                >
                  <h4>How it works</h4>
                  <ol>
                    <li>
                      <strong>Read locally.</strong> The app reads glossary
                      terms from your installed game or an installed community
                      language pack.
                    </li>
                    <li>
                      <strong>Build locally.</strong> The app matches official
                      English terms with your selected language.
                    </li>
                    <li>
                      <strong>Use as hints.</strong> Matching terms appear while
                      you translate and are included as guidance for AI tools.
                    </li>
                  </ol>
                  <p>
                    Your game files are only read, never changed or uploaded.
                    You can skip this now and build the glossary later in
                    Settings.
                  </p>
                </div>

                {glossary === null ? (
                  <StatusCard tone="neutral" title="Checking game content…">
                    Looking for the files needed to build your glossary.
                  </StatusCard>
                ) : glossaryBuilt ? (
                  <StatusCard tone="success" title="Glossary ready">
                    Built {glossaryBuilt.termCount} official terms for{" "}
                    {glossaryBuilt.targetLang}
                    {glossaryBuilt.source === "communityPack" &&
                    glossaryBuilt.packName
                      ? ` from ${glossaryBuilt.packName}`
                      : ""}
                    .
                  </StatusCard>
                ) : glossary.cached &&
                  !glossary.outdatedCache &&
                  (!glossary.sourceAvailable ||
                    (targetLang &&
                      !gameSupportsLanguage(targetLang) &&
                      !glossary.packAvailable)) ? (
                  <StatusCard tone="ready" title="Glossary ready">
                    {glossary.cached.termCount} official names are ready.
                    Rebuilding them needs the game&apos;s text files, which
                    weren&apos;t found.
                  </StatusCard>
                ) : targetLang && !gameSupportsLanguage(targetLang) ? (
                  glossary.packAvailable && glossary.sourceAvailable ? (
                    <StatusCard
                      tone="ready"
                      title="Community language pack found"
                      action={
                        <button
                          type="button"
                          className="wizard__primary"
                          onClick={handleBuildGlossary}
                          disabled={glossaryBuilding || !targetLang}
                        >
                          {glossaryBuilding
                            ? "Building glossary…"
                            : glossary.cached
                              ? "Rebuild from community pack"
                              : "Build from community pack"}
                        </button>
                      }
                    >
                      Stardew Valley doesn’t include this language, but a
                      community language pack
                      {glossary.packName ? ` (${glossary.packName})` : ""} was
                      detected. Build official-term hints from it — the rest of
                      the app works the same.
                    </StatusCard>
                  ) : glossary.packAvailable ? (
                    <StatusCard
                      tone="neutral"
                      title="Glossary can't be built yet"
                    >
                      A community language pack
                      {glossary.packName ? ` (${glossary.packName})` : ""} was
                      found, but the game&apos;s text files with the English
                      names (Content/Strings) were not. Check the Stardew Valley
                      folder, or finish setup without a glossary.
                    </StatusCard>
                  ) : (
                    <StatusCard
                      tone="neutral"
                      title="No glossary for this language"
                    >
                      No local glossary source was found for this language. You
                      can finish setup without a glossary.
                    </StatusCard>
                  )
                ) : glossary.sourceAvailable ? (
                  <StatusCard
                    tone="ready"
                    title={
                      glossary.outdatedCache
                        ? "Rebuild your glossary"
                        : glossary.cached
                          ? "Glossary ready"
                          : "Glossary can be built"
                    }
                    action={
                      <button
                        type="button"
                        onClick={handleBuildGlossary}
                        disabled={glossaryBuilding || !targetLang}
                      >
                        {glossaryBuilding
                          ? "Building glossary…"
                          : glossary.cached
                            ? "Rebuild glossary"
                            : "Build glossary"}
                      </button>
                    }
                  >
                    {glossary.outdatedCache
                      ? "Your glossary is from an older version of the app. Rebuild it to get hints again."
                      : glossary.cached
                        ? `Your glossary has ${glossary.cached.termCount} official names. Rebuild it after a game update.`
                        : "The game's text files were found. Building takes only a moment."}
                  </StatusCard>
                ) : (
                  <StatusCard
                    tone={
                      glossary.cached && !glossary.outdatedCache
                        ? "ready"
                        : "neutral"
                    }
                    title={
                      glossary.cached && !glossary.outdatedCache
                        ? "Glossary ready"
                        : "Glossary can't be built yet"
                    }
                  >
                    {glossary.cached && !glossary.outdatedCache
                      ? `${glossary.cached.termCount} official names are ready. Rebuilding them needs the game's text files, which weren't found.`
                      : glossary.outdatedCache
                        ? "Your glossary is from an older version of the app, and the game's text files (Content/Strings) were not found to rebuild it. Check the Stardew Valley folder, or finish setup and rebuild later in Settings."
                        : "The game's text files (Content/Strings) were not found. Check the Stardew Valley folder, or finish setup and build the glossary later in Settings."}
                  </StatusCard>
                )}
              </section>
            )}

            {error && (
              <p className="wizard__error" role="alert">
                {error}
              </p>
            )}
          </div>
        </div>

        <footer className="wizard__footer setup__footer">
          {onCancel &&
            (discardPrompt ? (
              <>
                <span className="translator-settings-discard" role="alert">
                  You have unsaved changes.
                </span>
                <button
                  type="button"
                  className="wizard__cancel"
                  onClick={onCancel}
                  disabled={busy}
                >
                  Discard changes
                </button>
                <button
                  type="button"
                  className="wizard__cancel"
                  onClick={() => setDiscardPrompt(false)}
                  disabled={busy}
                >
                  Keep editing
                </button>
              </>
            ) : (
              <button
                type="button"
                className="wizard__cancel"
                onClick={requestCancel}
                disabled={busy}
              >
                Cancel
              </button>
            ))}
          <span className="wizard__spacer" />
          {step > 1 && (
            <button
              type="button"
              onClick={() => setStep((step - 1) as Step)}
              disabled={busy}
            >
              Back
            </button>
          )}
          {step === 1 && (
            <button
              type="button"
              className="wizard__primary"
              onClick={goToModsStep}
              disabled={busy || !canLeaveStep1}
            >
              Next
            </button>
          )}
          {step === 2 && (
            <button
              type="button"
              className="wizard__primary"
              onClick={() => setStep(3)}
              disabled={busy || !canLeaveStep2}
            >
              Next
            </button>
          )}
          {step === 3 && (
            <button
              type="button"
              className="wizard__primary"
              onClick={() => setStep(4)}
              disabled={busy || !canLeaveStep3}
            >
              Next
            </button>
          )}
          {step === 4 && (
            <button
              type="button"
              className="wizard__primary"
              onClick={() => void finish()}
              disabled={busy}
            >
              {busy ? "Saving…" : "Finish"}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

function StepHeading({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="setup__heading">
      <span>{eyebrow}</span>
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}

function PathDisplay({
  path,
  valid,
  label,
  selectionOnly = false,
}: {
  path: string;
  valid: boolean | null;
  label: string;
  selectionOnly?: boolean;
}) {
  const invalid = valid === false;
  return (
    <div
      className={`wizard__path${!path ? " wizard__path--empty" : ""}${
        invalid ? " wizard__path--invalid" : ""
      }`}
    >
      <span className="wizard__path-status" aria-hidden="true">
        {selectionOnly
          ? "—"
          : path && valid === true
            ? "✓"
            : invalid
              ? "!"
              : "…"}
      </span>
      <span className="wizard__path-content">
        <strong>{label}</strong>
        {path ? <code>{path}</code> : <span>No folder selected yet</span>}
        {selectionOnly && path && <small>Selected folder</small>}
        {invalid && (
          <small className="wizard__bad">
            This does not look like a Stardew Valley folder.
          </small>
        )}
      </span>
    </div>
  );
}

function StatusCard({
  tone,
  title,
  children,
  action,
}: {
  tone: "neutral" | "success" | "ready" | "warning";
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={`setup__status setup__status--${tone}`}>
      <div>
        <strong>{title}</strong>
        <p>{children}</p>
      </div>
      {action && <div className="setup__status-action">{action}</div>}
    </div>
  );
}
