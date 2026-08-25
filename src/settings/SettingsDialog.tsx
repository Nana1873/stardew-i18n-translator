import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  BookOpen,
  Cloud,
  Folder,
  HardDrive,
  Info,
  Keyboard,
  RefreshCw,
  Sparkles,
  SquareTerminal,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  type AppSettings,
  type GlossaryStatus,
  buildGlossary,
  glossaryStatus,
  llmModels,
  openLogsDir,
  openUrl,
  pickFolder,
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
import { useDialogAccessibility } from "../dialogAccessibility";
import packageInfo from "../../package.json";

const LLM_PRESETS: Record<string, string> = {
  lmstudio: "http://localhost:1234/v1",
  ollama: "http://localhost:11434/v1",
  custom: "",
};

export type SettingsPage =
  "folders" | "ai" | "glossary" | "shortcuts" | "about";

interface SettingsPageDefinition {
  id: SettingsPage;
  label: string;
  icon: LucideIcon;
}

const SETTINGS_PAGES: readonly SettingsPageDefinition[] = [
  { id: "folders", label: "Folders & language", icon: Folder },
  { id: "ai", label: "Translation engines", icon: Sparkles },
  { id: "glossary", label: "Glossary", icon: BookOpen },
  { id: "shortcuts", label: "Shortcuts", icon: Keyboard },
  { id: "about", label: "About", icon: Info },
];

interface SettingsDialogProps {
  settings: AppSettings;
  onSave: (settings: AppSettings) => Promise<void> | void;
  onClose: () => void;
  onReRunSetup: () => void;
  initialPage?: SettingsPage;
}

interface LlmConnectionResult {
  kind: "connected" | "empty" | "failed";
  elapsedMs: number;
  error?: string;
}

type EnginePanel = "local" | "codex" | "api";

