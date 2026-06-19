/**
 * Settings dialog — the single "settings section accessible from toolbar"
 * (SPEC §19 #5 / §13). Distinct from the first-launch Setup Wizard: this is a
 * left-navigation window of editable settings, not a step-by-step flow.
 *
 * Sections: folders (changed by re-running the wizard, per SPEC §4), target
 * language, the optional glossary, and the optional local-AI connection (M6).
 * AI lives here — not in the wizard — because this is a translation-first tool
 * and AI is opt-in.
 */
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useState,
} from "react";
import {
  type AppSettings,
  type GlossaryStatus,
  buildGlossary,
  glossaryStatus,
  llmModels,
  openLogsDir,
  openUrl,
} from "../tauri/commands";
import {
  SOURCE_LANGUAGE_LABEL,
  TARGET_LANGUAGES,
  gameSupportsLanguage,
} from "../languages";
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_COMMANDS,
  type ResolvedShortcuts,
  type ShortcutCommand,
  displayShortcut,
  resolveShortcuts,
  shortcutFromEvent,
  shortcutProblem,
} from "../shortcuts";
import packageInfo from "../../package.json";

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

type SettingsPage = "folders" | "ai" | "glossary" | "shortcuts" | "about";

interface LlmConnectionResult {
  kind: "connected" | "empty" | "failed";
  elapsedMs: number;
  error?: string;
}

