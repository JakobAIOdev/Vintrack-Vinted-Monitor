const STORAGE_KEYS = {
  token: "browserLinkToken",
  appOrigin: "vintrackAppOrigin",
  lastSyncAt: "vintrackLastSyncAt",
  lastSyncAttemptAt: "vintrackLastSyncAttemptAt",
  lastSyncStatus: "vintrackLastSyncStatus",
  lastSyncError: "vintrackLastSyncError",
  syncedDomains: "vintrackSyncedDomains",
  checkoutLinks: "vintrackCheckoutLinks",
  theme: "vintrackTheme",
};
const PERIODIC_SYNC_ALARM = "vintrackPeriodicSync";
const PERIODIC_SYNC_MINUTES = 10;
const BUY_TAB_READY_TIMEOUT_MS = 20000;
const SYNC_REQUEST_TIMEOUT_MS = 15000;
const PROACTIVE_BROWSER_REFRESH_MS = 2 * 60 * 1000;
const COMPLETED_SYNC_STATUSES = new Set(["completed", "refreshed"]);
const VINTRACK_APP_ORIGINS = new Set([
  "https://vintrack.jakobaio.dev",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);
const SUPPORTED_VINTED_DOMAINS = [
  "vinted.at",
  "vinted.be",
  "vinted.co.uk",
  "vinted.com",
  "vinted.cz",
  "vinted.de",
  "vinted.dk",
  "vinted.es",
  "vinted.fi",
  "vinted.fr",
  "vinted.hr",
  "vinted.hu",
  "vinted.ie",
  "vinted.it",
  "vinted.lt",
  "vinted.lu",
  "vinted.nl",
  "vinted.pl",
  "vinted.pt",
  "vinted.ro",
  "vinted.se",
  "vinted.sk",
];
const extensionApi = globalThis.browser || globalThis.chrome;
const isFirefoxExtension = typeof globalThis.browser !== "undefined";
const inFlightSyncs = new Map();

function sanitizeDomain(domain) {
  return (domain || "").replace(/^\./, "").trim().toLowerCase();
}

function isVintedDomain(domain) {
  const normalized = sanitizeDomain(domain);
  return SUPPORTED_VINTED_DOMAINS.some(
    (supported) =>
      normalized === supported || normalized.endsWith(`.${supported}`),
  );
}

function manifestAllowsAppOrigin(url) {
  const matches = (extensionApi.runtime.getManifest().content_scripts || [])
    .flatMap((entry) => entry.matches || []);
  return matches.some((pattern) => {
    if (pattern.includes("*.vinted.")) {
      return false;
    }
    try {
      const patternUrl = new URL(pattern.replace("*", "match"));
      return (
        patternUrl.protocol === url.protocol &&
        patternUrl.hostname === url.hostname
      );
    } catch {
      return false;
    }
  });
}

function allowedAppOrigin(value) {
  try {
    const url = new URL(String(value || ""));
    return VINTRACK_APP_ORIGINS.has(url.origin) && manifestAllowsAppOrigin(url)
      ? url.origin
      : "";
  } catch {
    return "";
  }
}

function senderOrigin(sender) {
  try {
    return new URL(sender?.url || "").origin;
  } catch {
    return "";
  }
}

function isExtensionPageSender(sender) {
  try {
    const protocol = new URL(sender?.url || "").protocol;
    return protocol === "chrome-extension:" || protocol === "moz-extension:";
  } catch {
    return false;
  }
}

function isAllowedAppSender(sender, expectedOrigin = "") {
  const origin = allowedAppOrigin(senderOrigin(sender));
  return Boolean(origin && (!expectedOrigin || origin === expectedOrigin));
}

function domainFromUrl(value) {
  try {
    return sanitizeDomain(new URL(value).hostname);
  } catch {
    return "";
  }
}

function cookieLookupDetails(domain, name, storeId) {
  const details = {
    url: `https://${sanitizeDomain(domain)}/`,
    name,
  };
  if (storeId) {
    details.storeId = storeId;
  }
  return details;
}

function cookieSyncKey(domain, storeId) {
  return `${sanitizeDomain(domain)}|${storeId || ""}`;
}

function accessTokenClaims(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) {
    return {};
  }

  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload.padEnd(Math.ceil(payload.length / 4) * 4, "=");
    return JSON.parse(atob(padded));
  } catch {
    return {};
  }
}

function accessTokenIdentityIds(token) {
  const claims = accessTokenClaims(token);
  return [claims?.act?.sub, claims?.sub, claims?.account_id]
    .map((value) => Number(value || 0))
    .filter(
      (value, index, values) =>
        Number.isFinite(value) && value > 0 && values.indexOf(value) === index,
    );
}

function accessTokenAccountId(token) {
  return accessTokenIdentityIds(token)[0] || 0;
}

function accessTokenIssuedAt(token) {
  const issuedAt = Number(accessTokenClaims(token)?.iat || 0);
  return Number.isFinite(issuedAt) && issuedAt > 0 ? issuedAt : 0;
}

function accessTokenExpiresSoon(token) {
  const expiresAt = Number(accessTokenClaims(token)?.exp || 0);
  return (
    expiresAt > 0 &&
    expiresAt * 1000 - Date.now() <= PROACTIVE_BROWSER_REFRESH_MS
  );
}

function cookieDomainMatches(cookieDomain, targetDomain) {
  const cookieHost = sanitizeDomain(cookieDomain);
  const targetHost = sanitizeDomain(targetDomain);
  return (
    cookieHost === targetHost ||
    targetHost.endsWith(`.${cookieHost}`) ||
    cookieHost.endsWith(`.${targetHost}`)
  );
}

