/**
 * Setup Wizard - M1 / Issue 3 (SPEC section 4).
 *
 * Modal, 4 steps: Stardew folder, Mods folder, languages, optional glossary.
 * The Mods-folder step is a generic folder override only, not mod-manager
 * integration.
 */
import { useEffect, useState, type ReactNode } from "react";
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
import { SOURCE_LANGUAGE_LABEL, TARGET_LANGUAGES } from "../languages";

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
  onComplete: (settings: AppSettings) => void;
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

  useEffect(() => {
    if (step !== 4 || !stardewPath) return;
    let active = true;
    setGlossary(null);
    glossaryStatus(stardewPath)
      .then((status) => {
        if (active) setGlossary(status);
      })
      .catch(() => {
        if (active) setGlossary({ unpackedPresent: false, cached: null });
      });
    return () => {
      active = false;
    };
  }, [step, stardewPath]);

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

  function finish() {
    onComplete({
      stardewPath,
      modsPath,
      sourceLang: "default",
      targetLang,
    });
  }

  const canLeaveStep1 = stardewValid === true && stardewPath !== "";
  const canLeaveStep2 = modsPath !== "";
  const canLeaveStep3 = targetLang !== "";

  return (
    <div
      className="wizard__backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Setup"
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

          <div className="wizard__body setup__body">
            {step === 1 && (
              <section aria-label="Stardew Valley folder">
                <StepHeading
                  eyebrow="Step 1"
                  title="Find your game"
                  description="We use the game folder to locate your Mods directory and, optionally, build official translation hints."
                />
                <div className="wizard__row">
                  <button
                    type="button"
                    className="wizard__primary"
                    onClick={autoDetect}
                    disabled={busy}
                  >
                    {busy ? "Detecting..." : "Auto-detect"}
                  </button>
                  <button type="button" onClick={browseStardew} disabled={busy}>
                    Browse...
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
                  description="This is the folder the app scans for translatable i18n files."
                />
                <div className="setup__note">
                  The recommended location is{" "}
                  <code>&lt;Stardew Valley&gt;/Mods</code>. Change it only when
                  your mods are stored elsewhere.
                </div>
                <div className="wizard__row">
                  <button type="button" onClick={browseMods} disabled={busy}>
                    Browse...
                  </button>
                </div>
                <PathDisplay
                  path={modsPath}
                  valid={modsPath ? true : null}
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
                    <small>Fixed by the Stardew i18n format</small>
                  </label>
                  <label className="wizard__field setup__language-card">
                    <span>Target language</span>
                    <select
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
                    <small>Used for imports, exports, and glossary hints</small>
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

                <div
                  className="setup__howto"
                  role="region"
                  aria-label="How the glossary works"
                >
                  <h4>How it works</h4>
                  <ol>
                    <li>
                      <strong>Unpack once.</strong> StardewXnbHack creates a{" "}
                      <code>Content (unpacked)/</code> folder from your
                      installed game.
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
                  <StatusCard tone="neutral" title="Checking game content...">
                    Looking for the files needed to build your glossary.
                  </StatusCard>
                ) : glossaryBuilt ? (
                  <StatusCard tone="success" title="Glossary ready">
                    Built {glossaryBuilt.termCount} official terms for{" "}
                    {glossaryBuilt.targetLang}.
                  </StatusCard>
                ) : glossary.unpackedPresent ? (
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
                          : "Build glossary"}
                      </button>
                    }
                  >
                    {glossary.cached
                      ? `A cached glossary with ${glossary.cached.termCount} terms already exists. Rebuild it to refresh the data.`
                      : "Unpacked game content was found. Building usually takes only a moment."}
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
                    Download StardewXnbHack, place it in your Stardew Valley
                    folder, and run it once. Then re-open Setup and build the
                    glossary here.
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
            <button type="button" className="wizard__cancel" onClick={onCancel}>
              Cancel
            </button>
          )}
          <span className="wizard__spacer" />
          {step > 1 && (
            <button type="button" onClick={() => setStep((step - 1) as Step)}>
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
            <button type="button" className="wizard__primary" onClick={finish}>
              Finish
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
}: {
  path: string;
  valid: boolean | null;
  label: string;
}) {
  const invalid = valid === false;
  return (
    <div
      className={`wizard__path${!path ? " wizard__path--empty" : ""}${
        invalid ? " wizard__path--invalid" : ""
      }`}
    >
      <span className="wizard__path-status" aria-hidden="true">
        {path && valid === true ? "✓" : invalid ? "!" : "..."}
      </span>
      <span className="wizard__path-content">
        <strong>{label}</strong>
        {path ? <code>{path}</code> : <span>No folder selected yet</span>}
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
