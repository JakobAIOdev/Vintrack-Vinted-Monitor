const statusEl = document.getElementById("status");
const hintEl = document.getElementById("hint");
const lastSyncEl = document.getElementById("last-sync");
const domainCountEl = document.getElementById("domain-count");
const connectionBadgeEl = document.getElementById("connection-badge");
const autoBadgeEl = document.getElementById("auto-badge");
const syncButton = document.getElementById("sync");
const clearButton = document.getElementById("clear");
const extensionApi = globalThis.browser || globalThis.chrome;

async function sendRuntimeMessage(message) {
  try {
    return await extensionApi.runtime.sendMessage(message);
  } catch (error) {
    return { ok: false, error: error?.message || "Extension request failed" };
  }
}

function setStatus(text) {
  statusEl.textContent = text;
}

function setBadge(el, text, tone) {
  el.textContent = text;
  el.dataset.tone = tone;
}

function applyTheme(theme) {
  if (theme === "dark" || theme === "light") {
    document.documentElement.dataset.theme = theme;
    return;
  }
  delete document.documentElement.dataset.theme;
}

function formatTimestamp(value) {
  if (!value) {
    return "No sync yet";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "No sync yet";
  }

  return date.toLocaleString();
}

function renderState(response) {
  applyTheme(response?.theme);

  const configured = Boolean(response?.configured);
  const domains = Array.isArray(response?.syncedDomains)
    ? response.syncedDomains
    : [];
  const lastSyncStatus = response?.lastSyncStatus || "idle";
  const lastSyncError = response?.lastSyncError || "";

  setBadge(
    connectionBadgeEl,
    configured ? "Connected" : "Awaiting connect",
    configured ? "ok" : "muted",
  );
  setBadge(
    autoBadgeEl,
    lastSyncStatus === "ok" ? "Auto-sync healthy" : "Watching session",
    lastSyncStatus === "ok" ? "ok" : "muted",
  );
  domainCountEl.textContent = String(domains.length);
  lastSyncEl.textContent = formatTimestamp(response?.lastSyncAt);

  if (!configured) {
    setStatus("Connect this browser once from the Vintrack account page.");
    hintEl.textContent = "After that, session updates sync automatically.";
    syncButton.disabled = true;
    clearButton.disabled = false;
    return;
  }

  syncButton.disabled = false;
  clearButton.disabled = false;

  if (lastSyncStatus === "ok") {
    setStatus(
      domains.length > 0
        ? `Tracking ${domains.length} Vinted domain${domains.length === 1 ? "" : "s"}.`
        : "Connected and waiting for an active Vinted session.",
    );
    hintEl.textContent = "Only the current Vinted session token is synced.";
    return;
  }

  if (lastSyncError) {
    setStatus(`Last sync issue: ${lastSyncError}`);
    hintEl.textContent =
      domains.length > 0
        ? "The previous successful session is still saved. Open Vinted and sync again to refresh it."
        : "Make sure you are signed in to Vinted in this browser, then sync again.";
    return;
  }

  setStatus("Connected and ready.");
  hintEl.textContent = "Keep using Vinted normally in this browser.";
}

async function refreshState() {
  renderState(
    await sendRuntimeMessage({ type: "VINTRACK_EXTENSION_PING" }),
  );
}

refreshState();

syncButton.addEventListener("click", async () => {
  syncButton.disabled = true;
  syncButton.textContent = "Syncing...";

  const response = await sendRuntimeMessage({
    type: "VINTRACK_EXTENSION_MANUAL_SYNC",
  });
  if (!response?.ok) {
    setStatus(response?.error || "Sync failed.");
    hintEl.textContent = "Open a Vinted tab in this browser, then try again.";
    syncButton.disabled = false;
    syncButton.textContent = "Sync";
    return;
  }

  renderState(response);
  syncButton.textContent = "Sync";
});

clearButton.addEventListener("click", async () => {
  if (
    !confirm(
      "Clear Vintrack extension data on this browser? Vinted cookies will stay untouched.",
    )
  ) {
    return;
  }

  clearButton.disabled = true;
  clearButton.textContent = "Clearing...";

  const response = await sendRuntimeMessage({
    type: "VINTRACK_EXTENSION_CLEAR_LOCAL_STATE",
  });
  renderState(response);
  clearButton.textContent = "Clear extension data";
});