function itemUrlForDomain(itemUrl, domain, itemId) {
  const normalizedDomain = sanitizeDomain(domain);
  if (!itemUrl) {
    return `https://${normalizedDomain}/items/${itemId}`;
  }

  try {
    const parsed = new URL(itemUrl);
    parsed.protocol = "https:";
    parsed.hostname = normalizedDomain;
    return parsed.toString();
  } catch {
    return `https://${normalizedDomain}/items/${itemId}`;
  }
}

async function getConfig() {
  const storage = await extensionApi.storage.local.get(
    Object.values(STORAGE_KEYS),
  );
  const normalizedOrigin = allowedAppOrigin(storage[STORAGE_KEYS.appOrigin]);
  if (storage[STORAGE_KEYS.appOrigin] && !normalizedOrigin) {
    await extensionApi.storage.local.remove([
      STORAGE_KEYS.token,
      STORAGE_KEYS.appOrigin,
    ]);
    storage[STORAGE_KEYS.token] = "";
    storage[STORAGE_KEYS.appOrigin] = "";
  } else if (
    normalizedOrigin &&
    normalizedOrigin !== storage[STORAGE_KEYS.appOrigin]
  ) {
    await extensionApi.storage.local.set({
      [STORAGE_KEYS.appOrigin]: normalizedOrigin,
    });
    storage[STORAGE_KEYS.appOrigin] = normalizedOrigin;
  }
  return storage;
}

async function userAgentForSync() {
  if (!isFirefoxExtension) {
    return navigator.userAgent;
  }

  try {
    const permissions = await extensionApi.permissions.getAll();
    return permissions?.data_collection?.includes("technicalAndInteraction")
      ? navigator.userAgent
      : "";
  } catch {
    return "";
  }
}

async function clearLocalExtensionState() {
  for (const timer of syncTimers.values()) {
    clearTimeout(timer);
  }
  syncTimers.clear();
  await extensionApi.storage.local.remove(Object.values(STORAGE_KEYS));
}

async function getStoredCheckoutLinks() {
  const storage = await extensionApi.storage.local.get(
    STORAGE_KEYS.checkoutLinks,
  );
  return Array.isArray(storage[STORAGE_KEYS.checkoutLinks])
    ? storage[STORAGE_KEYS.checkoutLinks]
    : [];
}

async function storeCheckoutLink(entry) {
  if (!entry?.checkoutUrl) {
    return;
  }

  const links = await getStoredCheckoutLinks();
  const normalizedEntry = {
    itemId: Number(entry.itemId || 0),
    sellerId: Number(entry.sellerId || 0),
    transactionId: Number(entry.transactionId || 0),
    purchaseId: String(entry.purchaseId || "").trim(),
    checkoutUrl: String(entry.checkoutUrl || "").trim(),
    domain: sanitizeDomain(entry.domain),
    createdAt: new Date().toISOString(),
  };

  const nextLinks = [
    normalizedEntry,
    ...links.filter((link) => {
      const sameTransaction =
        normalizedEntry.transactionId &&
        Number(link?.transactionId || 0) === normalizedEntry.transactionId;
      const samePurchase =
        normalizedEntry.purchaseId &&
        String(link?.purchaseId || "").trim() === normalizedEntry.purchaseId;
      const sameItemSeller =
        normalizedEntry.itemId &&
        normalizedEntry.sellerId &&
        Number(link?.itemId || 0) === normalizedEntry.itemId &&
        Number(link?.sellerId || 0) === normalizedEntry.sellerId &&
        sanitizeDomain(link?.domain || "") === normalizedEntry.domain;
      return !(sameTransaction || samePurchase || sameItemSeller);
    }),
  ].slice(0, 20);

  await extensionApi.storage.local.set({
    [STORAGE_KEYS.checkoutLinks]: nextLinks,
  });
}

async function findStoredCheckoutLink(match) {
  const links = await getStoredCheckoutLinks();
  const normalizedDomain = sanitizeDomain(match?.domain || "");
  const transactionId = Number(match?.transactionId || 0);
  const itemId = Number(match?.itemId || 0);
  const sellerId = Number(match?.sellerId || 0);

  return (
    links.find(
      (link) =>
        transactionId && Number(link?.transactionId || 0) === transactionId,
    ) ||
    links.find(
      (link) =>
        itemId &&
        sellerId &&
        Number(link?.itemId || 0) === itemId &&
        Number(link?.sellerId || 0) === sellerId &&
        sanitizeDomain(link?.domain || "") === normalizedDomain,
    ) ||
    null
  );
}

async function findExistingCheckoutTab(domain) {
  const normalizedDomain = sanitizeDomain(domain);
  const matchingTabs = await extensionApi.tabs.query({
    url: [`https://${normalizedDomain}/checkout*`],
  });
  const existingTab = matchingTabs
    .filter((tab) => typeof tab.id === "number" && typeof tab.url === "string")
    .sort((a, b) => (b.id || 0) - (a.id || 0))[0];
  return existingTab || null;
}

function ensurePeriodicSyncAlarm() {
  extensionApi.alarms.create(PERIODIC_SYNC_ALARM, {
    delayInMinutes: 1,
    periodInMinutes: PERIODIC_SYNC_MINUTES,
  });
}

function isCompletedSyncResult(result) {
  return Boolean(
    result?.ok &&
    result.domain &&
    (!result.status || COMPLETED_SYNC_STATUSES.has(result.status)),
  );
}

