/**
 * First-run setup wizard.
 *
 * Modal, 4 steps: Stardew folder, Mods folder, languages, optional glossary.
 * The Mods-folder step also selects how Nexus translations are added.
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
  openUrl,
  pickFolder,
  validateStardewPath,
} from "../tauri/commands";
import {
  SOURCE_LANGUAGE_LABEL,
  TARGET_LANGUAGES,
  gameSupportsLanguage,
} from "../languages";
import { useDialogAccessibility } from "../dialogAccessibility";

import { NexusSetup, useNexusSetup } from "../nexus/NexusSetup";
import {
  InstallationSettings,
  installationMethodFor,
} from "./InstallationSettings";

type Step = 1 | 2 | 3 | 4;

const SETUP_STEPS: Array<{
  number: Step;
  title: string;
  description: string;
}> = [
  { number: 1, title: "Game folder", description: "Find Stardew Valley" },
  { number: 2, title: "Mods folder", description: "Choose what to scan" },
  { number: 3, title: "Languages", description: "Set your translation pair" },
  { number: 4, title: "Glossary", description: "Add official term hints" },
];

interface SetupWizardProps {
  initial: AppSettings | null;
  onComplete: (settings: AppSettings) => Promise<void> | void;
  /** Provided only when settings already exist (wizard re-opened from Settings). */
  onCancel?: () => void;
  onNexusKeySaved?: () => void;
}