export function SettingsDialog({
  settings,
  onSave,
  onClose,
  onReRunSetup,
  initialPage = "folders",
}: SettingsDialogProps) {
  const [page, setPage] = useState<SettingsPage>(initialPage);
  const [enginePanel, setEnginePanel] = useState<EnginePanel>("local");
  const [stardewPath, setStardewPath] = useState(settings.stardewPath ?? "");
  const [modsPath, setModsPath] = useState(settings.modsPath ?? "");
  const [folderPicking, setFolderPicking] = useState<"stardew" | "mods" | null>(
    null,
  );
  const [folderError, setFolderError] = useState<string | null>(null);
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
  const [llmTemperature, setLlmTemperature] = useState(
    settings.llm?.temperature != null ? String(settings.llm.temperature) : "",
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const llmRequest = useRef(0);
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(
    () => () => {
      llmRequest.current += 1;
    },
    [],
  );

  const { onDialogKeyDown } = useDialogAccessibility({
    dialogRef,
    onEscape: onClose,
    escapeDisabled: saving || folderPicking !== null,
    initialFocusSelector: '[role="tab"][aria-selected="true"]',
  });

  useEffect(() => {
    if (!stardewPath) {
      setGlossary({
        gameXnbPresent: false,
        unpackedPresent: false,
        sourceAvailable: false,
        cached: null,
        outdatedCache: false,
        packAvailable: false,
        packXnbAvailable: false,
      });
      return;
    }
    let active = true;
    glossaryStatus(stardewPath, targetLang)
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
  }, [stardewPath, targetLang]);

  async function handleBuildGlossary() {
    if (!stardewPath || !targetLang) return;
    setGlossaryBuilding(true);
    setGlossaryError(null);
    try {
      const info = await buildGlossary(stardewPath, targetLang);
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

  async function changeFolder(kind: "stardew" | "mods") {
    setFolderPicking(kind);
    setFolderError(null);
    try {
      const path = await pickFolder(
        kind === "stardew"
          ? "Select your Stardew Valley folder"
          : "Select your Mods folder",
      );
      if (!path) return;
      if (kind === "stardew") setStardewPath(path);
      else setModsPath(path);
    } catch {
      setFolderError("Could not open the folder picker.");
    } finally {
      setFolderPicking(null);
    }
  }

  function pickLlmProvider(provider: string) {
    llmRequest.current += 1;
    setLlmProvider(provider);
    setLlmModelList(null);
    setLlmResult(null);
    setLlmModel("");
    setLlmTesting(false);
    if (provider !== "custom") setLlmBaseUrl(LLM_PRESETS[provider]);
  }

  function changeLlmUrl(value: string) {
    llmRequest.current += 1;
    setLlmBaseUrl(value);
    setLlmModelList(null);
    setLlmResult(null);
    setLlmModel("");
    setLlmTesting(false);
  }

  async function testLlmConnection() {
    const request = ++llmRequest.current;
    const testedUrl = llmBaseUrl.trim();
    const startedAt = performance.now();
    setLlmTesting(true);
    setLlmResult(null);
    setLlmModelList(null);
    try {
      const models = await llmModels(testedUrl);
      if (request !== llmRequest.current || testedUrl !== llmBaseUrl.trim())
        return;
      const elapsedMs = Math.max(0, Math.round(performance.now() - startedAt));
      setLlmModelList(models);
      setLlmResult({
        kind: models.length > 0 ? "connected" : "empty",
        elapsedMs,
      });
      if (models.length > 0 && !models.includes(llmModel))
        setLlmModel(models[0]);
    } catch (cause) {
      if (request !== llmRequest.current || testedUrl !== llmBaseUrl.trim())
        return;
      setLlmResult({
        kind: "failed",
        elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
        error: String(cause),
      });
    } finally {
      if (request === llmRequest.current) setLlmTesting(false);
    }
  }

  async function save() {
    const url = llmBaseUrl.trim();
    const parsedTemperature = Number.parseFloat(llmTemperature);
    const temperature = Number.isFinite(parsedTemperature)
      ? parsedTemperature
      : null;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave({
        ...settings,
        stardewPath: stardewPath || null,
        modsPath: modsPath || null,
        targetLang: targetLang || null,
        shortcuts: Object.fromEntries(
          SHORTCUT_COMMANDS.filter(
            (command) =>
              shortcuts[command.id] !== DEFAULT_SHORTCUTS[command.id],
          ).map((command) => [command.id, shortcuts[command.id]]),
        ),
        diagnosticLogging,
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
    } catch (cause) {
      setSaveError(String(cause));
    } finally {
      setSaving(false);
    }
  }

  function onTabKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    current: SettingsPage,
  ) {
    const index = SETTINGS_PAGES.findIndex(({ id }) => id === current);
    let next = index;
    if (event.key === "ArrowDown") next = (index + 1) % SETTINGS_PAGES.length;
    else if (event.key === "ArrowUp")
      next = (index - 1 + SETTINGS_PAGES.length) % SETTINGS_PAGES.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = SETTINGS_PAGES.length - 1;
    else return;

    event.preventDefault();
    setPage(SETTINGS_PAGES[next].id);
    event.currentTarget.parentElement
      ?.querySelectorAll<HTMLElement>('[role="tab"]')
      [next]?.focus();
  }

  const modelOptions = Array.from(
    new Set([...(llmModel ? [llmModel] : []), ...(llmModelList ?? [])]),
  );

  return (
    <div className="stv3-settings-overlay">
      <section
        ref={dialogRef}
        className="stv3-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="stv3-settings-title"
        aria-describedby="stv3-settings-description"
        onKeyDown={onDialogKeyDown}
      >
        <div className="stv3-settings-head">
          <div>
            <h2 className="stv3-heading" id="stv3-settings-title">
              Settings
            </h2>
            <div className="stv3-kicker" id="stv3-settings-description">
              Stored locally beside the application
            </div>
          </div>
          <button
            className="stv3-icon-button"
            type="button"
            aria-label="Close settings"
            onClick={onClose}
            disabled={saving || folderPicking !== null}
          >
            <X aria-hidden="true" />
          </button>
        </div>

        <div className="stv3-settings-layout">
          <nav
            className="stv3-settings-nav"
            aria-label="Settings sections"
            role="tablist"
            aria-orientation="vertical"
          >
            {SETTINGS_PAGES.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                className="stv3-settings-tab"
                type="button"
                role="tab"
                aria-selected={page === id}
                aria-pressed={page === id}
                aria-controls={"settings-panel-" + id}
                tabIndex={page === id ? 0 : -1}
                onClick={() => setPage(id)}
                onKeyDown={(event) => onTabKeyDown(event, id)}
                disabled={saving || folderPicking !== null}
              >
                <Icon aria-hidden="true" /> {label}
              </button>
            ))}
          </nav>

          <div className="stv3-settings-content">
            <section
              id="settings-panel-folders"
              className={
                "stv3-settings-page" + (page === "folders" ? " is-active" : "")
              }
              role="tabpanel"
              aria-label="Folders & language"
              hidden={page !== "folders"}
            >
              <h3>Folders & language</h3>
              <p className="stv3-settings-intro">
                The app only reads mods and game content from the selected
                folders.
              </p>
              <div className="stv3-settings-group">
                <div className="stv3-setting-line">
                  <span className="stv3-setting-copy">
                    <strong>Stardew Valley</strong>
                    <span>{stardewPath || "Unavailable"}</span>
                  </span>
                  <button
                    className="stv3-button stv3-button-quiet"
                    type="button"
                    aria-label="Change Stardew Valley folder"
                    aria-busy={folderPicking === "stardew"}
                    onClick={() => void changeFolder("stardew")}
                    disabled={saving || folderPicking !== null}
                  >
                    Change
                  </button>
                </div>
                <div className="stv3-setting-line">
                  <span className="stv3-setting-copy">
                    <strong>Mods</strong>
                    <span>{modsPath || "Unavailable"}</span>
                  </span>
                  <button
                    className="stv3-button stv3-button-quiet"
                    type="button"
                    aria-label="Change Mods folder"
                    aria-busy={folderPicking === "mods"}
                    onClick={() => void changeFolder("mods")}
                    disabled={saving || folderPicking !== null}
                  >
                    Change
                  </button>
                </div>
                <div className="stv3-setting-line">
                  <span className="stv3-setting-copy">
                    <strong>Source language</strong>
                    <span>
                      From <code>i18n/default.json</code>
                    </span>
                  </span>
                  <span>{SOURCE_LANGUAGE_LABEL}</span>
                </div>
                <label className="stv3-setting-line">
                  <span className="stv3-setting-copy">
                    <strong>Target language</strong>
                    <span>Standard or curated custom language code</span>
                  </span>
                  <select
                    className="stv3-select"
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
                <div className="stv3-setting-line">
                  <span className="stv3-setting-copy">
                    <strong>Run setup again</strong>
                    <span>
                      Game folder, Mods folder, language, and optional glossary
                    </span>
                  </span>
                  <button
                    className="stv3-button stv3-button-quiet"
                    type="button"
                    onClick={onReRunSetup}
                    disabled={saving || folderPicking !== null}
                  >
                    Setup …
                  </button>
                </div>
                {folderError && (
                  <p className="stv3-shortcut-error" role="alert">
                    {folderError}
                  </p>
                )}
              </div>
            </section>

            <section
              id="settings-panel-ai"
              className={
                "stv3-settings-page" + (page === "ai" ? " is-active" : "")
              }
              role="tabpanel"
              aria-label="Translation engines"
              hidden={page !== "ai"}
            >
              <h3>Translation engines</h3>
              <p className="stv3-settings-intro">
                Local AI is available for the quick editor and batch actions.
                Every AI output enters Review.
              </p>
              <div
                className="stv3-engine-list"
                role="group"
                aria-label="Translation engine details"
              >
                <button
                  className="stv3-engine-card"
                  type="button"
                  aria-pressed={enginePanel === "local"}
                  onClick={() => setEnginePanel("local")}
                >
                  <HardDrive aria-hidden="true" />
                  <span>
                    <strong>Local AI</strong>
                    <span>
                      {llmResult?.kind === "connected"
                        ? "Ready · localhost"
                        : settings.llm
                          ? "Configured · localhost"
                          : "Not configured · localhost"}
                    </span>
                  </span>
                </button>
                <button
                  className="stv3-engine-card"
                  type="button"
                  aria-pressed={enginePanel === "codex"}
                  aria-disabled="true"
                  onClick={() => setEnginePanel("codex")}
                >
                  <SquareTerminal aria-hidden="true" />
                  <span>
                    <strong>Codex CLI</strong>
                    <span>Unavailable</span>
                  </span>
                </button>
                <button
                  className="stv3-engine-card"
                  type="button"
                  aria-pressed={enginePanel === "api"}
                  aria-disabled="true"
                  onClick={() => setEnginePanel("api")}
                >
                  <Cloud aria-hidden="true" />
                  <span>
                    <strong>OpenAI API</strong>
                    <span>Unavailable</span>
                  </span>
                </button>
              </div>

              <section
                className={
                  "stv3-engine-panel" +
                  (enginePanel === "local" ? " is-active" : "")
                }
                aria-label="Local AI"
                hidden={enginePanel !== "local"}
              >
                <div className="stv3-settings-group">
                  <label className="stv3-setting-line">
                    <span className="stv3-setting-copy">
                      <strong>Local service</strong>
                      <span>Localhost only</span>
                    </span>
                    <select
                      className="stv3-select"
                      value={llmProvider}
                      onChange={(event) => pickLlmProvider(event.target.value)}
                      aria-label="AI provider"
                    >
                      <option value="lmstudio">LM Studio</option>
                      <option value="ollama">Ollama</option>
                      <option value="custom">Custom (OpenAI-compatible)</option>
                    </select>
                  </label>
                  <label className="stv3-setting-line">
                    <span className="stv3-setting-copy">
                      <strong>Base URL</strong>
                      <span>Local endpoint</span>
                    </span>
                    <input
                      className="stv3-setting-input"
                      value={llmBaseUrl}
                      placeholder="http://localhost:1234/v1"
                      aria-label="AI base URL"
                      onChange={(event) => changeLlmUrl(event.target.value)}
                    />
                  </label>
                  <label className="stv3-setting-line">
                    <span className="stv3-setting-copy">
                      <strong>Model</strong>
                      <span>Available after a successful connection test</span>
                    </span>
                    <select
                      className="stv3-select"
                      value={llmModel}
                      onChange={(event) => setLlmModel(event.target.value)}
                      aria-label="AI model"
                      disabled={modelOptions.length === 0}
                    >
                      {modelOptions.length === 0 && (
                        <option value="">Unavailable</option>
                      )}
                      {modelOptions.map((model) => (
                        <option key={model} value={model}>
                          {model}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="stv3-setting-line">
                    <span className="stv3-setting-copy">
                      <strong>Temperature</strong>
                      <span>
                        {llmTemperature || "0.2"} · range 0–2
                        {!llmTemperature && " · backend default"}
                      </span>
                    </span>
                    <input
                      type="range"
                      min="0"
                      max="2"
                      step="0.1"
                      value={llmTemperature || "0.2"}
                      aria-label="AI temperature"
                      onChange={(event) =>
                        setLlmTemperature(event.target.value)
                      }
                    />
                    <button
                      className="stv3-button stv3-button-quiet"
                      type="button"
                      onClick={() => setLlmTemperature("")}
                      disabled={!llmTemperature}
                    >
                      Use default
                    </button>
                  </div>
                  <div
                    className="stv3-setting-line"
                    role={llmResult?.kind === "failed" ? "alert" : "status"}
                  >
                    <span className="stv3-setting-copy">
                      <strong>Connection</strong>
                      <span>
                        {llmResult?.kind === "connected"
                          ? "Connected · responded in " +
                            llmResult.elapsedMs +
                            " ms · " +
                            (llmModelList?.length ?? 0) +
                            ((llmModelList?.length ?? 0) === 1
                              ? " model available"
                              : " models available")
                          : llmResult?.kind === "empty"
                            ? "Connected · responded in " +
                              llmResult.elapsedMs +
                              " ms · the server reports no loaded models"
                            : llmResult?.kind === "failed"
                              ? "Connection failed · " + llmResult.error
                              : settings.llm
                                ? "Configured · not tested in this session"
                                : "Not configured"}
                      </span>
                    </span>
                    <button
                      className="stv3-button stv3-button-quiet"
                      type="button"
                      onClick={() => void testLlmConnection()}
                      disabled={llmTesting || !llmBaseUrl.trim()}
                    >
                      {llmTesting
                        ? "Testing…"
                        : llmResult?.kind === "failed"
                          ? "Retry"
                          : "Test connection"}
                    </button>
                  </div>
                </div>
                <p className="stv3-kicker">
                  If the service is unavailable, manual translation, import, and
                  export remain fully available.
                </p>
              </section>

              <section
                className={
                  "stv3-engine-panel" +
                  (enginePanel === "codex" ? " is-active" : "")
                }
                aria-label="Codex CLI unavailable"
                hidden={enginePanel !== "codex"}
              >
                <div className="stv3-settings-group">
                  <div className="stv3-setting-line">
                    <span className="stv3-setting-copy">
                      <strong>Codex CLI status</strong>
                      <span>Unavailable in this backend phase</span>
                    </span>
                    <button
                      className="stv3-button stv3-button-quiet"
                      type="button"
                      disabled
                    >
                      Check status
                    </button>
                  </div>
                  <label className="stv3-setting-line">
                    <span className="stv3-setting-copy">
                      <strong>Model</strong>
                      <span>No provider bridge is configured</span>
                    </span>
                    <input
                      className="stv3-setting-input"
                      value="Unavailable"
                      disabled
                      readOnly
                    />
                  </label>
                  <label className="stv3-setting-line">
                    <span className="stv3-setting-copy">
                      <strong>Reasoning</strong>
                      <span>Unavailable</span>
                    </span>
                    <select className="stv3-select" disabled>
                      <option>Unavailable</option>
                    </select>
                  </label>
                  <div className="stv3-setting-line">
                    <span className="stv3-setting-copy">
                      <strong>Authentication</strong>
                      <span>No account or authentication files are read</span>
                    </span>
                    <span className="stv3-state is-change">Unavailable</span>
                  </div>
                </div>
                <p className="stv3-kicker">
                  These controls are retained from the accepted V3 interface.
                  They do not persist settings or simulate a provider.
                </p>
              </section>

              <section
                className={
                  "stv3-engine-panel" +
                  (enginePanel === "api" ? " is-active" : "")
                }
                aria-label="OpenAI API unavailable"
                hidden={enginePanel !== "api"}
              >
                <div className="stv3-settings-group">
                  <label className="stv3-setting-line">
                    <span className="stv3-setting-copy">
                      <strong>API key</strong>
                      <span>Unavailable; no key is accepted or stored</span>
                    </span>
                    <input
                      className="stv3-setting-input"
                      type="password"
                      placeholder="Unavailable"
                      disabled
                    />
                  </label>
                  <label className="stv3-setting-line">
                    <span className="stv3-setting-copy">
                      <strong>Model ID</strong>
                      <span>No cloud provider bridge is configured</span>
                    </span>
                    <input
                      className="stv3-setting-input"
                      placeholder="Unavailable"
                      disabled
                    />
                  </label>
                  <label className="stv3-setting-line">
                    <span className="stv3-setting-copy">
                      <strong>Reasoning</strong>
                      <span>Unavailable</span>
                    </span>
                    <select className="stv3-select" disabled>
                      <option>Unavailable</option>
                    </select>
                  </label>
                  <div className="stv3-setting-line">
                    <span className="stv3-setting-copy">
                      <strong>Configuration</strong>
                      <span>Unavailable in this backend phase</span>
                    </span>
                    <button
                      className="stv3-button stv3-button-quiet"
                      type="button"
                      disabled
                    >
                      Validate
                    </button>
                  </div>
                </div>
                <div className="stv3-flow-callout is-warning">
                  Cloud processing is unavailable. No API setting is persisted
                  and no request is sent.
                </div>
              </section>
              <p className="stv3-kicker">
                External LLM batch stays separate because it is a manual file
                export/import workflow.
              </p>
            </section>

            <GlossarySettings
              active={page === "glossary"}
              targetLang={targetLang}
              glossary={glossary}
              building={glossaryBuilding}
              error={glossaryError}
              onBuild={() => void handleBuildGlossary()}
            />

            <ShortcutsSettings
              active={page === "shortcuts"}
              shortcuts={shortcuts}
              onChange={setShortcuts}
            />

            <section
              id="settings-panel-about"
              className={
                "stv3-settings-page" + (page === "about" ? " is-active" : "")
              }
              role="tabpanel"
              aria-label="About"
              hidden={page !== "about"}
            >
              <h3>About</h3>
              <p className="stv3-settings-intro">
                Stardew i18n Translator · version {packageInfo.version}.
              </p>
              <div className="stv3-settings-group">
                <div className="stv3-setting-line">
                  <span className="stv3-setting-copy">
                    <strong>Version</strong>
                    <span>Portable Windows application</span>
                  </span>
                  <span>{packageInfo.version}</span>
                </div>
                <div className="stv3-setting-line">
                  <span className="stv3-setting-copy">
                    <strong>Author & license</strong>
                    <span>Nana · GPL-3.0-or-later</span>
                  </span>
                  <button
                    className="stv3-button stv3-button-quiet"
                    type="button"
                    onClick={() =>
                      void openUrl(
                        "https://github.com/Nana1873/stardew-i18n-translator",
                      )
                    }
                  >
                    GitHub
                  </button>
                </div>
                <div className="stv3-setting-line">
                  <span className="stv3-setting-copy">
                    <strong>Technology</strong>
                    <span>Tauri 2 · Rust · React · TypeScript</span>
                  </span>
                  <button
                    className="stv3-button stv3-button-quiet"
                    type="button"
                    onClick={() =>
                      void openUrl(
                        "https://github.com/Nana1873/stardew-i18n-translator/blob/main/LICENSE",
                      )
                    }
                  >
                    License
                  </button>
                </div>
                <div className="stv3-setting-line">
                  <span className="stv3-setting-copy">
                    <strong>Portable data</strong>
                    <span>
                      Stored next to the application in the Data folder
                    </span>
                  </span>
                  <span className="stv3-state is-ready">Local</span>
                </div>
                <div className="stv3-setting-line">
                  <span className="stv3-setting-copy">
                    <strong>Local diagnostic logs</strong>
                    <span>Rotating and never sent automatically</span>
                  </span>
                  <label className="stv3-switch">
                    <input
                      type="checkbox"
                      checked={diagnosticLogging}
                      aria-label="Enable local diagnostic logging"
                      onChange={(event) =>
                        setDiagnosticLogging(event.target.checked)
                      }
                    />
                    <span />
                  </label>
                </div>
                <div className="stv3-setting-line">
                  <span className="stv3-setting-copy">
                    <strong>Logs for bug reports</strong>
                    <span>Opens the portable logs folder</span>
                  </span>
                  <button
                    className="stv3-button stv3-button-quiet"
                    type="button"
                    onClick={() => void openLogsDir()}
                  >
                    Open logs
                  </button>
                </div>
              </div>
              <p className="stv3-kicker">
                Stardew Valley and ConcernedApe are trademarks or property of
                their respective owners. This project is independent and not
                officially affiliated.
              </p>
            </section>
          </div>
        </div>

        <div className="stv3-settings-head">
          <span className="stv3-kicker">
            {saveError
              ? "Settings could not be saved"
              : "Settings are stored in the portable Data folder"}
          </span>
          {saveError && (
            <span className="stv3-shortcut-error" role="alert">
              {saveError}
            </span>
          )}
          <div className="stv3-settings-actions">
            <button
              className="stv3-button stv3-button-quiet"
              type="button"
              onClick={onClose}
              disabled={saving || folderPicking !== null}
            >
              Cancel
            </button>
            <button
              className="stv3-button stv3-button-primary"
              type="button"
              onClick={() => void save()}
              disabled={saving || folderPicking !== null}
            >
              {saving ? "Saving…" : "Save changes"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function GlossarySettings({
  active,
  targetLang,
  glossary,
  building,
  error,
  onBuild,
}: {
  active: boolean;
  targetLang: string;
  glossary: GlossaryStatus | null;
  building: boolean;
  error: string | null;
  onBuild: () => void;
}) {
  const supported = Boolean(targetLang && gameSupportsLanguage(targetLang));
  const cached = glossary?.cached ?? null;
  const community = cached?.source === "communityPack";
  const available = Boolean(glossary?.sourceAvailable);
  const canBuild = Boolean(
    targetLang &&
    glossary &&
    available &&
    (supported || glossary.packAvailable),
  );
  const state = !glossary
    ? "Checking glossary sources"
    : glossary.outdatedCache
      ? "Glossary cache needs rebuild"
      : cached
        ? "Glossary is up to date"
        : canBuild
          ? "Glossary can be built"
          : "Glossary unavailable";
  const source = !glossary
    ? "Checking local Stardew content"
    : community
      ? "Installed community language pack" +
        (cached?.packName ? " · " + cached.packName : "")
      : available
        ? "Official local Content/Strings sources · processed read-only"
        : "Unavailable";
  const language =
    TARGET_LANGUAGES.find((candidate) => candidate.code === targetLang)
      ?.label ??
    (targetLang || "No target language");

  return (
    <section
      id="settings-panel-glossary"
      className={"stv3-settings-page" + (active ? " is-active" : "")}
      role="tabpanel"
      aria-label="Glossary"
      hidden={!active}
    >
      <h3>Glossary</h3>
      <p className="stv3-settings-intro">
        Optional official term hints from local Stardew strings. The glossary
        does not translate ordinary prose.
      </p>
      <div className="stv3-glossary-summary">
        <div className="stv3-glossary-main">
          <strong>{state}</strong>
          <span>
            {language} · source: {source}
          </span>
        </div>
        <div className="stv3-glossary-number">
          <strong>{cached ? cached.termCount.toLocaleString() : "—"}</strong>
          <span>{cached ? "terms" : "terms unavailable"}</span>
        </div>
      </div>

      <div className="stv3-settings-group">
        <div className="stv3-setting-line">
          <span className="stv3-setting-copy">
            <strong>Source</strong>
            <span>{source}</span>
          </span>
          <span
            className={"stv3-state " + (available ? "is-ready" : "is-change")}
          >
            {available ? "Available" : "Unavailable"}
          </span>
        </div>

        {!supported && glossary?.packAvailable && available && (
          <div className="stv3-setting-line">
            <span className="stv3-setting-copy">
              <strong>Community language pack</strong>
              <span>
                Stardew Valley doesn’t include this language, but{" "}
                {glossary.packName || "an installed pack"} provides local
                glossary sources.
              </span>
            </span>
            <span className="stv3-state is-ready">Detected</span>
          </div>
        )}

        {!supported && glossary?.packAvailable && !available && (
          <div className="stv3-setting-line">
            <span className="stv3-setting-copy">
              <strong>Notice</strong>
              <span>
                A community language pack was detected
                {glossary.packName ? " (" + glossary.packName + ")" : ""}, but
                the app could not read a local English Strings source.
              </span>
            </span>
            <button
              className="stv3-button stv3-button-quiet"
              type="button"
              onClick={() =>
                void openUrl("https://github.com/Pathoschild/StardewXnbHack")
              }
            >
              Get StardewXnbHack ↗
            </button>
          </div>
        )}

        {!supported && glossary && !glossary.packAvailable && (
          <div className="stv3-setting-line">
            <span className="stv3-setting-copy">
              <strong>Notice</strong>
              <span>
                Stardew Valley doesn’t include this language, so no official
                glossary is available. Translation and export still work fully.
              </span>
            </span>
            <span className="stv3-state is-change">Unavailable</span>
          </div>
        )}

        {supported && glossary && !available && (
          <div className="stv3-setting-line">
            <span className="stv3-setting-copy">
              <strong>Notice</strong>
              <span>
                No glossary-ready game Strings were found. Direct game XNB files
                are used first; StardewXnbHack is only a fallback.
              </span>
            </span>
            <button
              className="stv3-button stv3-button-quiet"
              type="button"
              onClick={() =>
                void openUrl("https://github.com/Pathoschild/StardewXnbHack")
              }
            >
              Get StardewXnbHack ↗
            </button>
          </div>
        )}

        {canBuild && (
          <div className="stv3-setting-line">
            <span className="stv3-setting-copy">
              <strong>{language} cache</strong>
              <span>
                {cached
                  ? cached.termCount.toLocaleString() +
                    " terms · optional and not included in a release"
                  : "Not built yet · optional and stored locally"}
              </span>
            </span>
            <button
              className="stv3-button stv3-button-quiet"
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
          <div className="stv3-setting-line">
            <span className="stv3-setting-copy">
              <strong>Notice</strong>
              <span>
                An older glossary from a previous version was found — rebuild
                recommended.
              </span>
            </span>
            <span className="stv3-state is-change">Outdated</span>
          </div>
        )}
      </div>
      {error && (
        <p className="stv3-shortcut-error" role="alert">
          {error}
        </p>
      )}
      <p className="stv3-kicker">
        If the glossary is unavailable, scanning, translation, review, and
        export still work normally.
      </p>
    </section>
  );
}

function ShortcutsSettings({
  active,
  shortcuts,
  onChange,
}: {
  active: boolean;
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
      setError("Already assigned to “" + conflict.label + "”.");
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
      className={"stv3-settings-page" + (active ? " is-active" : "")}
      role="tabpanel"
      aria-label="Shortcuts"
      hidden={!active}
    >
      <div className="stv3-settings-title-row">
        <div>
          <h3>Shortcuts</h3>
          <p className="stv3-settings-intro">
            Click a shortcut, then press the new key combination.
          </p>
        </div>
        <button
          className="stv3-button stv3-button-quiet"
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
        <p className="stv3-shortcut-error" role="alert">
          {error}
        </p>
      )}
      <div className="stv3-shortcut-list">
        {SHORTCUT_COMMANDS.map((command, index) => {
          const startsGroup =
            index === 0 || SHORTCUT_COMMANDS[index - 1].group !== command.group;
          const changed =
            shortcuts[command.id] !== DEFAULT_SHORTCUTS[command.id];
          return (
            <div key={command.id}>
              {startsGroup && <h4>{command.group}</h4>}
              <div className="stv3-shortcut-row">
                <span>{command.label}</span>
                <button
                  type="button"
                  className={capturing === command.id ? "is-capturing" : ""}
                  aria-label={"Change " + command.label}
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
                  aria-label={"Reset " + command.label}
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
      <p className="stv3-kicker">
        Window and developer shortcuts such as Alt+F4 and Ctrl+Shift+I are
        reserved. Plain letters require a modifier.
      </p>
    </section>
  );
}