function syncStatusError(
  data,
  fallback = "Vinted session sync was not accepted.",
) {
  if (typeof data?.error === "string" && data.error.trim()) {
    return data.error.trim();
  }

  switch (data?.status) {
    case "ignored_domain":
      return `The open Vinted session is for ${data.ignored_domain || "another domain"}, but Vintrack is linked to ${data.domain || "a different domain"}.`;
    case "ignored_account":
      return "The open Vinted tab is signed in to a different account than the one linked to Vintrack.";
    case "ignored_invalid_browser_session":
      return "Vinted rejected the browser session token. Reload the logged-in Vinted tab and try again.";
    default:
      return fallback;
  }
}

function syncResultError(result) {
  if (typeof result?.error === "string" && result.error.trim()) {
    return result.error.trim();
  }

  switch (result?.reason) {
    case "missing-browser-token":
      return "No active Vinted session token was found. Open a logged-in Vinted tab and sync again.";
    case "no-open-vinted-tab":
      return "Open a logged-in Vinted tab, then sync again.";
    case "not-configured":
      return "Connect the extension from the Vintrack account page first.";
    case "unsupported-domain":
      return "The selected site is not a supported Vinted domain.";
    default:
      return typeof result?.reason === "string" ? result.reason : "";
  }
}

async function getOpenVintedTabs(preferredDomain = "") {
  const normalizedPreferredDomain = sanitizeDomain(preferredDomain);
  const tabs = await extensionApi.tabs.query({});
  return tabs.filter((tab) => {
    const domain = domainFromUrl(tab?.url || "");
    if (!domain || !isVintedDomain(domain)) {
      return false;
    }
    return (
      !normalizedPreferredDomain ||
      domain === normalizedPreferredDomain ||
      cookieDomainMatches(domain, normalizedPreferredDomain)
    );
  });
}

function mostRecentlyUsedTab(tabs) {
  return [...tabs].sort(
    (left, right) =>
      Number(right?.lastAccessed || 0) - Number(left?.lastAccessed || 0) ||
      Number(right?.id || 0) - Number(left?.id || 0),
  )[0];
}

async function getBrowserAccountForTab(tab) {
  if (typeof tab?.id !== "number") {
    return { ok: false, error: "The selected Vinted tab is unavailable." };
  }

  try {
    await waitForTabBridge(tab.id, 3000);
  } catch {
    await extensionApi.tabs.reload(tab.id);
    await waitForTabLoad(tab.id);
    await waitForTabBridge(tab.id, 10000);
  }
  return extensionApi.tabs.sendMessage(tab.id, {
    type: "VINTRACK_GET_BROWSER_ACCOUNT",
    payload: { requestId: crypto.randomUUID() },
  });
}

async function selectAccessCookieForTab(
  tab,
  preferredDomain = "",
  accountId = 0,
) {
  const tabDomain = domainFromUrl(tab?.url || "");
  const targetDomain = tabDomain || sanitizeDomain(preferredDomain);
  const storeId =
    typeof tab?.cookieStoreId === "string" ? tab.cookieStoreId : "";
  const cookies = (await extensionApi.cookies.getAll({
    name: "access_token_web",
  })).filter((cookie) => {
    const cookieStoreId =
      typeof cookie?.storeId === "string" ? cookie.storeId : "";
    return (
      cookieDomainMatches(cookie?.domain || "", targetDomain) &&
      (!storeId || cookieStoreId === storeId) &&
      (!accountId || accessTokenIdentityIds(cookie?.value).includes(accountId))
    );
  });

  return [...cookies].sort((left, right) => {
    const issuedAtDifference =
      accessTokenIssuedAt(right?.value) - accessTokenIssuedAt(left?.value);
    if (issuedAtDifference !== 0) {
      return issuedAtDifference;
    }
    const leftDomain = sanitizeDomain(left?.domain || "");
    const rightDomain = sanitizeDomain(right?.domain || "");
    if (leftDomain === targetDomain && rightDomain !== targetDomain) return -1;
    if (rightDomain === targetDomain && leftDomain !== targetDomain) return 1;
    return Number(right?.expirationDate || 0) - Number(left?.expirationDate || 0);
  })[0];
}

async function refreshOpenVintedBrowserSessions(preferredDomain = "") {
  const tabs = await getOpenVintedTabs(preferredDomain);
  if (tabs.length === 0) {
    return [
      {
        ok: false,
        reason: "no-open-vinted-tab",
        error: "Open a logged-in Vinted tab, then sync again.",
      },
    ];
  }

  const results = [];

  for (const tab of tabs) {
    if (typeof tab.id !== "number") {
      continue;
    }

    try {
      try {
        await waitForTabBridge(tab.id, 5000);
      } catch {
        await extensionApi.tabs.reload(tab.id);
        await waitForTabLoad(tab.id);
        await waitForTabBridge(tab.id, 10000);
      }
      const result = await extensionApi.tabs.sendMessage(tab.id, {
        type: "VINTRACK_REFRESH_BROWSER_SESSION",
        payload: { requestId: crypto.randomUUID() },
      });
      results.push({
        ok: Boolean(result?.ok),
        domain: sanitizeDomain(result?.domain || domainFromUrl(tab.url || "")),
        tabId: tab.id,
        status: result?.status,
        error: result?.error || "",
      });
    } catch (error) {
      results.push({
        ok: false,
        domain: domainFromUrl(tab.url || ""),
        tabId: tab.id,
        error: error instanceof Error ? error.message : "unknown-error",
      });
    }
  }

  if (results.some((result) => result.ok)) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return results;
}