export function SetupWizard({
  initial,
  onComplete,
  onCancel,
  onNexusKeySaved,
}: SetupWizardProps) {
  const nexusConnection = useNexusSetup(onNexusKeySaved);
  const [installationMethod, setInstallationMethod] = useState(() =>
    installationMethodFor(initial),
  );
  const [vortexExecutable, setVortexExecutable] = useState(
    initial?.vortexExecutable ?? null,
  );
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
  const bodyRef = useRef<HTMLDivElement>(null);
  const previousStep = useRef(step);
  useEffect(() => {
    if (bodyRef.current) {
      bodyRef.current.scrollTop = 0;
      if (previousStep.current !== step)
        bodyRef.current.focus({ preventScroll: true });
    }
    previousStep.current = step;
  }, [step]);
  const { onDialogKeyDown } = useDialogAccessibility({
    dialogRef,
    onEscape: onCancel ?? (() => {}),
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
            unpackedPresent: false,
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
      if (nexusConnection.key.trim() && !(await nexusConnection.save())) {
        setStep(2);
        return;
      }
      await onComplete({
        ...initial,
        stardewPath,
        modsPath,
        vortexExecutable,
        installationMethod,
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
      aria-label="Setup"
      onKeyDown={onDialogKeyDown}
    >
      <div className="wizard wizard--setup">
        <header className="setup__hero">
          <div>
            <span className="setup__eyebrow">First-time setup</span>
            <h2>Welcome to Stardew i18n Translator</h2>
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

          <div
            ref={bodyRef}
            className="wizard__body setup__body"
            tabIndex={-1}
            role="region"
            aria-label="Setup step content"
          >
            {step === 1 && (
              <section aria-label="Stardew Valley folder">
                <StepHeading
                  eyebrow="Step 1"
                  title="Find your game"
                  description="Locate Stardew Valley to find your Mods folder and optional glossary content."
                />
                <div className="translator-settings-group">
                  <PathDisplay
                    path={stardewPath}
                    valid={stardewValid}
                    label="Stardew Valley folder"
                    action={
                      <div className="setup__row-actions">
                        <button
                          type="button"
                          className="wizard__primary"
                          onClick={autoDetect}
                          disabled={busy}
                        >
                          {busy ? "Detecting..." : "Auto-detect"}
                        </button>
                        <button
                          type="button"
                          aria-label="Browse Stardew Valley folder"
                          onClick={browseStardew}
                          disabled={busy}
                        >
                          {stardewPath ? "Change" : "Browse…"}
                        </button>
                      </div>
                    }
                  />
                </div>
              </section>
            )}

            {step === 2 && (
              <section aria-label="Mods folder">
                <StepHeading
                  eyebrow="Step 2"
                  title="Choose your Mods folder"
                  description={
                    installationMethod === "vortex"
                      ? "Scan the files Vortex has deployed to your game."
                      : "This is the folder the app scans for translatable i18n files."
                  }
                />
                <InstallationSettings
                  compact
                  method={installationMethod}
                  onMethodChange={setInstallationMethod}
                  executable={vortexExecutable}
                  onExecutableChange={setVortexExecutable}
                  disabled={busy}
                />
                <div className="translator-settings-group">
                  <PathDisplay
                    path={modsPath}
                    valid={modsPath ? true : null}
                    label={
                      installationMethod === "vortex"
                        ? "Deployed game Mods folder"
                        : "Mods folder"
                    }
                    description={
                      installationMethod === "vortex"
                        ? "Use the game's Mods folder, not Vortex's staging or downloads folder."
                        : "Usually <Stardew Valley>/Mods. Change it if your game uses a different folder."
                    }
                    action={
                      <button
                        type="button"
                        aria-label="Browse Mods folder"
                        onClick={browseMods}
                        disabled={busy}
                      >
                        {modsPath ? "Change" : "Browse…"}
                      </button>
                    }
                  />
                </div>
                <NexusSetup
                  compact
                  connection={nexusConnection}
                  disabled={busy}
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
                <div className="translator-settings-group">
                  <div className="translator-setting-line">
                    <span className="translator-setting-copy">
                      <strong>Source language</strong>
                      <span>From i18n/default.json</span>
                    </span>
                    <span>{SOURCE_LANGUAGE_LABEL}</span>
                  </div>
                  <label className="translator-setting-line">
                    <span className="translator-setting-copy">
                      <strong>Target language</strong>
                      <span>For imports, exports, and glossary hints</span>
                    </span>
                    <select
                      className="translator-select"
                      value={targetLang}
                      onChange={(event) => setTargetLang(event.target.value)}
                      aria-label="Target language"
                    >
                      <option value="" disabled>
                        Choose a language...
                      </option>
                      {TARGET_LANGUAGES.map((language) => (
                        <option key={language.code} value={language.code}>
                          {language.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </section>
            )}

            {step === 4 && (
              <section aria-label="Glossary">
                <StepHeading
                  eyebrow="Step 4 / Optional"
                  title="Add official translation hints"
                  description="A local glossary helps you use Stardew Valley's official names for items, characters, places, seasons, and UI terms."
                />

                <details className="setup__glossary-help">
                  <summary tabIndex={0}>How the glossary works</summary>
                  <div role="region" aria-label="How the glossary works">
                    <p>
                      <strong>Read locally.</strong> Match English terms from
                      your game or an installed community language pack with
                      your selected language.
                    </p>
                    <p>
                      Matching terms appear as translation hints and guidance
                      for AI tools. Game files are never changed or uploaded.
                    </p>
                  </div>
                </details>
                <p className="setup__optional-note">
                  You can finish now and build the glossary later in Settings.
                </p>

                {glossary === null ? (
                  <StatusCard tone="neutral" title="Checking game content...">
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
                            ? "Building glossary..."
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
                      title="No usable glossary source"
                      action={
                        <button
                          type="button"
                          onClick={() =>
                            void openUrl(
                              "https://github.com/Pathoschild/StardewXnbHack",
                            )
                          }
                        >
                          Open StardewXnbHack
                        </button>
                      }
                    >
                      A community language pack
                      {glossary.packName ? ` (${glossary.packName})` : ""} was
                      detected, but the app could not read a local English
                      Strings source. StardewXnbHack is only needed as a
                      fallback if the direct game files are unavailable.
                    </StatusCard>
                  ) : (
                    <StatusCard
                      tone="neutral"
                      title="No glossary for this language"
                    >
                      Stardew Valley doesn’t include this language, so no
                      official glossary is available. You can still translate
                      and export fully.
                    </StatusCard>
                  )
                ) : glossary.sourceAvailable ? (
                  <StatusCard
                    tone="ready"
                    title="Everything is ready"
                    action={
                      <button
                        type="button"
                        className="wizard__primary"
                        onClick={handleBuildGlossary}
                        disabled={glossaryBuilding || !targetLang}
                      >
                        {glossaryBuilding
                          ? "Building glossary..."
                          : glossary.cached
                            ? "Rebuild glossary"
                            : "Build glossary"}
                      </button>
                    }
                  >
                    {glossary.outdatedCache
                      ? "An older glossary from a previous version was found — rebuild recommended."
                      : glossary.cached
                        ? `A cached glossary with ${glossary.cached.termCount} terms already exists. Rebuild it to refresh the data.`
                        : glossary.gameXnbPresent
                          ? "Game Strings were found. Building usually takes only a moment."
                          : "Unpacked game content was found as a fallback source. Building usually takes only a moment."}
                  </StatusCard>
                ) : (
                  <StatusCard
                    tone="warning"
                    title="One preparation step is needed"
                    action={
                      <button
                        type="button"
                        onClick={() =>
                          void openUrl(
                            "https://github.com/Pathoschild/StardewXnbHack",
                          )
                        }
                      >
                        Open StardewXnbHack
                      </button>
                    }
                  >
                    The app could not read glossary-ready game Strings. If the
                    direct game files are unavailable, run StardewXnbHack once
                    and re-open Setup.
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
          {onCancel && (
            <button
              type="button"
              className="wizard__cancel"
              onClick={onCancel}
              disabled={busy}
            >
              Cancel
            </button>
          )}
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
              disabled={!canLeaveStep1}
            >
              Next
            </button>
          )}
          {step === 2 && (
            <button
              type="button"
              className="wizard__primary"
              onClick={() => setStep(3)}
              disabled={!canLeaveStep2}
            >
              Next
            </button>
          )}
          {step === 3 && (
            <button
              type="button"
              className="wizard__primary"
              onClick={() => setStep(4)}
              disabled={!canLeaveStep3}
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
              {busy ? "Saving..." : "Finish"}
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
  description,
  action,
}: {
  path: string;
  valid: boolean | null;
  label: string;
  description?: string;
  action: ReactNode;
}) {
  return (
    <div className="translator-setting-line">
      <div className="translator-setting-copy">
        <strong>{label}</strong>
        <span className="setup__path-value" title={path || undefined}>
          {path || "No folder selected yet"}
        </span>
        {description && <span>{description}</span>}
        {valid === false && (
          <span className="wizard__bad" role="alert">
            This does not look like a Stardew Valley folder.
          </span>
        )}
      </div>
      {action}
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
