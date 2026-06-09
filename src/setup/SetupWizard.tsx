/**
 * Setup Wizard — M1 / Issue 3 (SPEC §4) + M6 / Issue 15 (local-LLM connection).
 *
 * Modal, 5 steps: Stardew folder → Mods folder → languages → optional glossary →
 * optional local AI. Binds to the typed Tauri commands. The Mods-folder step is a
 * generic folder override only — explicitly NOT Vortex/MO2 support (SPEC §4).
 */
import { useEffect, useState } from "react";
import {
  type AppSettings,
  type GlossaryInfo,
  type GlossaryStatus,
  buildGlossary,
  defaultModsPath,
  detectStardew,
  glossaryStatus,
  llmModels,
  openUrl,
  pickFolder,
  validateStardewPath,
} from "../tauri/commands";
import { SOURCE_LANGUAGE_LABEL, TARGET_LANGUAGES } from "../languages";

type Step = 1 | 2 | 3 | 4 | 5;
const STEP_COUNT = 5;

/** OpenAI-compatible default base URLs. "custom" lets the user type their own. */
const LLM_PRESETS: Record<string, string> = {
  lmstudio: "http://localhost:1234/v1",
  ollama: "http://localhost:11434/v1",
  custom: "",
};

interface SetupWizardProps {
  initial: AppSettings | null;
  onComplete: (settings: AppSettings) => void;
  /** Provided only when settings already exist (wizard re-opened from Settings). */
  onCancel?: () => void;
}