async function persistSyncState(results) {
  const normalizedResults =
    results.length > 0
      ? results
      : [
          {
            ok: false,
            reason: "missing-browser-token",
            error: "Open or reload a logged-in Vinted tab, then sync again.",
          },
        ];
  const successfulDomains = [
    ...new Set(
      results.filter(isCompletedSyncResult).map((result) => result.domain),
    ),
  ];
  const failedResult = normalizedResults.find((result) => !result.ok);
  const now = new Date().toISOString();
  const previous = await extensionApi.storage.local.get([
    STORAGE_KEYS.lastSyncAt,
    STORAGE_KEYS.syncedDomains,
  ]);
  const previousDomains = Array.isArray(previous[STORAGE_KEYS.syncedDomains])
    ? previous[STORAGE_KEYS.syncedDomains]
    : [];
  const hasSuccessfulSync = successfulDomains.length > 0;

  await extensionApi.storage.local.set({
    [STORAGE_KEYS.lastSyncAt]: hasSuccessfulSync
      ? now
      : previous[STORAGE_KEYS.lastSyncAt] || "",
    [STORAGE_KEYS.lastSyncAttemptAt]: now,
    [STORAGE_KEYS.lastSyncStatus]: hasSuccessfulSync
      ? "ok"
      : failedResult
        ? "error"
        : "idle",
    [STORAGE_KEYS.lastSyncError]: syncResultError(failedResult),
    [STORAGE_KEYS.syncedDomains]: hasSuccessfulSync
      ? successfulDomains
      : previousDomains,
  });
}

function formatRuntimeState(storage) {
  const theme =
    storage.vintrackTheme === "dark" || storage.vintrackTheme === "light"
      ? storage.vintrackTheme
      : "system";

  return {
    installed: true,
    version: extensionApi.runtime.getManifest().version || "",
    configured: Boolean(storage.browserLinkToken && storage.vintrackAppOrigin),
    theme,
    syncedDomains: Array.isArray(storage.vintrackSyncedDomains)
      ? storage.vintrackSyncedDomains
      : [],
    lastSyncAt:
      typeof storage.vintrackLastSyncAt === "string"
        ? storage.vintrackLastSyncAt
        : "",
    lastSyncAttemptAt:
      typeof storage.vintrackLastSyncAttemptAt === "string"
        ? storage.vintrackLastSyncAttemptAt
        : "",
    lastSyncStatus:
      typeof storage.vintrackLastSyncStatus === "string"
        ? storage.vintrackLastSyncStatus
        : "idle",
    lastSyncError:
      typeof storage.vintrackLastSyncError === "string"
        ? storage.vintrackLastSyncError
        : "",
  };
}

async function performDomainSync(domain, options = {}) {
  const normalizedDomain = sanitizeDomain(domain);
  const storeId = typeof options.storeId === "string" ? options.storeId : "";
  const selectedAccessToken = String(options.accessToken || "").trim();
  const allowAccountSwitch = options.allowAccountSwitch === true;
  const browserVintedId = Number(options.browserVintedId || 0);
  const browserVintedName = String(options.browserVintedName || "").trim();
  if (!isVintedDomain(normalizedDomain)) {
    return { ok: false, reason: "unsupported-domain" };
  }

  const { browserLinkToken, vintrackAppOrigin } = await getConfig();
  if (!browserLinkToken || !vintrackAppOrigin) {
    return { ok: false, reason: "not-configured" };
  }

  const accessCookie = selectedAccessToken
    ? { value: selectedAccessToken }
    : await extensionApi.cookies.get(
        cookieLookupDetails(normalizedDomain, "access_token_web", storeId),
      );

  if (!accessCookie?.value) {
    return { ok: false, reason: "missing-browser-token" };
  }
  if (accessTokenExpiresSoon(accessCookie.value)) {
    return {
      ok: false,
      domain: normalizedDomain,
      storeId,
      reason: "browser-token-needs-refresh",
      retryable: true,
      error:
        "The Vinted browser session token is expiring and needs to be refreshed.",
    };
  }

  const endpoint = `${vintrackAppOrigin}/api/account/extension-sync/complete`;
  const userAgent = await userAgentForSync();
  let response;
  let data = {};

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      SYNC_REQUEST_TIMEOUT_MS,
    );
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          link_token: browserLinkToken,
          access_token: accessCookie?.value || "",
          domain: normalizedDomain,
          user_agent: userAgent,
          allow_account_switch: allowAccountSwitch,
          browser_vinted_id: browserVintedId,
          browser_vinted_name: browserVintedName,
        }),
        signal: controller.signal,
      });
      data = await response.json().catch(() => ({}));
    } catch (error) {
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 750));
        continue;
      }
      return {
        ok: false,
        domain: normalizedDomain,
        storeId,
        reason:
          error?.name === "AbortError" ? "sync-timeout" : "sync-network-error",
        retryable: true,
        error:
          error?.name === "AbortError"
            ? "Vintrack did not answer the session sync request in time."
            : error instanceof Error
              ? error.message
              : "Could not reach Vintrack for session sync.",
      };
    } finally {
      clearTimeout(timeout);
    }

    if (response.ok || (response.status < 500 && response.status !== 429)) {
      break;
    }
    if (attempt === 0) {
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  }

  if (!response?.ok) {
    return {
      ok: false,
      domain: normalizedDomain,
      storeId,
      reason: "server-sync-failed",
      statusCode: response?.status || 0,
      retryable:
        response?.status === 401 ||
        response?.status === 403 ||
        response?.status >= 500,
      error: syncStatusError(
        data,
        `Sync failed (${response?.status || "network error"})`,
      ),
    };
  }

  const status = typeof data.status === "string" ? data.status : "completed";
  const completed = COMPLETED_SYNC_STATUSES.has(status);
  return {
    ok: completed,
    domain: sanitizeDomain(data.domain || normalizedDomain),
    status,
    storeId,
    vintedId: Number(data.vinted_id || 0),
    vintedName:
      typeof data.vinted_name === "string" ? data.vinted_name.trim() : "",
    reason: completed ? "" : status || "sync-not-completed",
    retryable: status === "ignored_invalid_browser_session",
    error: completed ? "" : syncStatusError(data),
  };
}

