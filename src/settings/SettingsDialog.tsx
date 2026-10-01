import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  BookOpen,
  Folder,
  HardDrive,
  Info,
  Keyboard,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Cloud,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  type AiEngine,
  type AppSettings,
  type CloudAiModel,
  type CloudAiStatus,
  type GlossaryStatus,
  buildGlossary,
  cloudAiModels,
  cloudAiStatus,
  CLOUD_ENGINE_LABEL,
  CLOUD_ENGINE_ID,
  chatgptSignIn,
  chatgptSignOut,
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

type EnginePanel = AiEngine;

const DEFAULT_AI_SETTINGS = {
  defaultEngine: "local" as AiEngine,
  cloudModel: null,
  cloudReasoning: "medium" as const,
  cloudQualityReview: true,
};

const CLOUD_REASONING_OPTIONS = ["low", "medium", "high"] as const;
const englishNumberFormat = new Intl.NumberFormat("en-US");

export function SettingsDialog({
  settings,
  onSave,
  onClose,
  onReRunSetup,
  initialPage = "folders",
}: SettingsDialogProps) {
  const savedAi = settings.ai ?? DEFAULT_AI_SETTINGS;
  const savedDefaultEngine =
    savedAi.defaultEngine === "local" ||
    savedAi.defaultEngine === CLOUD_ENGINE_ID
      ? savedAi.defaultEngine
      : null;
  const [page, setPage] = useState<SettingsPage>(initialPage);
  const [preferredEngine, setPreferredEngine] = useState<AiEngine | null>(
    savedDefaultEngine,
  );
  const [enginePanel, setEnginePanel] = useState<EnginePanel>(
    savedDefaultEngine ?? "local",
  );
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
  const [cloudReasoning, setCloudReasoning] = useState<
    "low" | "medium" | "high"
  >(savedAi.cloudReasoning);
  const [cloudQualityReview, setCloudQualityReview] = useState(
    savedAi.cloudQualityReview ?? true,
  );
  const [cloudModel, setCloudModel] = useState(savedAi.cloudModel ?? "");
  const [customCloudModel, setCustomCloudModel] = useState(false);
  const [cloudModels, setCloudModels] = useState<CloudAiModel[] | null>(null);
  const [cloudModelsLoading, setCloudModelsLoading] = useState(false);
  const [cloudModelsError, setCloudModelsError] = useState<string | null>(null);
  const [cloudStatus, setCloudStatus] = useState<CloudAiStatus | null>(null);
  const [cloudChecking, setCloudChecking] = useState(false);
  const [chatgptSigningIn, setChatgptSigningIn] = useState(false);
  const [chatgptAuthError, setChatgptAuthError] = useState<string | null>(null);
  const llmDefaultBaseUrl =
    llmProvider === "custom" ? null : (LLM_PRESETS[llmProvider] ?? null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const llmRequest = useRef(0);
  const dialogRef = useRef<HTMLElement>(null);
  const localAvailable = Boolean(llmBaseUrl.trim() && llmModel.trim());
  const cloudAvailable = Boolean(cloudStatus?.authenticated);
  const cloudAccountError = chatgptAuthError || cloudStatus?.error;
  const defaultEngine: AiEngine | null =
    preferredEngine === CLOUD_ENGINE_ID && cloudStatus === null
      ? null
      : preferredEngine === "local" && localAvailable
        ? "local"
        : preferredEngine === CLOUD_ENGINE_ID && cloudAvailable
          ? CLOUD_ENGINE_ID
          : localAvailable
            ? "local"
            : cloudAvailable
              ? CLOUD_ENGINE_ID
              : null;
  const selectedCloudModel = cloudModels?.find(
    (candidate) => candidate.model === cloudModel,
  );
  const showCloudModelInput =
    customCloudModel ||
    Boolean(cloudModel && cloudModels !== null && !selectedCloudModel);
  const cloudReasoningOptions = selectedCloudModel?.supportedReasoningEfforts
    .length
    ? CLOUD_REASONING_OPTIONS.filter((reasoning) =>
        selectedCloudModel.supportedReasoningEfforts.includes(reasoning),
      )
    : CLOUD_REASONING_OPTIONS;

  useEffect(() => {
    if (defaultEngine) setEnginePanel(defaultEngine);
  }, [defaultEngine]);

  useEffect(() => {
    if (
      !selectedCloudModel ||
      selectedCloudModel.supportedReasoningEfforts.length === 0 ||
      selectedCloudModel.supportedReasoningEfforts.includes(cloudReasoning)
    ) {
      return;
    }
    setCloudReasoning(
      selectedCloudModel.defaultReasoningEffort &&
        selectedCloudModel.supportedReasoningEfforts.includes(
          selectedCloudModel.defaultReasoningEffort,
        )
        ? selectedCloudModel.defaultReasoningEffort
        : selectedCloudModel.supportedReasoningEfforts[0],
    );
  }, [cloudReasoning, selectedCloudModel]);

  useEffect(
    () => () => {
      llmRequest.current += 1;
    },
    [],
  );

  useEffect(() => {
    let active = true;
    setCloudChecking(true);
    cloudAiStatus()
      .then(async (status) => {
        if (!active) return;
        setCloudStatus(status);
        await loadCloudDetails(status, () => active);
      })
      .catch((cause) => {
        if (!active) return;
        setCloudStatus({
          authenticated: false,
          error: String(cause),
        });
      })
      .finally(() => {
        if (active) setCloudChecking(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const { onDialogKeyDown } = useDialogAccessibility({
    dialogRef,
    onEscape: onClose,
    escapeDisabled: saving || folderPicking !== null,
    initialFocusSelector: '[role="tab"][aria-selected="true"]',
  });

  useEffect(() => {
    if (!chatgptSigningIn) return;
    let active = true;
    let checking = false;
    const deadline = Date.now() + 10 * 60_000;
    const timer = window.setInterval(() => {
      if (Date.now() > deadline) {
        setChatgptSigningIn(false);
        setChatgptAuthError("Sign-in expired. Try again.");
        return;
      }
      if (checking) return;
      checking = true;
      void cloudAiStatus()
        .then(async (status) => {
          if (!active) return;
          setCloudStatus(status);
          if (!status.signInPending) {
            if (status.error) setChatgptAuthError(status.error);
            if (status.authenticated)
              await loadCloudDetails(status, () => active);
            if (active) setChatgptSigningIn(false);
          }
        })
        .catch(() => {})
        .finally(() => {
          checking = false;
        });
    }, 2000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [chatgptSigningIn]);

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

  function resetLlmUrl() {
    if (!llmDefaultBaseUrl) return;
    llmRequest.current += 1;
    setLlmBaseUrl(llmDefaultBaseUrl);
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

  function chooseEngine(panel: EnginePanel) {
    setEnginePanel(panel);
    setPreferredEngine(panel);
  }

  async function loadCloudDetails(
    status: CloudAiStatus,
    isActive: () => boolean = () => true,
  ) {
    if (!status.authenticated) {
      return;
    }

    setCloudModelsLoading(true);
    setCloudModelsError(null);
    const modelsRequest = cloudAiModels()
      .then((models) => {
        if (!isActive()) return;
        setCloudModels(models);
        setCloudModel((current) =>
          current
            ? current
            : (models.find((model) => model.isDefault)?.model ??
              models[0]?.model ??
              current),
        );
      })
      .catch((cause) => {
        if (isActive()) setCloudModelsError(String(cause));
      })
      .finally(() => {
        if (isActive()) setCloudModelsLoading(false);
      });

    await modelsRequest;
  }

  async function checkCloudStatus(clearAuthError = true) {
    if (clearAuthError) setChatgptAuthError(null);
    setCloudChecking(true);
    try {
      const status = await cloudAiStatus();
      setCloudStatus(status);
      await loadCloudDetails(status);
    } catch (cause) {
      setCloudStatus({
        authenticated: false,
        error: String(cause),
      });
    } finally {
      setCloudChecking(false);
    }
  }

  async function signInWithChatgpt() {
    setChatgptAuthError(null);
    try {
      await chatgptSignIn();
      setChatgptSigningIn(true);
    } catch (cause) {
      setChatgptAuthError(String(cause));
    }
  }

  async function signOutFromChatgpt() {
    setChatgptAuthError(null);
    setCloudChecking(true);
    setChatgptSigningIn(false);
    try {
      await chatgptSignOut();
    } catch (cause) {
      setChatgptAuthError(String(cause));
    } finally {
      setCloudModels(null);
      setCloudModel("");
      await checkCloudStatus(false);
    }
  }

  function chooseCloudModel(model: string) {
    if (model === "custom-model-id") {
      setCustomCloudModel(true);
      return;
    }
    setCustomCloudModel(false);
    setCloudModel(model);
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
        ai: {
          defaultEngine: defaultEngine ?? "local",
          cloudModel: cloudModel.trim() || null,
          cloudReasoning,
          cloudQualityReview,
        },
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
    <div className="translator-settings-overlay">
      <section
        ref={dialogRef}
        className="translator-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-busy={saving}
        aria-labelledby="translator-settings-title"
        aria-describedby="translator-settings-description"
        onKeyDown={onDialogKeyDown}
      >
        <div className="translator-settings-head">
          <div>
            <h2 className="translator-heading" id="translator-settings-title">
              Settings
            </h2>
            <div
              className="translator-kicker"
              id="translator-settings-description"
            >
              Translation and application preferences
            </div>
          </div>
          <button
            className="translator-icon-button"
            type="button"
            aria-label="Close settings"
            onClick={onClose}
            disabled={saving || folderPicking !== null}
          >
            <X aria-hidden="true" />
          </button>
        </div>

        <fieldset className="translator-settings-layout" disabled={saving}>
          <nav
            className="translator-settings-nav"
            aria-label="Settings sections"
            role="tablist"
            aria-orientation="vertical"
          >
            {SETTINGS_PAGES.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                className="translator-settings-tab"
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

          <div className="translator-settings-content">
            <section
              id="settings-panel-folders"
              className={
                "translator-settings-page" +
                (page === "folders" ? " is-active" : "")
              }
              role="tabpanel"
              aria-label="Folders & language"
              hidden={page !== "folders"}
            >
              <h3>Folders & language</h3>
              <p className="translator-settings-intro">
                Scanning reads these folders. Export writes translation files to
                your Mods folder; game files stay read-only.
              </p>
              <div className="translator-settings-group">
                <div className="translator-setting-line">
                  <span className="translator-setting-copy">
                    <strong>Stardew Valley</strong>
                    <span>{stardewPath || "Unavailable"}</span>
                  </span>
                  <button
                    className="translator-button translator-button-quiet"
                    type="button"
                    aria-label="Change Stardew Valley folder"
                    aria-busy={folderPicking === "stardew"}
                    onClick={() => void changeFolder("stardew")}
                    disabled={saving || folderPicking !== null}
                  >
                    Change
                  </button>
                </div>
                <div className="translator-setting-line">
                  <span className="translator-setting-copy">
                    <strong>Mods</strong>
                    <span>{modsPath || "Unavailable"}</span>
                  </span>
                  <button
                    className="translator-button translator-button-quiet"
                    type="button"
                    aria-label="Change Mods folder"
                    aria-busy={folderPicking === "mods"}
                    onClick={() => void changeFolder("mods")}
                    disabled={saving || folderPicking !== null}
                  >
                    Change
                  </button>
                </div>
                <div className="translator-setting-line">
                  <span className="translator-setting-copy">
                    <strong>Source language</strong>
                    <span>
                      From <code>i18n/default.json</code>
                    </span>
                  </span>
                  <span>{SOURCE_LANGUAGE_LABEL}</span>
                </div>
                <label className="translator-setting-line">
                  <span className="translator-setting-copy">
                    <strong>Target language</strong>
                    <span>Standard or curated custom language code</span>
                  </span>
                  <select
                    className="translator-select"
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
                <div className="translator-setting-line">
                  <span className="translator-setting-copy">
                    <strong>Run setup again</strong>
                    <span>
                      Game folder, Mods folder, language, and optional glossary
                    </span>
                  </span>
                  <button
                    className="translator-button translator-button-quiet"
                    type="button"
                    onClick={onReRunSetup}
                    disabled={saving || folderPicking !== null}
                  >
                    Setup …
                  </button>
                </div>
                {folderError && (
                  <p className="translator-shortcut-error" role="alert">
                    {folderError}
                  </p>
                )}
              </div>
            </section>

            <section
              id="settings-panel-ai"
              className={
                "translator-settings-page" + (page === "ai" ? " is-active" : "")
              }
              role="tabpanel"
              aria-label="Translation engines"
              hidden={page !== "ai"}
            >
              <h3>Translation engines</h3>
              <p className="translator-settings-intro">
                Choose the default engine for the quick editor and batch
                actions. Every AI output enters Review. A run may send up to two
                preceding and two following English strings as read-only
                context; only selected strings can be saved.
              </p>
              <div
                className="translator-engine-list translator-engine-list-two"
                role="group"
                aria-label="Default translation engine"
              >
                <button
                  className="translator-engine-card"
                  type="button"
                  aria-pressed={enginePanel === "local"}
                  onClick={() => chooseEngine("local")}
                >
                  <HardDrive aria-hidden="true" />
                  <span>
                    <strong>Local AI</strong>
                    <span>
                      {llmResult?.kind === "connected"
                        ? "Ready · localhost"
                        : localAvailable
                          ? "Configured · localhost"
                          : "Not configured · localhost"}
                    </span>
                  </span>
                </button>
                <button
                  className="translator-engine-card"
                  type="button"
                  aria-pressed={enginePanel === CLOUD_ENGINE_ID}
                  onClick={() => chooseEngine(CLOUD_ENGINE_ID)}
                >
                  <Cloud aria-hidden="true" />
                  <span>
                    <strong>{CLOUD_ENGINE_LABEL}</strong>
                    <span>
                      {cloudStatus
                        ? cloudStatus.authenticated
                          ? "Ready"
                          : "Sign in with ChatGPT"
                        : "Checking…"}
                    </span>
                  </span>
                </button>
              </div>

              <section
                className={
                  "translator-engine-panel" +
                  (enginePanel === "local" ? " is-active" : "")
                }
                aria-label="Local AI"
                hidden={enginePanel !== "local"}
              >
                <div className="translator-settings-group">
                  <label className="translator-setting-line">
                    <span className="translator-setting-copy">
                      <strong>Local service</strong>
                      <span>Localhost only</span>
                    </span>
                    <select
                      className="translator-select"
                      value={llmProvider}
                      onChange={(event) => pickLlmProvider(event.target.value)}
                      aria-label="AI provider"
                    >
                      <option value="lmstudio">LM Studio</option>
                      <option value="ollama">Ollama</option>
                      <option value="custom">Custom (OpenAI-compatible)</option>
                    </select>
                  </label>
                  <div className="translator-setting-line">
                    <span className="translator-setting-copy">
                      <strong>Base URL</strong>
                      <span>Local endpoint</span>
                    </span>
                    <span className="translator-setting-input-actions">
                      <input
                        className="translator-setting-input"
                        value={llmBaseUrl}
                        placeholder="http://localhost:1234/v1"
                        aria-label="AI base URL"
                        onChange={(event) => changeLlmUrl(event.target.value)}
                      />
                      <button
                        className="translator-icon-button"
                        type="button"
                        aria-label="Reset AI base URL to default"
                        title={
                          llmDefaultBaseUrl
                            ? `Reset to ${llmDefaultBaseUrl}`
                            : "Custom endpoints have no default URL"
                        }
                        onClick={resetLlmUrl}
                        disabled={
                          !llmDefaultBaseUrl ||
                          llmBaseUrl.trim() === llmDefaultBaseUrl
                        }
                      >
                        <RotateCcw aria-hidden="true" />
                      </button>
                    </span>
                  </div>
                  <label className="translator-setting-line">
                    <span className="translator-setting-copy">
                      <strong>Model</strong>
                      <span>Available after a successful connection test</span>
                    </span>
                    <select
                      className="translator-select"
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
                  <div className="translator-setting-line">
                    <span className="translator-setting-copy">
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
                      className="translator-button translator-button-quiet"
                      type="button"
                      onClick={() => setLlmTemperature("")}
                      disabled={!llmTemperature}
                    >
                      Use default
                    </button>
                  </div>
                  <div
                    className="translator-setting-line"
                    role={llmResult?.kind === "failed" ? "alert" : "status"}
                  >
                    <span className="translator-setting-copy">
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
                      className="translator-button translator-button-quiet"
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
                <p className="translator-kicker">
                  If the service is unavailable, manual translation, import, and
                  export remain fully available.
                </p>
              </section>

              <section
                className={
                  "translator-engine-panel" +
                  (enginePanel === CLOUD_ENGINE_ID ? " is-active" : "")
                }
                aria-label={CLOUD_ENGINE_LABEL}
                hidden={enginePanel !== CLOUD_ENGINE_ID}
              >
                <div className="translator-settings-group">
                  <div className="translator-setting-line">
                    <span className="translator-setting-copy">
                      <strong>ChatGPT account</strong>
                      <span
                        role={cloudAccountError ? "alert" : "status"}
                        aria-live={cloudAccountError ? "assertive" : "polite"}
                        aria-atomic="true"
                      >
                        {cloudAccountError ||
                          (chatgptSigningIn
                            ? "Complete sign-in in your browser. This screen updates automatically."
                            : cloudChecking
                              ? "Checking ChatGPT sign-in…"
                              : cloudAvailable
                                ? cloudStatus?.authentication ||
                                  "Signed in with ChatGPT"
                                : "Sign in to use your ChatGPT plan.")}
                      </span>
                    </span>
                    <div className="translator-setting-actions">
                      {cloudStatus?.error && (
                        <button
                          className="translator-button translator-button-quiet"
                          type="button"
                          onClick={() => void checkCloudStatus()}
                          disabled={cloudChecking || chatgptSigningIn}
                        >
                          Retry connection
                        </button>
                      )}
                      {cloudAvailable && (
                        <button
                          type="button"
                          className="translator-button translator-button-quiet"
                          onClick={() =>
                            void openUrl("https://chatgpt.com/settings/usage")
                          }
                        >
                          Manage usage
                        </button>
                      )}
                      <button
                        type="button"
                        className="translator-button translator-button-quiet"
                        disabled={cloudChecking || chatgptSigningIn}
                        onClick={() =>
                          void (cloudAvailable
                            ? signOutFromChatgpt()
                            : signInWithChatgpt())
                        }
                      >
                        {cloudAvailable
                          ? "Sign out"
                          : chatgptSigningIn
                            ? "Waiting for browser…"
                            : "Sign in with ChatGPT"}
                      </button>
                    </div>
                  </div>
                  <div className="translator-setting-line">
                    <span className="translator-setting-copy">
                      <strong>Model</strong>
                      <span>
                        {cloudModelsLoading
                          ? "Loading models…"
                          : cloudModelsError
                            ? cloudModel
                              ? "Model list unavailable · keeping the saved selection"
                              : "Model list unavailable · retry loading"
                            : cloudAvailable && cloudModels?.length === 0
                              ? "No models listed · enter a model ID"
                              : !cloudAvailable
                                ? "Sign in to load your models"
                                : showCloudModelInput
                                  ? "OpenAI checks model access when translating"
                                  : "Choose a listed model or enter its exact ID"}
                      </span>
                    </span>
                    <div className="translator-setting-actions">
                      {cloudAvailable &&
                        (cloudModelsError || cloudModels?.length === 0) && (
                          <button
                            type="button"
                            className="translator-button translator-button-quiet"
                            disabled={cloudChecking || cloudModelsLoading}
                            onClick={() => void checkCloudStatus()}
                          >
                            Retry models
                          </button>
                        )}
                      <select
                        className="translator-select"
                        value={
                          showCloudModelInput ? "custom-model-id" : cloudModel
                        }
                        onChange={(event) =>
                          chooseCloudModel(event.target.value)
                        }
                        aria-label={"ChatGPT model"}
                        disabled={!cloudAvailable}
                      >
                        {!showCloudModelInput && !selectedCloudModel && (
                          <option value={cloudModel}>
                            {cloudModel
                              ? `${cloudModel} · saved`
                              : "Choose a ChatGPT model"}
                          </option>
                        )}
                        {cloudModels?.map((model) => (
                          <option key={model.model} value={model.model}>
                            {model.displayName}
                          </option>
                        ))}
                        <option value="custom-model-id">Enter model ID…</option>
                      </select>
                      {showCloudModelInput && (
                        <input
                          className="translator-select"
                          aria-label="ChatGPT model ID"
                          value={cloudModel}
                          placeholder="e.g. gpt-6.1-sol"
                          maxLength={160}
                          spellCheck={false}
                          disabled={!cloudAvailable}
                          onChange={(event) =>
                            setCloudModel(event.target.value)
                          }
                        />
                      )}
                    </div>
                  </div>
                  <label className="translator-setting-line">
                    <span className="translator-setting-copy">
                      <strong>Reasoning</strong>
                    </span>
                    <select
                      className="translator-select"
                      value={cloudReasoning}
                      onChange={(event) =>
                        setCloudReasoning(
                          event.target.value as "low" | "medium" | "high",
                        )
                      }
                      aria-label={"ChatGPT reasoning"}
                    >
                      {cloudReasoningOptions.map((reasoning) => (
                        <option key={reasoning} value={reasoning}>
                          {reasoning[0].toUpperCase() + reasoning.slice(1)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="translator-setting-line">
                    <span className="translator-setting-copy">
                      <strong>AI quality checks</strong>
                      <span>
                        Checks wording, terminology and protected tokens. Uses
                        additional ChatGPT requests.
                      </span>
                    </span>
                    <label className="translator-switch">
                      <input
                        type="checkbox"
                        aria-label="AI quality checks"
                        checked={cloudQualityReview}
                        onChange={(event) =>
                          setCloudQualityReview(event.target.checked)
                        }
                      />
                      <span aria-hidden="true" />
                    </label>
                  </div>
                </div>
                {!cloudQualityReview && (
                  <div
                    className="translator-flow-callout translator-cloud-quality-warning is-warning"
                    role="note"
                    aria-label="First draft quality warning"
                  >
                    <p>
                      <strong>First draft only.</strong> This is faster and uses
                      fewer tokens, but translation quality can be worse. Drafts
                      may contain wording, terminology, grammar, register,
                      speaker voice, dialogue continuity, or protected-token
                      errors. Validation still runs and every result still
                      enters Review.
                    </p>
                  </div>
                )}
              </section>
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
                "translator-settings-page" +
                (page === "about" ? " is-active" : "")
              }
              role="tabpanel"
              aria-label="About"
              hidden={page !== "about"}
            >
              <h3>About</h3>
              <p className="translator-settings-intro">
                Stardew i18n Translator
              </p>
              <div className="translator-settings-group">
                <div className="translator-setting-line">
                  <span className="translator-setting-copy">
                    <strong>Version</strong>
                    <span>Portable Windows application</span>
                  </span>
                  <span>{packageInfo.version}</span>
                </div>
                <div className="translator-setting-line">
                  <span className="translator-setting-copy">
                    <strong>Author & license</strong>
                    <span>Nana · GPL-3.0-or-later</span>
                  </span>
                  <div className="translator-settings-actions">
                    <button
                      className="translator-button translator-button-quiet"
                      type="button"
                      onClick={() =>
                        void openUrl(
                          "https://github.com/Nana1873/stardew-i18n-translator",
                        )
                      }
                    >
                      GitHub
                    </button>
                    <button
                      className="translator-button translator-button-quiet"
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
                </div>
                <div className="translator-setting-line">
                  <span className="translator-setting-copy">
                    <strong>Technology</strong>
                    <span>Tauri 2 · Rust · React · TypeScript</span>
                  </span>
                </div>
                <div className="translator-setting-line">
                  <span className="translator-setting-copy">
                    <strong>Portable data</strong>
                    <span>
                      Stored next to the application in the Data folder
                    </span>
                  </span>
                  <span className="translator-state is-ready">Local</span>
                </div>
                <div className="translator-setting-line">
                  <span className="translator-setting-copy">
                    <strong>Local diagnostic logs</strong>
                    <span>
                      Rotating · AI run metadata only, never translation text ·
                      never sent automatically
                    </span>
                  </span>
                  <label className="translator-switch">
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
                <div className="translator-setting-line">
                  <span className="translator-setting-copy">
                    <strong>Logs for bug reports</strong>
                    <span>Opens the portable logs folder</span>
                  </span>
                  <button
                    className="translator-button translator-button-quiet"
                    type="button"
                    onClick={() => void openLogsDir()}
                  >
                    Open logs
                  </button>
                </div>
              </div>
              <p className="translator-kicker">
                Stardew Valley and ConcernedApe are trademarks or property of
                their respective owners. This project is independent and not
                officially affiliated.
              </p>
            </section>
          </div>
        </fieldset>

        <div className="translator-settings-head">
          <span>
            {saveError && (
              <span className="translator-shortcut-error" role="alert">
                {saveError}
              </span>
            )}
          </span>
          <div className="translator-settings-actions">
            <button
              className="translator-button translator-button-quiet"
              type="button"
              onClick={onClose}
              disabled={saving || folderPicking !== null}
            >
              Cancel
            </button>
            <button
              className="translator-button translator-button-primary"
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
  const summaryTone =
    cached && !glossary?.outdatedCache
      ? " is-ready"
      : glossary && (glossary.outdatedCache || canBuild)
        ? " is-actionable"
        : "";
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
      className={"translator-settings-page" + (active ? " is-active" : "")}
      role="tabpanel"
      aria-label="Glossary"
      hidden={!active}
    >
      <h3>Glossary</h3>
      <p className="translator-settings-intro">
        Optional term hints from local Stardew strings. The glossary does not
        translate ordinary prose.
      </p>
      <div className={"translator-glossary-summary" + summaryTone}>
        <div className="translator-glossary-main">
          <strong>{state}</strong>
          <span>{language}</span>
        </div>
        <div className="translator-glossary-number">
          <strong>
            {cached ? englishNumberFormat.format(cached.termCount) : "—"}
          </strong>
          <span>{cached ? "terms" : "terms unavailable"}</span>
        </div>
      </div>

      <div className="translator-settings-group">
        <div className="translator-setting-line">
          <span className="translator-setting-copy">
            <strong>Source</strong>
            <span>{source}</span>
          </span>
          <span
            className={
              "translator-state " + (available ? "is-ready" : "is-change")
            }
          >
            {available ? "Available" : "Unavailable"}
          </span>
        </div>

        {!supported && glossary?.packAvailable && available && (
          <div className="translator-setting-line">
            <span className="translator-setting-copy">
              <strong>Community language pack</strong>
              <span>
                Stardew Valley doesn’t include this language, but{" "}
                {glossary.packName || "an installed pack"} provides local
                glossary sources.
              </span>
            </span>
            <span className="translator-state is-ready">Detected</span>
          </div>
        )}

        {!supported && glossary?.packAvailable && !available && (
          <div className="translator-setting-line">
            <span className="translator-setting-copy">
              <strong>Notice</strong>
              <span>
                A community language pack was detected
                {glossary.packName ? " (" + glossary.packName + ")" : ""}, but
                the app could not read a local English Strings source.
              </span>
            </span>
            <button
              className="translator-button translator-button-quiet"
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
          <div className="translator-setting-line">
            <span className="translator-setting-copy">
              <strong>Notice</strong>
              <span>
                Stardew Valley doesn’t include this language, so no official
                glossary is available. Translation and export still work fully.
              </span>
            </span>
            <span className="translator-state is-change">Unavailable</span>
          </div>
        )}

        {supported && glossary && !available && (
          <div className="translator-setting-line">
            <span className="translator-setting-copy">
              <strong>Notice</strong>
              <span>
                No glossary-ready game Strings were found. Direct game XNB files
                are used first; StardewXnbHack is only a fallback.
              </span>
            </span>
            <button
              className="translator-button translator-button-quiet"
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
          <div className="translator-setting-line">
            <span className="translator-setting-copy">
              <strong>{language} cache</strong>
              <span>
                {cached
                  ? "Stored locally · not included in a release"
                  : "Not built yet · optional and stored locally"}
              </span>
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
                An older glossary from a previous version was found — rebuild
                recommended.
              </span>
            </span>
            <span className="translator-state is-change">Outdated</span>
          </div>
        )}
      </div>
      {error && (
        <p className="translator-shortcut-error" role="alert">
          {error}
        </p>
      )}
      {!available && (
        <p className="translator-kicker">
          If the glossary is unavailable, scanning, translation, review, and
          export still work normally.
        </p>
      )}
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
    const shortcut = DEFAULT_SHORTCUTS[command];
    const conflict = SHORTCUT_COMMANDS.find(
      (candidate) =>
        candidate.id !== command && shortcuts[candidate.id] === shortcut,
    );
    if (conflict) {
      setError(
        `${displayShortcut(shortcut)} is already assigned to “${conflict.label}”.`,
      );
      return;
    }
    onChange({ ...shortcuts, [command]: shortcut });
    setCapturing(null);
    setError(null);
  }

  return (
    <section
      id="settings-panel-shortcuts"
      className={"translator-settings-page" + (active ? " is-active" : "")}
      role="tabpanel"
      aria-label="Shortcuts"
      hidden={!active}
    >
      <div className="translator-settings-title-row">
        <div>
          <h3>Shortcuts</h3>
          <p className="translator-settings-intro">
            Click a shortcut, then press the new key combination.
          </p>
        </div>
        <button
          className="translator-button translator-button-quiet"
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
        <p className="translator-shortcut-error" role="alert">
          {error}
        </p>
      )}
      <div className="translator-shortcut-list">
        {SHORTCUT_COMMANDS.map((command, index) => {
          const startsGroup =
            index === 0 || SHORTCUT_COMMANDS[index - 1].group !== command.group;
          const changed =
            shortcuts[command.id] !== DEFAULT_SHORTCUTS[command.id];
          return (
            <div key={command.id}>
              {startsGroup && <h4>{command.group}</h4>}
              <div className="translator-shortcut-row">
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
                    if (capturing !== command.id) return;
                    // Tab always keeps its focus role so capture can never trap
                    // keyboard users; moving focus away ends capture on blur.
                    if (event.key === "Tab") return;
                    if (
                      event.key === "Escape" &&
                      !event.ctrlKey &&
                      !event.metaKey &&
                      !event.altKey
                    ) {
                      event.preventDefault();
                      event.stopPropagation();
                      setCapturing(null);
                      setError(null);
                      return;
                    }
                    capture(command.id, event);
                  }}
                  onBlur={() => {
                    if (capturing === command.id) setCapturing(null);
                  }}
                >
                  {capturing === command.id
                    ? "Press keys… (Esc to cancel)"
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
      <p className="translator-kicker">
        Window and developer shortcuts such as Alt+F4 and Ctrl+Shift+I are
        reserved. Plain letters require a modifier. Tab moves focus and Escape
        cancels recording, so neither can be recorded as a new shortcut.
      </p>
    </section>
  );
}
