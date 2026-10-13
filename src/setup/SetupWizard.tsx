/**
 * First-run setup wizard.
 *
 * Modal, 4 steps: Stardew folder, Mods folder, languages, optional glossary.
 * The Mods-folder step is a generic folder override only, not mod-manager
 * integration.
 */
import { useEffect, useRef, useState } from "react";
import {
  BookOpen,
  Check,
  FolderOpen,
  Gamepad2,
  Languages,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  type AppSettings,
  type GlossaryStatus,
  buildGlossary,
  defaultModsPath,
  detectStardew,
  glossaryStatus,
  pickFolder,
  validateStardewPath,
} from "../tauri/commands";
import { SOURCE_LANGUAGE_LABEL, gameSupportsLanguage } from "../languages";
import { GlossarySettings } from "../settings/GlossarySettings";
import { TargetLanguageOptions } from "../settings/TargetLanguageOptions";
import { useDialogAccessibility } from "../dialogAccessibility";

type Step = 1 | 2 | 3 | 4;

const SETUP_STEPS: Array<{
  number: Step;
  title: string;
  description: string;
  icon: LucideIcon;
}> = [
  {
    number: 1,
    title: "Game folder",
    description: "Find Stardew Valley",
    icon: Gamepad2,
  },
  {
    number: 2,
    title: "Mods folder",
    description: "Where your mods are",
    icon: FolderOpen,
  },
  {
    number: 3,
    title: "Languages",
    description: "Pick your language",
    icon: Languages,
  },
  {
    number: 4,
    title: "Glossary",
    description: "Official names as hints",
    icon: BookOpen,
  },
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
  const [glossaryError, setGlossaryError] = useState<string | null>(null);
  const autoBuildKey = useRef<string | null>(null);
  const buildRequest = useRef<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
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
    setGlossaryError(null);
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
    const request = `${stardewPath}|${targetLang}`;
    buildRequest.current = request;
    setGlossaryBuilding(true);
    setGlossaryError(null);
    try {
      const info = await buildGlossary(stardewPath, targetLang);
      // The user went back and chose another folder or language meanwhile.
      if (buildRequest.current !== request) return;
      setGlossary((previous) => ({
        gameXnbPresent: previous?.gameXnbPresent ?? false,
        sourceAvailable: previous?.sourceAvailable ?? true,
        cached: info,
        outdatedCache: false,
        packAvailable: previous?.packAvailable ?? false,
        packXnbAvailable: previous?.packXnbAvailable ?? false,
        packName: previous?.packName,
      }));
    } catch (cause) {
      if (buildRequest.current === request) setGlossaryError(String(cause));
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

  const stepTitle = SETUP_STEPS[step - 1].title;

  return (
    <div className="translator-settings-overlay translator-setup-overlay">
      <section
        ref={dialogRef}
        className="translator-settings-dialog translator-setup-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="translator-setup-title"
        aria-describedby="translator-setup-description"
        tabIndex={-1}
        onKeyDown={onDialogKeyDown}
      >
        <div className="translator-settings-head">
          <div>
            <h2 className="translator-heading" id="translator-setup-title">
              {onCancel
                ? "Configure your workspace"
                : "Welcome to Stardew i18n Translator"}
            </h2>
            <div
              className="translator-kicker"
              id="translator-setup-description"
            >
              Step {step} of 4 · {stepTitle}
            </div>
          </div>
          {onCancel && (
            <button
              className="translator-icon-button"
              type="button"
              aria-label="Close setup"
              onClick={requestCancel}
              disabled={busy}
            >
              <X aria-hidden="true" />
            </button>
          )}
        </div>

        <div className="translator-settings-layout">
          <ol
            className="translator-settings-nav translator-setup-steps"
            aria-label="Setup steps"
          >
            {SETUP_STEPS.map((item) => {
              const state =
                item.number === step
                  ? "current"
                  : item.number < step
                    ? "complete"
                    : "upcoming";
              const Icon = state === "complete" ? Check : item.icon;
              return (
                <li
                  key={item.number}
                  className="translator-settings-tab translator-setup-step"
                  data-state={state}
                  aria-current={state === "current" ? "step" : undefined}
                >
                  <Icon aria-hidden="true" />
                  <span>
                    <strong>{item.title}</strong>
                    <small>{item.description}</small>
                    {state === "complete" && (
                      <span className="translator-sr-only">Done</span>
                    )}
                  </span>
                </li>
              );
            })}
          </ol>

          <div className="translator-settings-content">
            {step === 1 && (
              <section
                className="translator-settings-page is-active"
                aria-label="Stardew Valley folder"
              >
                <h3>Find your game</h3>
                <p className="translator-settings-intro">
                  The app uses the game folder to find your Mods folder and, if
                  you like, to build a glossary of the game&apos;s official
                  names.
                </p>
                <div className="translator-settings-group">
                  <div className="translator-setting-line">
                    <FolderCopy
                      label="Stardew Valley"
                      path={stardewPath}
                      problem={
                        stardewValid === false
                          ? "This does not look like a Stardew Valley folder."
                          : null
                      }
                    />
                    <span className="translator-setup-actions">
                      {stardewPath && stardewValid === true && (
                        <span className="translator-state is-ready">Found</span>
                      )}
                      <button
                        className="translator-button translator-button-quiet"
                        type="button"
                        onClick={autoDetect}
                        disabled={busy}
                      >
                        {busy ? "Detecting…" : "Auto-detect"}
                      </button>
                      <button
                        className="translator-button translator-button-quiet"
                        type="button"
                        onClick={browseStardew}
                        disabled={busy}
                      >
                        Browse…
                      </button>
                    </span>
                  </div>
                </div>
              </section>
            )}

            {step === 2 && (
              <section
                className="translator-settings-page is-active"
                aria-label="Mods folder"
              >
                <h3>Choose your Mods folder</h3>
                <p className="translator-settings-intro">
                  The app looks in this folder for mods with translation files.
                  Usually this is <code>&lt;Stardew Valley&gt;/Mods</code>.
                  Change it if your mods live elsewhere, for example in Mod
                  Organizer 2&apos;s mods folder.
                </p>
                <div className="translator-settings-group">
                  <div className="translator-setting-line">
                    <FolderCopy label="Mods" path={modsPath} problem={null} />
                    <span className="translator-setup-actions">
                      <button
                        className="translator-button translator-button-quiet"
                        type="button"
                        onClick={browseMods}
                        disabled={busy}
                      >
                        Browse…
                      </button>
                    </span>
                  </div>
                </div>
              </section>
            )}

            {step === 3 && (
              <section
                className="translator-settings-page is-active"
                aria-label="Languages"
              >
                <h3>Set your languages</h3>
                <p className="translator-settings-intro">
                  Mods are written in English. Choose the language you want to
                  translate into.
                </p>
                <div className="translator-settings-group">
                  <div className="translator-setting-line">
                    <span className="translator-setting-copy">
                      <strong>Source language</strong>
                      <span>The English text of each mod</span>
                    </span>
                    <span>{SOURCE_LANGUAGE_LABEL}</span>
                  </div>
                  <label className="translator-setting-line">
                    <span className="translator-setting-copy">
                      <strong>Target language</strong>
                      <span>Used for imports, exports and glossary hints</span>
                    </span>
                    <select
                      className="translator-select"
                      value={targetLang}
                      onChange={(event) => setTargetLang(event.target.value)}
                      aria-label="Target language"
                    >
                      <TargetLanguageOptions />
                    </select>
                  </label>
                </div>
              </section>
            )}

            {step === 4 && (
              <GlossarySettings
                active
                targetLang={targetLang}
                glossary={glossary}
                building={glossaryBuilding}
                error={glossaryError}
                onBuild={() => void handleBuildGlossary()}
                heading={
                  <>
                    <h3>Add a glossary</h3>
                    <p className="translator-settings-intro">
                      Optional. The glossary shows the game&apos;s official
                      names for items, characters and places while you
                      translate, and AI uses them too. Your game files are only
                      read, never changed or uploaded. You can also build it
                      later in Settings.
                    </p>
                  </>
                }
              />
            )}

            {error && (
              <p className="translator-shortcut-error" role="alert">
                {error}
              </p>
            )}
          </div>
        </div>

        <div className="translator-settings-head translator-setup-foot">
          <span>
            {discardPrompt && (
              <span className="translator-settings-discard" role="alert">
                You have unsaved changes.
              </span>
            )}
          </span>
          <div className="translator-settings-actions">
            {onCancel &&
              (discardPrompt ? (
                <>
                  <button
                    className="translator-button translator-button-quiet"
                    type="button"
                    onClick={onCancel}
                    disabled={busy}
                  >
                    Discard changes
                  </button>
                  <button
                    className="translator-button translator-button-quiet"
                    type="button"
                    onClick={() => setDiscardPrompt(false)}
                    disabled={busy}
                  >
                    Keep editing
                  </button>
                </>
              ) : (
                <button
                  className="translator-button translator-button-quiet"
                  type="button"
                  onClick={requestCancel}
                  disabled={busy}
                >
                  Cancel
                </button>
              ))}
            {step > 1 && (
              <button
                className="translator-button translator-button-quiet"
                type="button"
                onClick={() => setStep((step - 1) as Step)}
                disabled={busy}
              >
                Back
              </button>
            )}
            {step < 4 ? (
              <button
                className="translator-button translator-button-primary"
                type="button"
                onClick={() =>
                  step === 1 ? void goToModsStep() : setStep((step + 1) as Step)
                }
                disabled={
                  busy ||
                  (step === 1 && !canLeaveStep1) ||
                  (step === 2 && !canLeaveStep2) ||
                  (step === 3 && !canLeaveStep3)
                }
              >
                Next
              </button>
            ) : (
              <button
                className="translator-button translator-button-primary"
                type="button"
                onClick={() => void finish()}
                disabled={busy}
              >
                {busy ? "Saving…" : "Finish"}
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function FolderCopy({
  label,
  path,
  problem,
}: {
  label: string;
  path: string;
  problem: string | null;
}) {
  return (
    <span className="translator-setting-copy">
      <strong>{label}</strong>
      <span>{path || "No folder selected yet"}</span>
      {problem && <span className="translator-setup-problem">{problem}</span>}
    </span>
  );
}