async function syncDomain(domain, options = {}) {
  const normalizedDomain = sanitizeDomain(domain);
  const storeId = typeof options.storeId === "string" ? options.storeId : "";
  const accessToken = String(options.accessToken || "").trim();
  const accountId = accessTokenAccountId(accessToken);
  const key = `${cookieSyncKey(normalizedDomain, storeId)}|${accountId}|${options.allowAccountSwitch === true}`;
  const activeSync = inFlightSyncs.get(key);
  if (activeSync) {
    return activeSync;
  }

  const sync = performDomainSync(normalizedDomain, {
    storeId,
    accessToken,
    allowAccountSwitch: options.allowAccountSwitch === true,
    browserVintedId: options.browserVintedId,
    browserVintedName: options.browserVintedName,
  });
  inFlightSyncs.set(key, sync);
  try {
    return await sync;
  } finally {
    if (inFlightSyncs.get(key) === sync) {
      inFlightSyncs.delete(key);
    }
  }
}

async function syncAllVintedDomains() {
  const accessCookies = await extensionApi.cookies.getAll({
    name: "access_token_web",
  });
  const candidates = new Map();

  for (const cookie of accessCookies) {
    const domain = sanitizeDomain(cookie.domain);
    if (!isVintedDomain(domain)) {
      continue;
    }
    const storeId = typeof cookie.storeId === "string" ? cookie.storeId : "";
    candidates.set(cookieSyncKey(domain, storeId), { domain, storeId });
  }

  const results = [];

  for (const candidate of candidates.values()) {
    try {
      results.push(
        await syncDomain(candidate.domain, { storeId: candidate.storeId }),
      );
    } catch (error) {
      results.push({
        ok: false,
        domain: candidate.domain,
        storeId: candidate.storeId,
        error: error instanceof Error ? error.message : "unknown-error",
      });
    }
  }

  return results;
}

async function syncPreferredOpenTab(preferredDomain, options = {}) {
  const tabs = await getOpenVintedTabs(preferredDomain);
  const selectedTab = mostRecentlyUsedTab(tabs);
  if (!selectedTab) {
    return [
      {
        ok: false,
        reason: "no-open-vinted-tab",
        error:
          "Open the Vinted account you want to use in a tab, then sync again.",
      },
    ];
  }

  const domain = domainFromUrl(selectedTab.url || "");
  let browserAccount;
  try {
    browserAccount = await getBrowserAccountForTab(selectedTab);
  } catch (error) {
    return [
      {
        ok: false,
        domain,
        reason: "browser-account-lookup-failed",
        error:
          error instanceof Error
            ? error.message
            : "Could not identify the account in the selected Vinted tab.",
      },
    ];
  }
  const accountId = Number(browserAccount?.accountId || 0);
  if (!browserAccount?.ok || !accountId) {
    return [
      {
        ok: false,
        domain,
        reason: "browser-account-lookup-failed",
        error:
          browserAccount?.error ||
          "Could not identify the account in the selected Vinted tab.",
      },
    ];
  }
  const accessCookie = await selectAccessCookieForTab(
    selectedTab,
    preferredDomain,
    accountId,
  );
  if (!accessCookie?.value) {
    return [
      {
        ok: false,
        domain,
        reason: "missing-browser-token",
        error:
          `No session token matched ${browserAccount.accountName ? `@${browserAccount.accountName}` : "the account"} open in the selected Vinted tab. Reload that tab and try again.`,
      },
    ];
  }

  const storeId =
    typeof accessCookie.storeId === "string" ? accessCookie.storeId : "";
  try {
    return [
      await syncDomain(domain, {
        storeId,
        accessToken: accessCookie.value,
        allowAccountSwitch: options.allowAccountSwitch === true,
        browserVintedId: accountId,
        browserVintedName: browserAccount.accountName,
      }),
    ];
  } catch (error) {
    return [
      {
        ok: false,
        domain,
        storeId,
        error: error instanceof Error ? error.message : "unknown-error",
      },
    ];
  }
}

