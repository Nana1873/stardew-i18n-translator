/**
 * Settings dialog — the single "settings section accessible from toolbar"
 * (SPEC §19 #5 / §13). Distinct from the first-launch Setup Wizard: this is a
 * flat list of editable settings, not a step-by-step flow.
 *
 * Sections: folders (changed by re-running the wizard, per SPEC §4), target
 * language, the optional glossary, and the optional local-AI connection (M6).
 * AI lives here — not in the wizard — because this is a translation-first tool
 * and AI is opt-in.
 */
import { useEffect, useState } from "react";
import {
  type AppSettings,
  type GlossaryStatus,
  buildGlossary,
  glossaryStatus,
  llmModels,
  openUrl,
} from "../tauri/commands";
import { SOURCE_LANGUAGE_LABEL, TARGET_LANGUAGES } from "../languages";

const LLM_PRESETS: Record<string, string> = {
  lmstudio: "http://localhost:1234/v1",
  ollama: "http://localhost:11434/v1",
  custom: "",
};

interface SettingsDialogProps {
  settings: AppSettings;
  onSave: (settings: AppSettings) => void;
  onClose: () => void;
  /** Re-open the first-launch wizard to change folders (SPEC §4). */
  onReRunSetup: () => void;
}

export function SettingsDialog({
  settings,
  onSave,
  onClose,
  onReRunSetup,
}: SettingsDialogProps) {
  const [targetLang, setTargetLang] = useState(settings.targetLang ?? "");

  const [glossary, setGlossary] = useState<GlossaryStatus | null>(null);
  const [glossaryBuilding, setGlossaryBuilding] = useState(false);
  const [glossaryError, setGlossaryError] = useState<string | null>(null);

  const [llmProvider, setLlmProvider] = useState(settings.llm?.provider || "lmstudio");
  const [llmBaseUrl, setLlmBaseUrl] = useState(
    settings.llm?.baseUrl || LLM_PRESETS.lmstudio,
  );
  const [llmModel, setLlmModel] = useState(settings.llm?.model ?? "");
  const [llmModelList, setLlmModelList] = useState<string[] | null>(null);
  const [llmTesting, setLlmTesting] = useState(false);
  const [llmError, setLlmError] = useState<string | null>(null);

  // Check for StardewXnbHack-unpacked content (drives the glossary section).
  useEffect(() => {
    if (!settings.stardewPath) return;
    let active = true;
    glossaryStatus(settings.stardewPath)
      .then((status) => active && setGlossary(status))
      .catch(() => active && setGlossary({ unpackedPresent: false, cached: null }));
    return () => {
      active = false;
    };
  }, [settings.stardewPath]);

  async function handleBuildGlossary() {
    if (!settings.stardewPath) return;
    setGlossaryBuilding(true);
    setGlossaryError(null);
    try {
      const info = await buildGlossary(settings.stardewPath, targetLang);
      setGlossary({ unpackedPresent: true, cached: info });
    } catch (cause) {
      setGlossaryError(String(cause));
    } finally {
      setGlossaryBuilding(false);
    }
  }

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
      if (models.length > 0 && !models.includes(llmModel)) setLlmModel(models[0]);
    } catch (cause) {
      setLlmError(String(cause));
    } finally {
      setLlmTesting(false);
    }
  }

  function save() {
    const url = llmBaseUrl.trim();
    onSave({
      ...settings,
      targetLang: targetLang || null,
      // Persist the AI connection only once a model is chosen; otherwise null.
      llm: url && llmModel ? { provider: llmProvider, baseUrl: url, model: llmModel } : null,
    });
  }

  return (
    <div className="wizard__backdrop" role="dialog" aria-modal="true" aria-label="Settings">
      <div className="wizard">
        <header className="wizard__header">
          <h2>Settings</h2>
        </header>

        <div className="wizard__body settings__body">
          <section className="settings__section" aria-label="Folders">
            <h3 className="settings__head">Folders</h3>
            <p className="wizard__path">
              <span className="wizard__muted">Stardew Valley: </span>
              <code>{settings.stardewPath || "—"}</code>
            </p>
            <p className="wizard__path">
              <span className="wizard__muted">Mods: </span>
              <code>{settings.modsPath || "—"}</code>
            </p>
            <div className="wizard__row">
              <button type="button" onClick={onReRunSetup}>
                Re-run setup…
              </button>
            </div>
          </section>

          <section className="settings__section" aria-label="Language">
            <h3 className="settings__head">Language</h3>
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

          <section className="settings__section" aria-label="Glossary">
            <h3 className="settings__head">Glossary (optional)</h3>
            {glossary === null ? (
              <p className="wizard__muted">Checking for unpacked game content…</p>
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
                  <p className="wizard__ok">
                    ✓ Cached: {glossary.cached.termCount} terms (
                    {glossary.cached.targetLang}).
                  </p>
                )}
              </>
            ) : (
              <>
                <p className="wizard__muted">
                  No unpacked game content found. The glossary is built from a{" "}
                  <code>Content (unpacked)/</code> folder created by StardewXnbHack.
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
            {glossaryError && <p className="wizard__error">{glossaryError}</p>}
          </section>

          <section className="settings__section" aria-label="Local AI">
            <h3 className="settings__head">Local AI (optional)</h3>
            <p className="wizard__muted">
              Connect a local AI server (LM Studio, Ollama, or any OpenAI-compatible
              endpoint) to translate strings offline. The app works fully without it.
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
                  Connected, but the server reports no loaded models. Load a model in
                  your AI app, then test again.
                </p>
              ))}
            {llmError && <p className="wizard__error">{llmError}</p>}
          </section>
        </div>

        <footer className="wizard__footer">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <span className="wizard__spacer" />
          <button type="button" className="wizard__finish" onClick={save}>
            Save
          </button>
        </footer>
      </div>
    </div>
  );
}