export function SettingsDialog({
  settings,
  onSave,
  onClose,
  onReRunSetup,
}: SettingsDialogProps) {
  const [page, setPage] = useState<SettingsPage>("folders");
  const [targetLang, setTargetLang] = useState(settings.targetLang ?? "");
  const [shortcuts, setShortcuts] = useState<ResolvedShortcuts>(() =>
    resolveShortcuts(settings.shortcuts),
  );
  const [diagnosticLogging, setDiagnosticLogging] = useState(
    settings.diagnosticLogging !== false,
  );

  const [glossary, setGlossary] = useState<GlossaryStatus | null>(null);
  const [glossaryBuilding, setGlossaryBuilding] = useState(false);
  const [glossaryError, setGlossaryError] = useState<string | null>(null);

  const [llmProvider, setLlmProvider] = useState(
    settings.llm?.provider || "lmstudio",
  );
  const [llmBaseUrl, setLlmBaseUrl] = useState(
    settings.llm?.baseUrl || LLM_PRESETS.lmstudio,
  );
  const [llmModel, setLlmModel] = useState(settings.llm?.model ?? "");
  const [llmModelList, setLlmModelList] = useState<string[] | null>(null);
  const [llmTesting, setLlmTesting] = useState(false);
  const [llmResult, setLlmResult] = useState<LlmConnectionResult | null>(null);
  // Kept as the raw input string; parsed/validated on save ("" = default).
  const [llmTemperature, setLlmTemperature] = useState(
    settings.llm?.temperature != null ? String(settings.llm.temperature) : "",
  );

  // Check unpacked content + the per-language cache (drives the glossary
  // section). Re-runs when the target language changes so the panel reflects the
  // selected language's own `glossary-<lang>.json`.
  useEffect(() => {
    if (!settings.stardewPath) return;
    let active = true;
    glossaryStatus(settings.stardewPath, targetLang)
      .then((status) => active && setGlossary(status))
      .catch(
        () =>
          active &&
          setGlossary({
            gameXnbPresent: false,
            unpackedPresent: false,
            sourceAvailable: false,
            cached: null,
            outdatedCache: false,
            packAvailable: false,
            packXnbAvailable: false,
          }),
      );
    return () => {
      active = false;
    };
  }, [settings.stardewPath, targetLang]);

  async function handleBuildGlossary() {
    if (!settings.stardewPath) return;
    setGlossaryBuilding(true);
    setGlossaryError(null);
    try {
      const info = await buildGlossary(settings.stardewPath, targetLang);
      // A successful rebuild replaces any old cache, clearing the warning. Keep
      // the detected-pack flags so the community-pack panel stays consistent.
      setGlossary((previous) => ({
        gameXnbPresent: previous?.gameXnbPresent ?? false,
        unpackedPresent: previous?.unpackedPresent ?? false,
        sourceAvailable: previous?.sourceAvailable ?? true,
        cached: info,
        outdatedCache: false,
        packAvailable: previous?.packAvailable ?? false,
        packXnbAvailable: previous?.packXnbAvailable ?? false,
        packName: previous?.packName,
      }));
    } catch (cause) {
      setGlossaryError(String(cause));
    } finally {
      setGlossaryBuilding(false);
    }
  }

  function pickLlmProvider(provider: string) {
    setLlmProvider(provider);
    setLlmModelList(null);
    setLlmResult(null);
    if (provider !== "custom") setLlmBaseUrl(LLM_PRESETS[provider]);
  }

  async function testLlmConnection() {
    const startedAt = performance.now();
    setLlmTesting(true);
    setLlmResult(null);
    setLlmModelList(null);
    try {
      const models = await llmModels(llmBaseUrl);
      const elapsedMs = Math.max(0, Math.round(performance.now() - startedAt));
      setLlmModelList(models);
      setLlmResult({
        kind: models.length > 0 ? "connected" : "empty",
        elapsedMs,
      });
      if (models.length > 0 && !models.includes(llmModel))
        setLlmModel(models[0]);
    } catch (cause) {
      setLlmResult({
        kind: "failed",
        elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
        error: String(cause),
      });
    } finally {
      setLlmTesting(false);
    }
  }

  function save() {
    const url = llmBaseUrl.trim();
    // "" or a non-number = use the backend default (0.2).
    const parsedTemperature = Number.parseFloat(llmTemperature);
    const temperature = Number.isFinite(parsedTemperature)
      ? parsedTemperature
      : null;
    onSave({
      ...settings,
      targetLang: targetLang || null,
      shortcuts: Object.fromEntries(
        SHORTCUT_COMMANDS.filter(
          (command) => shortcuts[command.id] !== DEFAULT_SHORTCUTS[command.id],
        ).map((command) => [command.id, shortcuts[command.id]]),
      ),
      diagnosticLogging,
      // Persist the AI connection only once a model is chosen; otherwise null.
      llm:
        url && llmModel
          ? {
              provider: llmProvider,
              baseUrl: url,
              model: llmModel,
              temperature,
            }
          : null,
    });
  }

  return (
    <div
      className="wizard__backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
    >
      <div className="wizard settings">
        <header className="wizard__header">
          <h2>Settings</h2>
        </header>

        <div className="settings__layout">
          <nav
            className="settings__nav"
            aria-label="Settings sections"
            role="tablist"
            aria-orientation="vertical"
          >
            {(
              [
                ["folders", "Folders & Language"],
                ["ai", "Local AI"],
                ["glossary", "Glossary"],
                ["shortcuts", "Shortcuts"],
                ["about", "About"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={page === id}
                aria-controls={`settings-panel-${id}`}
                tabIndex={page === id ? 0 : -1}
                className={page === id ? "settings__nav-item--active" : ""}
                onClick={() => setPage(id)}
              >
                {label}
              </button>
            ))}
          </nav>

          <div className="settings__content">
            {page === "folders" && (
              <section
                id="settings-panel-folders"
                role="tabpanel"
                aria-label="Folders & Language"
              >
                <h3 className="settings__title">Folders & Language</h3>
                <p className="settings__intro">
                  Review the active Stardew installation and translation
                  language.
                </p>

                <div className="settings__group">
                  <h4>Folders</h4>
                  <p className="wizard__path">
                    <span className="wizard__muted">Stardew Valley</span>
                    <code>{settings.stardewPath || "—"}</code>
                  </p>
                  <p className="wizard__path">
                    <span className="wizard__muted">Mods</span>
                    <code>{settings.modsPath || "—"}</code>
                  </p>
                  <div className="wizard__row">
                    <button type="button" onClick={onReRunSetup}>
                      Re-run setup…
                    </button>
                  </div>
                </div>

                <div className="settings__group">
                  <h4>Language</h4>
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
                </div>
              </section>
            )}

            {page === "glossary" && (
              <section
                id="settings-panel-glossary"
                role="tabpanel"
                aria-label="Glossary"
              >
                <h3 className="settings__title">Glossary</h3>
                <p className="settings__intro">
                  Build optional official-term hints from your local Stardew
                  Valley content or an installed community language pack.
                </p>
                {glossary === null ? (
                  <p className="wizard__muted">
                    Checking for local glossary sources…
                  </p>
                ) : targetLang && !gameSupportsLanguage(targetLang) ? (
                  glossary.packAvailable && glossary.sourceAvailable ? (
                    <>
                      <p className="wizard__muted">
                        Stardew Valley doesn’t include this language, but a
                        community language pack was detected
                        {glossary.packName ? ` (${glossary.packName})` : ""}.
                        You can build official-term hints from it.
                      </p>
                      <div className="wizard__row">
                        <button
                          type="button"
                          onClick={handleBuildGlossary}
                          disabled={glossaryBuilding || !targetLang}
                        >
                          {glossaryBuilding
                            ? "Building…"
                            : glossary.cached
                              ? "Rebuild from community pack"
                              : "Build from community pack"}
                        </button>
                      </div>
                      {glossary.cached && (
                        <p className="wizard__ok">
                          ✓ Cached: {glossary.cached.termCount} terms (
                          {glossary.cached.targetLang})
                          {glossary.cached.source === "communityPack" &&
                          glossary.cached.packName
                            ? ` from ${glossary.cached.packName}`
                            : ""}
                          .
                        </p>
                      )}
                    </>
                  ) : glossary.packAvailable ? (
                    <>
                      <p className="wizard__muted">
                        A community language pack was detected
                        {glossary.packName ? ` (${glossary.packName})` : ""},
                        but the app could not read a local English Strings
                        source.
                      </p>
                      <div className="wizard__row">
                        <button
                          type="button"
                          onClick={() =>
                            void openUrl(
                              "https://github.com/Pathoschild/StardewXnbHack",
                            )
                          }
                        >
                          Get StardewXnbHack ↗
                        </button>
                      </div>
                    </>
                  ) : (
                    <p className="wizard__muted">
                      Stardew Valley doesn’t include this language, so no
                      official glossary is available. Translation and export
                      still work fully.
                    </p>
                  )
                ) : glossary.sourceAvailable ? (
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
                    {glossary.outdatedCache && (
                      <p className="wizard__error">
                        An older glossary from a previous version was found —
                        rebuild recommended.
                      </p>
                    )}
                  </>
                ) : (
                  <>
                    <p className="wizard__muted">
                      No glossary-ready game Strings were found. Direct game XNB
                      files are used first; StardewXnbHack is only a fallback
                      when those are unavailable.
                    </p>
                    <div className="wizard__row">
                      <button
                        type="button"
                        onClick={() =>
                          void openUrl(
                            "https://github.com/Pathoschild/StardewXnbHack",
                          )
                        }
                      >
                        Get StardewXnbHack ↗
                      </button>
                    </div>
                  </>
                )}
                {glossaryError && (
                  <p className="wizard__error">{glossaryError}</p>
                )}
              </section>
            )}

            {page === "ai" && (
              <section
                id="settings-panel-ai"
                role="tabpanel"
                aria-label="Local AI"
              >
                <h3 className="settings__title">Local AI connection</h3>
                <p className="settings__intro">
                  Point at a local LLM endpoint (Ollama, LM Studio, or another
                  OpenAI-compatible server) for on-device translation.
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
                      setLlmResult(null);
                    }}
                  />
                </label>
                <div className="wizard__row">
                  <button
                    type="button"
                    onClick={testLlmConnection}
                    disabled={llmTesting || !llmBaseUrl.trim()}
                  >
                    {llmTesting
                      ? "Testing…"
                      : llmResult?.kind === "failed"
                        ? "Retry"
                        : "Test connection"}
                  </button>
                </div>
                {llmModelList !== null &&
                  (llmModelList.length > 0 ? (
                    <>
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
                  ) : null)}
                <label className="wizard__field">
                  <span>Temperature (optional)</span>
                  <input
                    type="number"
                    min="0"
                    max="2"
                    step="0.1"
                    value={llmTemperature}
                    placeholder="0.2 (default)"
                    aria-label="AI temperature"
                    onChange={(event) => setLlmTemperature(event.target.value)}
                  />
                </label>

                {llmResult && (
                  <div
                    className={`settings__connection settings__connection--${llmResult.kind}`}
                    role={llmResult.kind === "failed" ? "alert" : "status"}
                  >
                    <span className="settings__connection-icon">
                      {llmResult.kind === "failed" ? "×" : "✓"}
                    </span>
                    <div>
                      <strong>
                        {llmResult.kind === "connected"
                          ? `Connected · responded in ${llmResult.elapsedMs} ms`
                          : llmResult.kind === "empty"
                            ? `Connected · responded in ${llmResult.elapsedMs} ms`
                            : "Connection failed"}
                      </strong>
                      <p>
                        {llmResult.kind === "connected"
                          ? `${llmModelList?.length ?? 0} model${
                              llmModelList?.length === 1 ? "" : "s"
                            } available · ${llmModel || "select a model"}`
                          : llmResult.kind === "empty"
                            ? "The server reports no loaded models. Load one in your AI app, then test again."
                            : llmResult.error}
                      </p>
                    </div>
                  </div>
                )}

                <p className="settings__hint">
                  Optional. The app works fully without AI. A capable instruct
                  model is recommended; small or heavily modified models may
                  ignore translation rules.
                </p>
              </section>
            )}

            {page === "shortcuts" && (
              <ShortcutsSettings
                shortcuts={shortcuts}
                onChange={setShortcuts}
              />
            )}

            {page === "about" && (
              <section
                id="settings-panel-about"
                role="tabpanel"
                aria-label="About"
              >
                <h3 className="settings__title">Stardew i18n Translator</h3>
                <p className="settings__about-version">
                  Version {packageInfo.version}
                </p>
                <p className="settings__intro">
                  A portable, local-first desktop tool for translating Stardew
                  Valley and SMAPI mod i18n files.
                </p>

                <div className="settings__group">
                  <h4>Project</h4>
                  <dl className="settings__facts">
                    <div>
                      <dt>Author</dt>
                      <dd>Nana</dd>
                    </div>
                    <div>
                      <dt>License</dt>
                      <dd>GPL-3.0-or-later</dd>
                    </div>
                    <div>
                      <dt>Built with</dt>
                      <dd>Tauri, Rust, React, and TypeScript</dd>
                    </div>
                  </dl>
                </div>

                <div className="wizard__row">
                  <button
                    type="button"
                    onClick={() =>
                      void openUrl(
                        "https://github.com/Nana1873/stardew-i18n-translator",
                      )
                    }
                  >
                    Open project on GitHub ↗
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void openUrl(
                        "https://github.com/Nana1873/stardew-i18n-translator/blob/main/LICENSE",
                      )
                    }
                  >
                    View license ↗
                  </button>
                </div>

                <div className="settings__group">
                  <h4>Diagnostics</h4>
                  <p className="settings__hint">
                    Optional rotating logs stay next to the executable and are
                    never sent anywhere. Disabling them reduces the information
                    available when diagnosing a bug.
                  </p>
                  <label className="settings__check">
                    <input
                      type="checkbox"
                      checked={diagnosticLogging}
                      onChange={(event) =>
                        setDiagnosticLogging(event.target.checked)
                      }
                    />
                    Enable local diagnostic logging
                  </label>
                  <div className="wizard__row">
                    <button type="button" onClick={() => void openLogsDir()}>
                      Open logs folder ↗
                    </button>
                  </div>
                </div>

                <p className="settings__hint">
                  Stardew Valley is a trademark of ConcernedApe. This community
                  project is not affiliated with or endorsed by ConcernedApe.
                </p>
              </section>
            )}
          </div>
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