async function syncPreferredOrAllDomains(preferredDomain, options = {}) {
  const normalizedPreferredDomain = sanitizeDomain(preferredDomain);
  if (options.preferOpenTab === true) {
    return syncPreferredOpenTab(normalizedPreferredDomain, options);
  }
  if (normalizedPreferredDomain && isVintedDomain(normalizedPreferredDomain)) {
    const cookies = (
      await extensionApi.cookies.getAll({ name: "access_token_web" })
    ).filter((cookie) =>
      cookieDomainMatches(cookie.domain, normalizedPreferredDomain),
    );
    const storeIds = [
      ...new Set(
        cookies.map((cookie) =>
          typeof cookie.storeId === "string" ? cookie.storeId : "",
        ),
      ),
    ];
    const targets = storeIds.length > 0 ? storeIds : [""];
    const results = [];

    for (const storeId of targets) {
      try {
        results.push(await syncDomain(normalizedPreferredDomain, { storeId }));
      } catch (error) {
        results.push({
          ok: false,
          domain: normalizedPreferredDomain,
          storeId,
          error: error instanceof Error ? error.message : "unknown-error",
        });
      }
    }

    if (results.some(isCompletedSyncResult)) {
      return results;
    }
    if (results.some((result) => result.reason !== "missing-browser-token")) {
      return results;
    }

    try {
      return [await syncDomain(normalizedPreferredDomain)];
    } catch (error) {
      return [
        {
          ok: false,
          domain: normalizedPreferredDomain,
          error: error instanceof Error ? error.message : "unknown-error",
        },
      ];
    }
  }

  return syncAllVintedDomains();
}

async function syncAndPersistPreferredOrAllDomains(
  preferredDomain,
  options = {},
) {
  let results = await syncPreferredOrAllDomains(preferredDomain, options);
  if (
    !results.some(isCompletedSyncResult) &&
    results.some(
      (result) => result.retryable || result.reason === "missing-browser-token",
    )
  ) {
    const refreshResults =
      await refreshOpenVintedBrowserSessions(preferredDomain);
    if (refreshResults.some((result) => result.ok)) {
      results = await syncPreferredOrAllDomains(preferredDomain, options);
      if (results.length === 0) {
        results = [
          {
            ok: false,
            reason: "missing-browser-token",
            error:
              "Vinted did not expose a fresh browser access token after refresh.",
          },
        ];
      }
    } else if (results.length === 0) {
      results = refreshResults;
    }
  }
  await persistSyncState(results);
  return results;
}

async function syncAndPersistAllDomains() {
  let results = await syncAllVintedDomains();
  if (
    !results.some(isCompletedSyncResult) &&
    (results.length === 0 ||
      results.some(
        (result) =>
          result.retryable || result.reason === "missing-browser-token",
      ))
  ) {
    const refreshResults = await refreshOpenVintedBrowserSessions();
    if (refreshResults.some((result) => result.ok)) {
      results = await syncAllVintedDomains();
      if (results.length === 0) {
        results = [
          {
            ok: false,
            reason: "missing-browser-token",
            error:
              "Vinted did not expose a fresh browser access token after refresh.",
          },
        ];
      }
    } else if (results.length === 0) {
      results = refreshResults;
    }
  }
  await persistSyncState(results);
  return results;
}

function waitForTabLoad(tabId, timeoutMs = BUY_TAB_READY_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      extensionApi.tabs.onUpdated.removeListener(handleUpdate);
      reject(new Error("Timed out waiting for Vinted tab to load"));
    }, timeoutMs);

    function handleUpdate(updatedTabId, changeInfo) {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") {
        return;
      }

      clearTimeout(timeout);
      extensionApi.tabs.onUpdated.removeListener(handleUpdate);
      resolve();
    }

    extensionApi.tabs
      .get(tabId)
      .then((tab) => {
        if (tab?.status === "complete") {
          clearTimeout(timeout);
          resolve();
          return;
        }

        extensionApi.tabs.onUpdated.addListener(handleUpdate);
      })
      .catch((error) => {
        clearTimeout(timeout);
        extensionApi.tabs.onUpdated.removeListener(handleUpdate);
        reject(error);
      });
  });
}

async function waitForTabBridge(tabId, timeoutMs = BUY_TAB_READY_TIMEOUT_MS) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await extensionApi.tabs.sendMessage(tabId, {
        type: "VINTRACK_TAB_PING",
      });
      if (response?.ok) {
        return;
      }
    } catch {
      // Wait for content script to attach to the tab.
    }

    await new Promise((resolve) => setTimeout(resolve, 350));
  }

  throw new Error(
    "Vintrack extension bridge did not become ready on the Vinted tab",
  );
}

async function ensureVintedBuyTab(targetUrl) {
  const target = new URL(targetUrl);
  const matchingTabs = await extensionApi.tabs.query({
    url: [`https://${target.host}/*`],
  });
  const existingTab = matchingTabs.find((tab) => typeof tab.id === "number");

  if (existingTab?.id) {
    if (existingTab.url !== targetUrl) {
      await extensionApi.tabs.update(existingTab.id, {
        url: targetUrl,
        active: false,
      });
      await waitForTabLoad(existingTab.id);
    }
    await waitForTabBridge(existingTab.id);
    return { tabId: existingTab.id, created: false };
  }

  const createdTab = await extensionApi.tabs.create({
    url: targetUrl,
    active: false,
  });
  if (typeof createdTab.id !== "number") {
    throw new Error("Failed to open Vinted tab for browser checkout");
  }

  await waitForTabLoad(createdTab.id);
  await waitForTabBridge(createdTab.id);
  return { tabId: createdTab.id, created: true };
}

