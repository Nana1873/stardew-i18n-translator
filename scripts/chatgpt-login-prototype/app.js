const $ = (id) => document.getElementById(id);
const csrf = document.querySelector('meta[name="prototype-csrf"]').content;
let working = false,
  stopped = false,
  lastStatus,
  poll;
async function api(path, data = {}) {
  const response = await fetch(`/api/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Prototype-CSRF": csrf },
    body: JSON.stringify(data),
  });
  const body = await response.json();
  if (body.diagnostic) renderDiagnostic(body.diagnostic);
  if (!response.ok)
    throw new Error(body.error || "The request could not be completed.");
  return body;
}
function message(text, error = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", error);
}
function renderDiagnostic(data) {
  $("diagnostics").hidden = !data;
  $("diagnostic-output").textContent = data
    ? JSON.stringify(data, null, 2)
    : "";
}
function badge(id, text, state = "") {
  $(id).textContent = text;
  $(id).className = `badge ${state}`;
}
function renderModels(models) {
  const selected = $("model").value;
  $("model").replaceChildren();
  if (!models.length) {
    const option = document.createElement("option");
    option.textContent = "No models loaded";
    $("model").append(option);
  }
  for (const model of models) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.name;
    $("model").append(option);
  }
  if (models.some((model) => model.id === selected))
    $("model").value = selected;
}
function render(status) {
  lastStatus = status;
  const busy = working || status.busy;
  $("login").disabled = busy;
  $("new-account").disabled = busy;
  $("logout").disabled = busy || !status.signedIn;
  $("models").disabled = busy || !status.planEnabled;
  $("model").disabled = busy || !status.models.length;
  $("translate").disabled =
    busy || !status.planEnabled || !status.models.length;
  $("source").disabled = busy;
  $("language").disabled = busy;
  $("stop").disabled = busy;
  badge(
    "login-badge",
    status.signedIn
      ? status.planEnabled
        ? "Plan permission granted"
        : "Plan permission missing"
      : status.pending
        ? "Waiting for browser"
        : "Not signed in",
    status.planEnabled ? "good" : "",
  );
  $("account").textContent = status.account
    ? `Active account: ${status.account}`
    : "Your browser handles sign-in and permission to use your ChatGPT plan.";
  $("welcome").hidden = !status.message;
  $("welcome").textContent = status.message;
  badge(
    "model-badge",
    status.models.length
      ? `${status.models.length} models available`
      : "Models not loaded",
    status.models.length ? "good" : "",
  );
  renderModels(status.models);
  renderDiagnostic(status.diagnostic);
  if (status.error && !working) message(status.error, true);
}
async function refresh() {
  if (!stopped) render(await api("status"));
}
async function run(action) {
  if (working) return;
  working = true;
  if (lastStatus) render(lastStatus);
  try {
    await action();
  } catch (error) {
    message(error.message, true);
  } finally {
    working = false;
    try {
      await refresh();
    } catch {}
  }
}
async function login(newAccount) {
  await run(async () => {
    const data = await api("login", { newAccount });
    const url = new URL(data.authorizationUrl);
    if (url.origin !== "https://auth.openai.com")
      throw new Error("Unexpected sign-in destination.");
    // Navigate the existing tab to avoid popup blockers. OAuth returns to this page.
    window.location.assign(url.href);
  });
}
$("login").addEventListener("click", () => login(false));
$("new-account").addEventListener("click", () => login(true));
$("models").addEventListener("click", () =>
  run(async () => {
    message("Loading the account's model catalog…");
    await api("models");
    message("Models loaded. Choose one and translate the sample.");
  }),
);
$("translate").addEventListener("click", () =>
  run(async () => {
    $("result").hidden = true;
    $("empty").hidden = false;
    $("usage").textContent = "";
    badge("result-badge", "Waiting for completion");
    message("Translating with your ChatGPT plan…");
    try {
      const result = await api("translate", {
        text: $("source").value,
        language: $("language").value,
        model: $("model").value,
      });
      $("result").textContent = result.text;
      $("result").hidden = false;
      $("empty").hidden = true;
      badge(
        "result-badge",
        result.tokensPreserved
          ? "Completed · placeholders preserved"
          : "Completed · check placeholders",
        result.tokensPreserved ? "good" : "bad",
      );
      $("usage").textContent =
        `${result.model}${result.usage ? ` · ${result.usage.inputTokens ?? "—"} input / ${result.usage.outputTokens ?? "—"} output tokens` : ""}${result.requestId ? ` · ${result.requestId}` : ""}`;
      message(
        "The request completed successfully. Review the suggestion before using it.",
      );
    } catch (error) {
      badge("result-badge", "Request did not complete", "bad");
      throw error;
    }
  }),
);
$("cancel").addEventListener("click", async () => {
  try {
    const data = await api("cancel");
    message(data.message);
  } catch (error) {
    message(error.message, true);
  }
});
$("logout").addEventListener("click", () =>
  run(async () => {
    const data = await api("logout");
    $("result").hidden = true;
    $("empty").hidden = false;
    $("usage").textContent = "";
    badge("result-badge", "No request yet");
    message(data.message, !data.revoked);
  }),
);
$("stop").addEventListener("click", () =>
  run(async () => {
    const data = await api("stop");
    stopped = true;
    clearInterval(poll);
    message(
      `${data.message} The local prototype is now closed.`,
      !data.revoked,
    );
    for (const button of document.querySelectorAll("button"))
      button.disabled = true;
  }),
);
refresh().catch(() =>
  message("The local prototype is not running. Start it again.", true),
);
poll = setInterval(() => {
  if (!working)
    refresh().catch(() => {
      stopped = true;
      clearInterval(poll);
      message("The local prototype has stopped. Start it again to continue.");
    });
}, 2000);