function ShortcutsSettings({
  shortcuts,
  onChange,
}: {
  shortcuts: ResolvedShortcuts;
  onChange: (shortcuts: ResolvedShortcuts) => void;
}) {
  const [capturing, setCapturing] = useState<ShortcutCommand | null>(null);
  const [error, setError] = useState<string | null>(null);

  function capture(
    command: ShortcutCommand,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) {
    event.preventDefault();
    event.stopPropagation();
    const shortcut = shortcutFromEvent(event.nativeEvent);
    if (!shortcut) return;

    const problem = shortcutProblem(shortcut);
    if (problem) {
      setError(problem);
      return;
    }
    const conflict = SHORTCUT_COMMANDS.find(
      (candidate) =>
        candidate.id !== command && shortcuts[candidate.id] === shortcut,
    );
    if (conflict) {
      setError(`Already assigned to “${conflict.label}”.`);
      return;
    }

    onChange({ ...shortcuts, [command]: shortcut });
    setCapturing(null);
    setError(null);
  }

  function reset(command: ShortcutCommand) {
    onChange({ ...shortcuts, [command]: DEFAULT_SHORTCUTS[command] });
    setCapturing(null);
    setError(null);
  }

  return (
    <section
      id="settings-panel-shortcuts"
      role="tabpanel"
      aria-label="Shortcuts"
    >
      <div className="settings__title-row">
        <div>
          <h3 className="settings__title">Keyboard shortcuts</h3>
          <p className="settings__intro">
            Select a shortcut, then press its replacement combination.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            onChange({ ...DEFAULT_SHORTCUTS });
            setCapturing(null);
            setError(null);
          }}
        >
          Reset all
        </button>
      </div>

      {error && (
        <p className="settings__shortcut-error" role="alert">
          {error}
        </p>
      )}

      <div className="settings__shortcut-list">
        {SHORTCUT_COMMANDS.map((command, index) => {
          const startsGroup =
            index === 0 || SHORTCUT_COMMANDS[index - 1].group !== command.group;
          const changed =
            shortcuts[command.id] !== DEFAULT_SHORTCUTS[command.id];
          return (
            <div key={command.id}>
              {startsGroup && (
                <h4 className="settings__shortcut-group">{command.group}</h4>
              )}
              <div className="settings__shortcut-row">
                <span>{command.label}</span>
                <button
                  type="button"
                  className={
                    capturing === command.id
                      ? "settings__shortcut-capture settings__shortcut-capture--active"
                      : "settings__shortcut-capture"
                  }
                  aria-label={`Change ${command.label}`}
                  aria-pressed={capturing === command.id}
                  onClick={() => {
                    setCapturing(command.id);
                    setError(null);
                  }}
                  onKeyDown={(event) => {
                    if (capturing === command.id) capture(command.id, event);
                  }}
                >
                  {capturing === command.id
                    ? "Press keys…"
                    : displayShortcut(shortcuts[command.id])}
                </button>
                <button
                  type="button"
                  className="settings__shortcut-reset"
                  aria-label={`Reset ${command.label}`}
                  disabled={!changed}
                  onClick={() => reset(command.id)}
                >
                  Reset
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <p className="settings__hint">
        Window and developer combinations such as Alt+F4 and Ctrl+Shift+I are
        reserved. Plain letters require Ctrl, Shift, or Alt so typing in the
        editor remains safe.
      </p>
    </section>
  );
}