async function handleBrowserBuy(payload) {
  const itemId = Number(payload?.itemId || 0);
  const sellerId = Number(payload?.sellerId || 0);
  const requestId = String(payload?.requestId || crypto.randomUUID());
  const itemUrl = String(payload?.itemUrl || "").trim();
  const preferredDomain = sanitizeDomain(String(payload?.domain || "").trim());
  const itemDomain = domainFromUrl(itemUrl);
  const normalizedDomain = sanitizeDomain(preferredDomain || itemDomain);

  if (!itemId || !sellerId) {
    return {
      ok: false,
      code: "invalid_buy_payload",
      error: "Missing item or seller information",
      requestId,
    };
  }

  if (!normalizedDomain || !isVintedDomain(normalizedDomain)) {
    return {
      ok: false,
      code: "invalid_domain",
      error: "A valid Vinted domain is required for browser checkout",
      requestId,
    };
  }

  async function runCheckoutOnDomain(domain) {
    const checkoutDomain = sanitizeDomain(domain);
    const targetUrl = itemUrlForDomain(itemUrl, checkoutDomain, itemId);
    const { tabId, created } = await ensureVintedBuyTab(targetUrl);
    const result = await extensionApi.tabs.sendMessage(tabId, {
      type: "VINTRACK_RUN_BROWSER_BUY",
      payload: {
        requestId,
        itemId,
        sellerId,
        domain: checkoutDomain,
        itemUrl: targetUrl,
        phoneNumber: String(payload?.phoneNumber || "").trim(),
        incogniaRequestToken: String(
          payload?.incogniaRequestToken || "",
        ).trim(),
        browserInfo: payload?.browserInfo || {},
        paymentMethod: payload?.paymentMethod || {},
        pickupType: Number(payload?.pickupType || 1),
      },
    });

    return { result, tabId, created, domain: checkoutDomain };
  }

  let attempt = await runCheckoutOnDomain(normalizedDomain);
  let result = attempt.result;
  let tabId = attempt.tabId;
  let created = attempt.created;
  let checkoutDomain = attempt.domain;

  const fallbackDomain =
    itemDomain && itemDomain !== checkoutDomain && isVintedDomain(itemDomain)
      ? itemDomain
      : "";
  if (
    fallbackDomain &&
    result &&
    !result.ok &&
    !["datadome_challenge", "payment_already_processing"].includes(result.code)
  ) {
    if (created) {
      await extensionApi.tabs.remove(tabId).catch(() => {});
    }
    attempt = await runCheckoutOnDomain(fallbackDomain);
    result = attempt.result;
    tabId = attempt.tabId;
    created = attempt.created;
    checkoutDomain = attempt.domain;
  }

  if (result?.ok) {
    if (result.checkoutUrl) {
      await storeCheckoutLink({
        itemId,
        sellerId,
        transactionId: result.transactionId,
        purchaseId: result.purchaseId,
        checkoutUrl: result.checkoutUrl,
        domain: checkoutDomain,
      });
    }

    const nextUrl = result.paymentUrl || result.checkoutUrl;
    if (nextUrl) {
      await extensionApi.tabs.create({ url: nextUrl, active: true });
      if (created) {
        await extensionApi.tabs.remove(tabId).catch(() => {});
      }
      return { ...result, openedPayment: true };
    }
  }

  if (result?.code === "payment_already_processing") {
    const existingCheckoutTab = await findExistingCheckoutTab(checkoutDomain);
    if (existingCheckoutTab?.id) {
      await extensionApi.tabs.update(existingCheckoutTab.id, { active: true });
      if (created) {
        await extensionApi.tabs.remove(tabId).catch(() => {});
      }
      return {
        ok: true,
        checkoutUrl: existingCheckoutTab.url,
        openedPayment: true,
        transactionId: result.transactionId,
      };
    }

    const storedCheckout = await findStoredCheckoutLink({
      itemId,
      sellerId,
      transactionId: result.transactionId,
      domain: checkoutDomain,
    });
    if (storedCheckout?.checkoutUrl) {
      await extensionApi.tabs.create({
        url: storedCheckout.checkoutUrl,
        active: true,
      });
      if (created) {
        await extensionApi.tabs.remove(tabId).catch(() => {});
      }
      return {
        ok: true,
        checkoutUrl: storedCheckout.checkoutUrl,
        openedPayment: true,
        transactionId: storedCheckout.transactionId,
        purchaseId: storedCheckout.purchaseId,
      };
    }
  }

  if (result?.code === "datadome_challenge") {
    if (result.captchaUrl) {
      await extensionApi.tabs.update(tabId, {
        active: true,
        url: result.captchaUrl,
      });
    } else {
      await extensionApi.tabs.update(tabId, {
        active: true,
      });
    }
  }

  return (
    result || {
      ok: false,
      code: "empty_buy_result",
      error: "Browser checkout did not return a result",
      requestId,
    }
  );
}

const syncTimers = new Map();

function scheduleSync(domain, options = {}) {
  const normalizedDomain = sanitizeDomain(domain);
  const storeId = typeof options.storeId === "string" ? options.storeId : "";
  if (!isVintedDomain(normalizedDomain)) {
    return;
  }

  const key = cookieSyncKey(normalizedDomain, storeId);
  const existingTimer = syncTimers.get(key);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const timer = setTimeout(async () => {
    syncTimers.delete(key);
    try {
      await syncAndPersistPreferredOrAllDomains(normalizedDomain);
    } catch (error) {
      console.warn("[vintrack-extension] sync failed", normalizedDomain, error);
    }
  }, 800);

  syncTimers.set(key, timer);
}

async function scheduleSyncForTab(tab) {
  const domain = domainFromUrl(tab?.url || "");
  if (!domain || !isVintedDomain(domain)) {
    return;
  }
  scheduleSync(domain, {
    storeId: typeof tab?.cookieStoreId === "string" ? tab.cookieStoreId : "",
  });
}