export function SetupWizard({ initial, onComplete, onCancel }: SetupWizardProps) {
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

  const [llmProvider, setLlmProvider] = useState(initial?.llm?.provider || "lmstudio");
  const [llmBaseUrl, setLlmBaseUrl] = useState(
    initial?.llm?.baseUrl || LLM_PRESETS.lmstudio,
  );
  const [llmModel, setLlmModel] = useState(initial?.llm?.model ?? "");
  const [llmModelList, setLlmModelList] = useState<string[] | null>(null);
  const [llmTesting, setLlmTesting] = useState(false);
  const [llmError, setLlmError] = useState<string | null>(null);

  function pickLlmProvider(provider: string) {
    setLlmProvider(provider);
    setLlmModelList(null);
    setLlmError(null);
    if (provider !== "custom") setLlmBaseUrl(LLM_PRESETS[provider]);
  }

  async function testLlmConnection() {
    setLlmTesting(true);
    setLlmError(null);
    setLlmModelList(null);
    try {
      const models = await llmModels(llmBaseUrl);
      setLlmModelList(models);
      // Keep a still-valid selection; otherwise default to the first model.
      if (models.length > 0 && !models.includes(llmModel)) setLlmModel(models[0]);
    } catch (cause) {
      setLlmError(String(cause));
    } finally {
      setLlmTesting(false);
    }
  }

  // On the glossary step, check whether StardewXnbHack-unpacked content exists.
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
        setError("Could not auto-detect Stardew Valley. Use Browse to locate it.");
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
        /* leave empty; user can browse */
      }
    }
    setStep(2);
  }

  function finish() {
    const url = llmBaseUrl.trim();
    onComplete({
      stardewPath,
      modsPath,
      sourceLang: "default",
      targetLang,
      // Persist the AI connection only once a model is chosen (i.e. the user
      // tested and picked one). Skipping the step leaves it null = not configured.
      llm: url && llmModel ? { provider: llmProvider, baseUrl: url, model: llmModel } : null,
    });
  }

  const canLeaveStep1 = stardewValid === true && stardewPath !== "";
  const canLeaveStep2 = modsPath !== "";
  const canLeaveStep3 = targetLang !== "";

  return (
    <div className="wizard__backdrop" role="dialog" aria-modal="true" aria-label="Setup">
      <div className="wizard">
        <header className="wizard__header">
          <h2>Setup</h2>
          <span className="wizard__progress">
            Step {step} of {STEP_COUNT}
          </span>
        </header>

        <div className="wizard__body">
          {step === 1 && (
            <section aria-label="Stardew Valley folder">
              <p>Locate your Stardew Valley installation.</p>
              <div className="wizard__row">
                <button type="button" onClick={autoDetect} disabled={busy}>
                  Auto-detect
                </button>
                <button type="button" onClick={browseStardew} disabled={busy}>
                  Browse…
                </button>
              </div>
              <PathDisplay path={stardewPath} valid={stardewValid} />
            </section>
          )}

          {step === 2 && (
            <section aria-label="Mods folder">
              <p>
                The Mods folder defaults to <code>&lt;Stardew Valley&gt;/Mods</code>.
                Override it only if the default is wrong.
              </p>
              <div className="wizard__row">
                <button type="button" onClick={browseMods} disabled={busy}>
                  Browse…
                </button>
              </div>
              <PathDisplay path={modsPath} valid={modsPath ? true : null} />
            </section>
          )}

          {step === 3 && (
            <section aria-label="Languages">
              <label className="wizard__field">
                <span>Source language</span>
                <input type="text" value={SOURCE_LANGUAGE_LABEL} disabled />
              </label>
              <label className="wizard__field">
                <span>Target language</span>
                <select
                  value={targetLang}
                  onChange={(event) => setTargetLang(event.target.value)}
                  aria-label="Target language"
                >
                  <option value="" disabled>
                    Choose a language…
                  </option>
                  {TARGET_LANGUAGES.map((language) => (
                    <option key={language.code} value={language.code}>
                      {language.label}
                    </option>
                  ))}
                </select>
              </label>
            </section>
          )}

          {step === 4 && (
            <section aria-label="Glossary">
              <p>
                <strong>Optional:</strong> build the official game glossary for
                translation hints. The app works fully without it — you can skip
                this step.
              </p>
              {glossary === null ? (
                <p className="wizard__muted">Checking for unpacked game content…</p>
              ) : glossaryBuilt ? (
                <p className="wizard__ok">
                  ✓ Glossary built: {glossaryBuilt.termCount} terms (
                  {glossaryBuilt.targetLang}).
                </p>
              ) : glossary.unpackedPresent ? (
                <>
                  <div className="wizard__row">
                    <button
                      type="button"
                      onClick={handleBuildGlossary}
                      disabled={glossaryBuilding || !targetLang}
                    >
                      {glossaryBuilding ? "Building…" : "Build glossary"}
                    </button>
                  </div>
                  {glossary.cached && (
                    <p className="wizard__muted">
                      Cached: {glossary.cached.termCount} terms (
                      {glossary.cached.targetLang}).
                    </p>
                  )}
                </>
              ) : (
                <>
                  <p className="wizard__muted">
                    No unpacked game content found. The glossary is built from a{" "}
                    <code>Content (unpacked)/</code> folder created by
                    StardewXnbHack — run it once, then re-open Setup.
                  </p>
                  <div className="wizard__row">
                    <button
                      type="button"
                      onClick={() =>
                        void openUrl("https://github.com/Pathoschild/StardewXnbHack")
                      }
                    >
                      Get StardewXnbHack ↗
                    </button>
                  </div>
                </>
              )}
            </section>
          )}

          {step === 5 && (
            <section aria-label="Local AI">
              <p>
                <strong>Optional:</strong> connect a local AI server (LM Studio,
                Ollama, or any OpenAI-compatible endpoint) to translate strings
                offline. The app works fully without it — you can skip this step.
              </p>
              <label className="wizard__field">
                <span>Provider</span>
                <select
                  value={llmProvider}
                  onChange={(event) => pickLlmProvider(event.target.value)}
                  aria-label="AI provider"
                >
                  <option value="lmstudio">LM Studio</option>
                  <option value="ollama">Ollama</option>
                  <option value="custom">Custom (OpenAI-compatible)</option>
                </select>
              </label>
              <label className="wizard__field">
                <span>Base URL</span>
                <input
                  type="text"
                  value={llmBaseUrl}
                  placeholder="http://localhost:1234/v1"
                  aria-label="AI base URL"
                  onChange={(event) => {
                    setLlmBaseUrl(event.target.value);
                    setLlmModelList(null);
                    setLlmError(null);
                  }}
                />
              </label>
              <div className="wizard__row">
                <button
                  type="button"
                  onClick={testLlmConnection}
                  disabled={llmTesting || !llmBaseUrl.trim()}
                >
                  {llmTesting ? "Testing…" : "Test connection"}
                </button>
              </div>
              {llmModelList !== null &&
                (llmModelList.length > 0 ? (
                  <>
                    <p className="wizard__ok">
                      ✓ Connected — {llmModelList.length} model
                      {llmModelList.length === 1 ? "" : "s"} available.
                    </p>
                    <label className="wizard__field">
                      <span>Model</span>
                      <select
                        value={llmModel}
                        onChange={(event) => setLlmModel(event.target.value)}
                        aria-label="AI model"
                      >
                        {llmModelList.map((model) => (
                          <option key={model} value={model}>
                            {model}
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                ) : (
                  <p className="wizard__muted">
                    Connected, but the server reports no loaded models. Load a model
                    in your AI app, then test again.
                  </p>
                ))}
              {llmError && <p className="wizard__error">{llmError}</p>}
            </section>
          )}

          {error && <p className="wizard__error">{error}</p>}
        </div>

        <footer className="wizard__footer">
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
            <button type="button" onClick={goToModsStep} disabled={!canLeaveStep1}>
              Next
            </button>
          )}
          {step === 2 && (
            <button type="button" onClick={() => setStep(3)} disabled={!canLeaveStep2}>
              Next
            </button>
          )}
          {step === 3 && (
            <button type="button" onClick={() => setStep(4)} disabled={!canLeaveStep3}>
              Next
            </button>
          )}
          {step === 4 && (
            <button type="button" onClick={() => setStep(5)}>
              Next
            </button>
          )}
          {step === 5 && (
            <button type="button" className="wizard__finish" onClick={finish}>
              Finish
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

function PathDisplay({ path, valid }: { path: string; valid: boolean | null }) {
  if (!path) {
    return <p className="wizard__path wizard__path--empty">No folder selected.</p>;
  }
  return (
    <p className={`wizard__path${valid === false ? " wizard__path--invalid" : ""}`}>
      <code>{path}</code>
      {valid === true && <span className="wizard__ok"> ✓</span>}
      {valid === false && (
        <span className="wizard__bad"> — not a Stardew Valley folder</span>
      )}
    </p>
  );
}