extensionApi.cookies.onChanged.addListener(({ cookie }) => {
  if (!cookie || cookie.name !== "access_token_web") {
    return;
  }
  scheduleSync(cookie.domain, {
    storeId: typeof cookie.storeId === "string" ? cookie.storeId : "",
  });
});

extensionApi.tabs.onActivated.addListener(({ tabId }) => {
  extensionApi.tabs
    .get(tabId)
    .then(scheduleSyncForTab)
    .catch(() => {});
});

extensionApi.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== "complete") {
    return;
  }
  void scheduleSyncForTab(tab || { id: tabId, url: changeInfo.url });
});

extensionApi.runtime.onStartup.addListener(() => {
  ensurePeriodicSyncAlarm();
  void syncAndPersistAllDomains();
});

extensionApi.runtime.onInstalled.addListener(() => {
  ensurePeriodicSyncAlarm();
  void syncAndPersistAllDomains();
});

extensionApi.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== PERIODIC_SYNC_ALARM) {
    return;
  }
  void syncAndPersistAllDomains();
});

extensionApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === "VINTRACK_EXTENSION_PING") {
      if (!isExtensionPageSender(sender) && !isAllowedAppSender(sender)) {
        sendResponse({ ok: false, error: "Unauthorized extension sender" });
        return;
      }
      const config = await getConfig();
      sendResponse({ ok: true, ...formatRuntimeState(config) });
      return;
    }

    if (message?.type === "VINTRACK_EXTENSION_CONNECT") {
      const token = String(message?.payload?.token || "").trim();
      const appOrigin = allowedAppOrigin(message?.payload?.appOrigin);
      const preferredDomain = String(
        message?.payload?.preferredDomain || "",
      ).trim();
      if (!token || !appOrigin || !isAllowedAppSender(sender, appOrigin)) {
        sendResponse({ ok: false, error: "Invalid Vintrack connection origin" });
        return;
      }

      await extensionApi.storage.local.set({
        [STORAGE_KEYS.token]: token,
        [STORAGE_KEYS.appOrigin]: appOrigin,
      });
      ensurePeriodicSyncAlarm();

      const results = await syncAndPersistPreferredOrAllDomains(
        preferredDomain,
        {
          preferOpenTab: true,
          allowAccountSwitch: true,
        },
      );
      const config = await getConfig();
      const successful = results.some(isCompletedSyncResult);
      const failedResult = results.find((result) => !result.ok);
      sendResponse({
        ok: true,
        syncOk: successful,
        ...formatRuntimeState(config),
        syncedDomains: results
          .filter(isCompletedSyncResult)
          .map((result) => result.domain),
        error: successful
          ? ""
          : syncResultError(failedResult) ||
            "Open a logged-in Vinted tab, then sync again.",
        results,
      });
      return;
    }

    if (message?.type === "VINTRACK_EXTENSION_MANUAL_SYNC") {
      const currentConfig = await getConfig();
      const configuredOrigin = allowedAppOrigin(
        currentConfig[STORAGE_KEYS.appOrigin],
      );
      if (
        !isExtensionPageSender(sender) &&
        !isAllowedAppSender(sender, configuredOrigin)
      ) {
        sendResponse({ ok: false, error: "Unauthorized extension sender" });
        return;
      }
      const preferredDomain = String(
        message?.payload?.preferredDomain || "",
      ).trim();
      const results = await syncAndPersistPreferredOrAllDomains(
        preferredDomain,
        {
          preferOpenTab: true,
          allowAccountSwitch: true,
        },
      );
      const config = await getConfig();
      const successful = results.some(isCompletedSyncResult);
      const failedResult = results.find((result) => !result.ok);
      sendResponse({
        ok: successful,
        ...formatRuntimeState(config),
        error: successful
          ? ""
          : syncResultError(failedResult) ||
            "Open a logged-in Vinted tab, then sync again.",
        results,
      });
      return;
    }

    if (message?.type === "VINTRACK_EXTENSION_CLEAR_LOCAL_STATE") {
      if (!isExtensionPageSender(sender)) {
        sendResponse({ ok: false, error: "Unauthorized extension sender" });
        return;
      }
      await clearLocalExtensionState();
      const config = await getConfig();
      sendResponse({ ok: true, ...formatRuntimeState(config) });
      return;
    }

    if (message?.type === "VINTRACK_EXTENSION_SET_THEME") {
      const theme = String(message?.payload?.theme || "").trim();
      if (theme !== "dark" && theme !== "light") {
        sendResponse({ ok: false, error: "Unsupported theme" });
        return;
      }

      const config = await getConfig();
      const configuredOrigin = allowedAppOrigin(
        config[STORAGE_KEYS.appOrigin],
      );
      if (
        !configuredOrigin ||
        !isAllowedAppSender(sender, configuredOrigin)
      ) {
        sendResponse({ ok: false, ignored: true });
        return;
      }

      await extensionApi.storage.local.set({ [STORAGE_KEYS.theme]: theme });
      sendResponse({ ok: true, theme });
      return;
    }

    if (message?.type === "VINTRACK_EXTENSION_BUY") {
      const config = await getConfig();
      const configuredOrigin = allowedAppOrigin(
        config[STORAGE_KEYS.appOrigin],
      );
      if (
        !configuredOrigin ||
        !isAllowedAppSender(sender, configuredOrigin)
      ) {
        sendResponse({ ok: false, error: "Unauthorized extension sender" });
        return;
      }
      const result = await handleBrowserBuy(message.payload);
      sendResponse(result);
      return;
    }

    sendResponse({ ok: false, error: "Unsupported message" });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  });

  return true;
});
