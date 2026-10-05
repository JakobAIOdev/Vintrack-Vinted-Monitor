const STORAGE_KEYS = {
  token: "browserLinkToken",
  appOrigin: "vintrackAppOrigin",
  lastSyncAt: "vintrackLastSyncAt",
  lastSyncAttemptAt: "vintrackLastSyncAttemptAt",
  lastSyncStatus: "vintrackLastSyncStatus",
  lastSyncError: "vintrackLastSyncError",
  lastSyncNeedsUserAction: "vintrackLastSyncNeedsUserAction",
  syncedDomains: "vintrackSyncedDomains",
  autoRecoveryNextAt: "vintrackAutoRecoveryNextAt", // Removed when clearing legacy state.
  browserRefreshState: "vintrackBrowserRefreshState",
  syncedSessions: "vintrackSyncedSessions",
  syncReceipts: "vintrackSyncReceipts",
  checkoutLinks: "vintrackCheckoutLinks",
  checkoutAttempts: "vintrackCheckoutAttempts",
  theme: "vintrackTheme",
  companionMode: "vintrackCompanionMode",
};
const PERIODIC_SYNC_ALARM = "vintrackPeriodicSync";
const PERIODIC_SYNC_MINUTES = 1;
const BUY_TAB_READY_TIMEOUT_MS = 20000;
const SYNC_REQUEST_TIMEOUT_MS = 15000;
const PROACTIVE_BROWSER_REFRESH_MS = 2 * 60 * 1000;
const SYNC_RECEIPT_TTL_MS = 10 * 60 * 1000;
const BROWSER_REFRESH_TIMEOUT_MS = 12000;
const BROWSER_REFRESH_RETRY_MS = 60 * 1000;
const BROWSER_REFRESH_MAX_RETRY_MS = 60 * 60 * 1000;
const BROWSER_REFRESH_ACTION_COOLDOWN_MS = 6 * 60 * 60 * 1000;
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
const isFirefoxExtension = Boolean(
  extensionApi.runtime.getManifest().browser_specific_settings?.gecko,
);
const inFlightSyncs = new Map();
const inFlightLifecycles = new Map();
let syncLifecycleTail = Promise.resolve();

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
  const matches = (
    extensionApi.runtime.getManifest().content_scripts || []
  ).flatMap((entry) => entry.matches || []);
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

function isSupportedVintedSender(sender) {
  const domain = domainFromUrl(sender?.url || sender?.tab?.url || "");
  return Boolean(domain && isVintedDomain(domain));
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
      (refreshDomain(domain) &&
        refreshDomain(domain) === refreshDomain(normalizedPreferredDomain)) ||
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
  const cookies = (
    await extensionApi.cookies.getAll({
      name: "access_token_web",
      ...(storeId ? { storeId } : {}),
    })
  ).filter((cookie) => {
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
    return (
      Number(right?.expirationDate || 0) - Number(left?.expirationDate || 0)
    );
  })[0];
}

function refreshDomain(domain) {
  const normalized = sanitizeDomain(domain);
  const supported = SUPPORTED_VINTED_DOMAINS.find(
    (value) => normalized === value || normalized === `www.${value}`,
  );
  return supported ? `www.${supported}` : "";
}

function browserRefreshError(status, retryAfter = "") {
  const requiresUserAction = status === 401 || status === 403;
  const retrySeconds = Number(retryAfter);
  const retryDate = Date.parse(retryAfter);
  const retryAfterMs = retryAfter
    ? Number.isFinite(retrySeconds)
      ? Math.max(0, retrySeconds * 1000)
      : Math.max(0, retryDate - Date.now()) || 0
    : 0;
  return {
    ok: false,
    statusCode: status,
    requiresUserAction,
    retryAfterMs,
    reason: requiresUserAction
      ? "browser-login-required"
      : "browser-refresh-failed",
    error: requiresUserAction
      ? "Open Vinted and check your login or security prompt, then sync again."
      : status === 429
        ? "Vinted is rate limiting session refresh. Vintrack will retry later."
        : "Vinted session refresh is temporarily unavailable. Vintrack will retry later.",
  };
}

async function refreshBrowserSessionInBackground(domain, storeId) {
  // fetch uses the extension's default cookie store. Container/private sessions
  // must stay in their existing tab; never copy their cookies into another store.
  const defaultStoreId = isFirefoxExtension ? "firefox-default" : "0";
  if (storeId && storeId !== defaultStoreId) {
    return {
      ok: false,
      reason: "browser-context-required",
      requiresUserAction: true,
      error:
        "Open Vinted in the linked browser container or private window, then sync again.",
    };
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    BROWSER_REFRESH_TIMEOUT_MS,
  );
  try {
    const origin = `https://${domain}`;
    const requestOptions = {
      credentials: "include",
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    };
    // Obtain CSRF context without opening a document or reading refresh cookies.
    const page = await fetch(`${origin}/`, requestOptions);
    if (!page.ok) {
      return browserRefreshError(page.status, page.headers.get("Retry-After"));
    }
    const html = await page.text();
    const csrfToken =
      html.match(
        /<meta\s+name=["']csrf-token["']\s+content=["']([^"']+)["']/i,
      )?.[1] ||
      html.match(
        /<meta\s+content=["']([^"']+)["']\s+name=["']csrf-token["']/i,
      )?.[1] ||
      html.match(/"csrfToken"\s*:\s*"([^"<>]+)"/)?.[1] ||
      html.match(/"csrf_token"\s*:\s*"([^"<>]+)"/)?.[1] ||
      // Next.js Flight embeds Vinted's current uppercase CSRF_TOKEN as escaped JSON.
      html.match(/CSRF_TOKEN\\?":\s*\\?"([^"\\]+)/)?.[1] ||
      "";
    if (!csrfToken) {
      return browserRefreshError(403);
    }
    const response = await fetch(`${origin}/web/api/auth/refresh`, {
      ...requestOptions,
      method: "POST",
      headers: {
        Accept: "application/json, text/plain, */*",
        "X-Csrf-Token": csrfToken,
      },
    });
    // Only status/cookie rotation is needed. Never expose auth response bodies.
    if (!response.ok) {
      return browserRefreshError(
        response.status,
        response.headers.get("Retry-After"),
      );
    }
    return { ok: true };
  } catch {
    return browserRefreshError(0);
  } finally {
    clearTimeout(timeout);
  }
}

async function refreshVintedBrowserSessions(targets, options = {}) {
  const config = await getConfig();
  if (!config[STORAGE_KEYS.token] || !config[STORAGE_KEYS.appOrigin]) {
    return [{ ok: false, reason: "not-configured" }];
  }
  const state = { ...(config[STORAGE_KEYS.browserRefreshState] || {}) };
  const results = [];
  const uniqueTargets = new Map();
  for (const target of targets) {
    const domain = refreshDomain(target.domain);
    const storeId =
      target.storeId || (isFirefoxExtension ? "firefox-default" : "0");
    if (domain)
      uniqueTargets.set(cookieSyncKey(domain, storeId), { domain, storeId });
  }
  for (const [key, target] of uniqueTargets) {
    const previous = state[key] || {};
    if (
      Number(previous.nextAttemptAt || 0) > Date.now() &&
      // A user click may retry authentication, but must respect a rate limit.
      (options.bypassAutoRecoveryCooldown !== true ||
        previous.statusCode === 429)
    ) {
      results.push({
        ...target,
        ok: false,
        reason: "browser-refresh-cooldown",
        requiresUserAction: previous.requiresUserAction === true,
        error: previous.error || "Vinted session refresh will retry later.",
      });
      continue;
    }
    // Persist a lease before network I/O so a restarted MV3 worker doesn't retry
    // an interrupted refresh immediately. The lifecycle queue prevents races.
    state[key] = {
      ...previous,
      nextAttemptAt: Date.now() + BROWSER_REFRESH_RETRY_MS,
    };
    await extensionApi.storage.local.set({
      [STORAGE_KEYS.browserRefreshState]: state,
    });
    const before = await extensionApi.cookies.get(
      cookieLookupDetails(target.domain, "access_token_web", target.storeId),
    );
    const tabs = (await getOpenVintedTabs(target.domain)).filter((tab) => {
      const tabStore =
        typeof tab.cookieStoreId === "string" ? tab.cookieStoreId : "";
      if (target.storeId && tabStore) return tabStore === target.storeId;
      if (
        target.storeId &&
        target.storeId !== "0" &&
        target.storeId !== "firefox-default"
      ) {
        return target.storeId === "1" && tab.incognito === true;
      }
      return !tab.incognito;
    });
    const selectedTab = mostRecentlyUsedTab(tabs);
    let result;
    if (
      selectedTab &&
      typeof selectedTab.id === "number" &&
      !selectedTab.discarded
    ) {
      try {
        await waitForTabBridge(selectedTab.id, 1500);
        const response = await extensionApi.tabs.sendMessage(selectedTab.id, {
          type: "VINTRACK_REFRESH_BROWSER_SESSION",
          payload: { requestId: crypto.randomUUID() },
        });
        result = response?.ok
          ? { ok: true }
          : browserRefreshError(
              Number(response?.status || 0),
              response?.retryAfter || "",
            );
      } catch {
        // A missing bridge is safe to handle in the default background context.
        result = await refreshBrowserSessionInBackground(
          target.domain,
          target.storeId,
        );
      }
    } else {
      result = await refreshBrowserSessionInBackground(
        target.domain,
        target.storeId,
      );
    }
    if (result.ok) {
      const after = await extensionApi.cookies.get(
        cookieLookupDetails(target.domain, "access_token_web", target.storeId),
      );
      if (
        !after?.value ||
        after.value === before?.value ||
        accessTokenExpiresSoon(after.value)
      ) {
        result = {
          ...browserRefreshError(0),
          reason: "browser-token-not-rotated",
          error:
            "Vinted did not provide a fresh session token. Vintrack will retry later.",
        };
      }
    }
    if (result.ok) {
      delete state[key];
    } else {
      const failures = Math.min(Number(previous.failures || 0) + 1, 7);
      const delay = result.requiresUserAction
        ? BROWSER_REFRESH_ACTION_COOLDOWN_MS
        : Math.min(
            BROWSER_REFRESH_RETRY_MS * 2 ** (failures - 1),
            BROWSER_REFRESH_MAX_RETRY_MS,
          );
      state[key] = {
        failures,
        nextAttemptAt: Date.now() + Math.max(delay, result.retryAfterMs || 0),
        statusCode: result.statusCode || 0,
        requiresUserAction: result.requiresUserAction === true,
        error: result.error,
      };
    }
    await extensionApi.storage.local.set({
      [STORAGE_KEYS.browserRefreshState]: state,
    });
    results.push({ ...target, ...result });
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
    STORAGE_KEYS.syncedSessions,
  ]);
  const previousDomains = Array.isArray(previous[STORAGE_KEYS.syncedDomains])
    ? previous[STORAGE_KEYS.syncedDomains]
    : [];
  const hasSuccessfulSync = successfulDomains.length > 0;

  await extensionApi.storage.local.set({
    [STORAGE_KEYS.lastSyncAt]: results.some(
      (result) => isCompletedSyncResult(result) && !result.cached,
    )
      ? now
      : previous[STORAGE_KEYS.lastSyncAt] || "",
    [STORAGE_KEYS.lastSyncAttemptAt]: now,
    [STORAGE_KEYS.lastSyncStatus]: hasSuccessfulSync
      ? "ok"
      : failedResult
        ? "error"
        : "idle",
    [STORAGE_KEYS.lastSyncError]: hasSuccessfulSync
      ? ""
      : syncResultError(failedResult),
    [STORAGE_KEYS.lastSyncNeedsUserAction]:
      !hasSuccessfulSync && failedResult?.requiresUserAction === true,
    [STORAGE_KEYS.syncedDomains]: hasSuccessfulSync
      ? successfulDomains
      : previousDomains,
    [STORAGE_KEYS.syncedSessions]: hasSuccessfulSync
      ? results.filter(isCompletedSyncResult).map(({ domain, storeId }) => ({
          domain,
          storeId: storeId || (isFirefoxExtension ? "firefox-default" : "0"),
        }))
      : previous[STORAGE_KEYS.syncedSessions] || [],
  });
}

function formatRuntimeState(storage) {
  const theme =
    storage.vintrackTheme === "dark" || storage.vintrackTheme === "light"
      ? storage.vintrackTheme
      : "system";

  return {
    installed: true,
    checkoutPrepareVersion: 2,
    version: extensionApi.runtime.getManifest().version || "",
    configured: Boolean(storage.browserLinkToken && storage.vintrackAppOrigin),
    companionMode:
      storage.vintrackCompanionMode === "popup" ? "popup" : "inline",
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
    lastSyncNeedsUserAction: storage.vintrackLastSyncNeedsUserAction === true,
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

  const config = await getConfig();
  const { browserLinkToken, vintrackAppOrigin } = config;
  if (!browserLinkToken || !vintrackAppOrigin) {
    return { ok: false, reason: "not-configured" };
  }

  const accessCookie = selectedAccessToken
    ? { value: selectedAccessToken }
    : await extensionApi.cookies.get(
        cookieLookupDetails(normalizedDomain, "access_token_web", storeId),
      );

  if (!accessCookie?.value) {
    return {
      ok: false,
      domain: normalizedDomain,
      storeId,
      reason: "missing-browser-token",
    };
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

  const receiptKey = cookieSyncKey(
    refreshDomain(normalizedDomain) || normalizedDomain,
    storeId || (isFirefoxExtension ? "firefox-default" : "0"),
  );
  const fingerprint = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`${browserLinkToken}|${accessCookie.value}`),
      ),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const receipt = config[STORAGE_KEYS.syncReceipts]?.[receiptKey];
  if (
    !allowAccountSwitch &&
    receipt?.fingerprint === fingerprint &&
    Date.now() - Number(receipt.syncedAt || 0) < SYNC_RECEIPT_TTL_MS
  ) {
    return {
      ok: true,
      domain: normalizedDomain,
      storeId,
      status: "completed",
      cached: true,
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
      // A Vintrack outage/link failure cannot be repaired by refreshing Vinted.
      retryable:
        response?.status === 401 &&
        String(data.error || "").startsWith("invalid browser token sync:"),
      error: syncStatusError(
        data,
        `Sync failed (${response?.status || "network error"})`,
      ),
    };
  }

  const status = typeof data.status === "string" ? data.status : "completed";
  const completed = COMPLETED_SYNC_STATUSES.has(status);
  if (completed) {
    const latest = await extensionApi.storage.local.get([
      STORAGE_KEYS.syncReceipts,
      STORAGE_KEYS.browserRefreshState,
    ]);
    const refreshState = {
      ...(latest[STORAGE_KEYS.browserRefreshState] || {}),
    };
    // A fresh accepted token proves that a prior authentication failure recovered.
    if (refreshState[receiptKey]?.statusCode !== 429)
      delete refreshState[receiptKey];
    await extensionApi.storage.local.set({
      [STORAGE_KEYS.browserRefreshState]: refreshState,
      [STORAGE_KEYS.syncReceipts]: {
        ...(allowAccountSwitch ? {} : latest[STORAGE_KEYS.syncReceipts] || {}),
        [receiptKey]: { fingerprint, syncedAt: Date.now() },
      },
    });
  }
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
  const config = await getConfig();
  const savedSessions = Array.isArray(config[STORAGE_KEYS.syncedSessions])
    ? config[STORAGE_KEYS.syncedSessions]
    : [];
  const candidates = new Map();
  if (savedSessions.length > 0) {
    // Refresh only linked browser contexts, even after their access cookie expires.
    for (const session of savedSessions) {
      if (refreshDomain(session.domain)) {
        candidates.set(cookieSyncKey(session.domain, session.storeId), session);
      }
    }
  } else {
    const accessCookies = await extensionApi.cookies.getAll({
      name: "access_token_web",
    });
    for (const cookie of accessCookies) {
      const domain = sanitizeDomain(cookie.domain);
      if (!isVintedDomain(domain)) continue;
      const storeId = typeof cookie.storeId === "string" ? cookie.storeId : "";
      candidates.set(cookieSyncKey(domain, storeId), { domain, storeId });
    }
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
        error: `No session token matched ${browserAccount.accountName ? `@${browserAccount.accountName}` : "the account"} open in the selected Vinted tab. Reload that tab and try again.`,
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
      await extensionApi.cookies.getAll({
        name: "access_token_web",
        ...(options.storeId ? { storeId: options.storeId } : {}),
      })
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
    const targets =
      typeof options.storeId === "string" && options.storeId
        ? [options.storeId]
        : storeIds.length > 0
          ? storeIds
          : [""];
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

    return results;
  }

  return syncAllVintedDomains();
}

function needsBrowserRefresh(result) {
  return (
    result.reason === "browser-token-needs-refresh" ||
    result.reason === "missing-browser-token" ||
    result.reason === "no-open-vinted-tab" ||
    result.reason === "ignored_invalid_browser_session" ||
    (result.reason === "server-sync-failed" && result.retryable)
  );
}

async function performSyncLifecycle(preferredDomain, options) {
  const config = await getConfig();
  if (!config[STORAGE_KEYS.token] || !config[STORAGE_KEYS.appOrigin]) return [];
  const savedSessions = Array.isArray(config[STORAGE_KEYS.syncedSessions])
    ? config[STORAGE_KEYS.syncedSessions]
    : [];
  if (
    !options.allowAccountSwitch &&
    preferredDomain &&
    savedSessions.length > 0 &&
    !savedSessions.some(
      (session) =>
        refreshDomain(session.domain) === refreshDomain(preferredDomain) &&
        (!options.storeId || session.storeId === options.storeId),
    )
  )
    return [];
  let results = await syncPreferredOrAllDomains(preferredDomain, options);
  if (
    !results.some(isCompletedSyncResult) &&
    (results.length === 0 || results.some(needsBrowserRefresh))
  ) {
    let targets = results
      .filter(needsBrowserRefresh)
      .filter((result) => result.domain);
    targets = targets.flatMap((target) => {
      if (target.storeId) return [target];
      const saved = savedSessions.filter(
        (session) =>
          refreshDomain(session.domain) === refreshDomain(target.domain),
      );
      return saved.length > 0 ? saved : [target];
    });
    if (targets.length === 0) {
      const sessions = Array.isArray(config[STORAGE_KEYS.syncedSessions])
        ? config[STORAGE_KEYS.syncedSessions]
        : [];
      targets =
        sessions.length > 0
          ? sessions
          : (config[STORAGE_KEYS.syncedDomains] || []).map((domain) => ({
              domain,
              storeId: "",
            }));
      if (preferredDomain) {
        const matching = targets.filter(
          (target) =>
            refreshDomain(target.domain) === refreshDomain(preferredDomain),
        );
        targets =
          matching.length > 0
            ? matching
            : [{ domain: preferredDomain, storeId: "" }];
      }
    }
    const refreshResults = await refreshVintedBrowserSessions(targets, options);
    if (refreshResults.some((result) => result.ok)) {
      results = await syncPreferredOrAllDomains(preferredDomain, options);
    } else if (refreshResults.length > 0) {
      results = refreshResults;
    }
  }
  await persistSyncState(results);
  return results;
}

async function syncAndPersistPreferredOrAllDomains(
  preferredDomain,
  options = {},
) {
  const domain = sanitizeDomain(preferredDomain);
  const key = `${domain}|${options.storeId || ""}|${options.preferOpenTab === true}|${options.allowAccountSwitch === true}`;
  if (inFlightLifecycles.has(key)) return inFlightLifecycles.get(key);
  // Cookie rotation, tab events, alarms and manual actions share one queue.
  const sync = syncLifecycleTail
    .catch(() => {})
    .then(() => performSyncLifecycle(domain, options));
  syncLifecycleTail = sync;
  inFlightLifecycles.set(key, sync);
  try {
    return await sync;
  } finally {
    if (inFlightLifecycles.get(key) === sync) inFlightLifecycles.delete(key);
  }
}

async function syncAndPersistAllDomains() {
  return syncAndPersistPreferredOrAllDomains("");
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

const checkoutInFlight = new Map();
const CHECKOUT_ATTEMPT_TTL_MS = 10 * 60 * 1000;
let checkoutStorageQueue = Promise.resolve();

function withCheckoutAttempts(action) {
  const task = checkoutStorageQueue.then(async () => {
    const storage = await extensionApi.storage.local.get(
      STORAGE_KEYS.checkoutAttempts,
    );
    const attempts = (
      Array.isArray(storage[STORAGE_KEYS.checkoutAttempts])
        ? storage[STORAGE_KEYS.checkoutAttempts]
        : []
    ).filter(
      (entry) =>
        Number.isFinite(entry.startedAt) &&
        Date.now() - entry.startedAt < CHECKOUT_ATTEMPT_TTL_MS,
    );
    return action(attempts);
  });
  checkoutStorageQueue = task.catch(() => {});
  return task;
}

function validCheckoutUrl(raw, domain) {
  try {
    const url = new URL(raw);
    return (
      url.protocol === "https:" &&
      url.host === domain &&
      !url.username &&
      !url.password &&
      url.pathname === "/checkout" &&
      !url.hash
    );
  } catch {
    return false;
  }
}

async function handleBrowserBuy(payload) {
  const itemId = Number(payload?.itemId || 0);
  const sellerId = Number(payload?.sellerId || 0);
  const expectedAccountId = Number(payload?.expectedAccountId || 0);
  const requestId = String(payload?.requestId || crypto.randomUUID());
  const domain = sanitizeDomain(String(payload?.domain || ""));
  const preferences = payload?.preferences || { shipping: "vinted", payment: "vinted" };
  if (
    ![itemId, sellerId, expectedAccountId].every(
      (id) => Number.isSafeInteger(id) && id > 0,
    ) ||
    !isVintedDomain(domain) ||
    sellerId === expectedAccountId ||
    !preferences || typeof preferences !== "object" ||
    Object.keys(preferences).some((key) => !["shipping", "payment"].includes(key)) ||
    !["home", "vinted"].includes(preferences.shipping) ||
    !["wallet", "paypal", "vinted"].includes(preferences.payment)
  ) {
    return {
      ok: false,
      code: "invalid_buy_payload",
      error: "Invalid checkout target or linked account",
      requestId,
    };
  }
  const key = `${domain}:${expectedAccountId}:${itemId}`;
  let task = checkoutInFlight.get(key);
  if (!task) {
    task = prepareBrowserCheckout({
      itemId,
      sellerId,
      expectedAccountId,
      domain,
      preferences,
    });
    checkoutInFlight.set(key, task);
  }
  try {
    return { ...(await task), requestId };
  } catch {
    return {
      ok: false,
      code: "checkout_failed",
      error:
        "Checkout could not be completed. Check the Vinted tab before starting it again.",
      requestId,
    };
  } finally {
    if (checkoutInFlight.get(key) === task) checkoutInFlight.delete(key);
  }
}

async function prepareBrowserCheckout(target) {
  const { itemId, sellerId, expectedAccountId, domain } = target;
  const targetUrl = `https://${domain}/items/${itemId}`;
  const { tabId } = await ensureVintedBuyTab(targetUrl);
  const account = await extensionApi.tabs.sendMessage(tabId, {
    type: "VINTRACK_GET_BROWSER_ACCOUNT",
  });
  if (!account?.ok || account.accountId !== expectedAccountId) {
    await extensionApi.tabs.update(tabId, { active: true });
    return {
      ok: false,
      code: "checkout_account_mismatch",
      error: "Sign in to Vinted with the account linked to Vintrack.",
    };
  }
  const attempt = {
    ...target,
    accountId: expectedAccountId,
    startedAt: Date.now(),
  };
  const previous = await withCheckoutAttempts(async (attempts) => {
    const found = attempts.find(
      (entry) =>
        entry.itemId === itemId &&
        entry.accountId === expectedAccountId &&
        entry.domain === domain,
    );
    if (found) return found;
    // Save intent before any POST. Serialize storage updates across items.
    await extensionApi.storage.local.set({
      [STORAGE_KEYS.checkoutAttempts]: [attempt, ...attempts].slice(0, 100),
    });
    return null;
  });
  if (previous) {
    if (
      previous.sellerId !== sellerId ||
      !validCheckoutUrl(previous.checkoutUrl, domain)
    ) {
      return {
        ok: false,
        code: "checkout_uncertain",
        error:
          "Checkout was already attempted. Continue in Vinted before starting it again.",
      };
    }
    await extensionApi.tabs.update(tabId, {
      url: previous.checkoutUrl,
      active: true,
    });
    return {
      ok: true,
      status: previous.preferences?.shipping === target.preferences.shipping && previous.preferences?.payment === target.preferences.payment
        ? previous.status || "checkout_review_required"
        : "checkout_review_required",
      checkoutUrl: previous.checkoutUrl,
      transactionId: previous.transactionId,
      purchaseId: previous.purchaseId,
    };
  }
  const result = await extensionApi.tabs.sendMessage(tabId, {
    type: "VINTRACK_RUN_BROWSER_BUY",
    payload: target,
  });
  if (!result?.ok) {
    await extensionApi.tabs.update(tabId, { active: true });
    return {
      ok: false,
      code: result?.code || "checkout_failed",
      error:
        result?.code === "datadome_challenge"
          ? "Complete Vinted's security check in the browser tab."
          : "Vinted could not prepare checkout. Continue in the Vinted tab.",
    };
  }
  if (!validCheckoutUrl(result.checkoutUrl, domain))
    return {
      ok: false,
      code: "invalid_checkout_url",
      error: "Vinted did not return a valid checkout link.",
    };
  await withCheckoutAttempts(async (attempts) => {
    const completed = {
      ...attempt,
      checkoutUrl: result.checkoutUrl,
      transactionId: result.transactionId,
      purchaseId: result.purchaseId,
      status: result.status,
    };
    await extensionApi.storage.local.set({
      [STORAGE_KEYS.checkoutAttempts]: [
        completed,
        ...attempts.filter(
          (entry) =>
            !(
              entry.itemId === itemId &&
              entry.accountId === expectedAccountId &&
              entry.domain === domain
            ),
        ),
      ].slice(0, 100),
    });
  });
  await storeCheckoutLink({
    ...target,
    checkoutUrl: result.checkoutUrl,
    transactionId: result.transactionId,
    purchaseId: result.purchaseId,
    status: result.status,
  });
  await extensionApi.tabs.update(tabId, {
    url: result.checkoutUrl,
    active: true,
  });
  return {
    ok: true,
    status: result.status || "checkout_review_required",
    checkoutUrl: result.checkoutUrl,
    transactionId: result.transactionId,
    purchaseId: result.purchaseId,
  };
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
      await syncAndPersistPreferredOrAllDomains(normalizedDomain, { storeId });
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

async function companionActiveUrl(sender) {
  if (isSupportedVintedSender(sender)) {
    return String(sender?.tab?.url || sender?.url || "");
  }
  const tabs = await extensionApi.tabs.query({
    active: true,
    currentWindow: true,
  });
  return String(tabs[0]?.url || "");
}

function companionErrorMessage(status, data) {
  if (status === 401) {
    return "Reconnect this browser from Vintrack Account.";
  }
  if (typeof data?.error === "string" && data.error.trim()) {
    return data.error.trim();
  }
  return `Vintrack request failed (${status || "network"})`;
}

async function companionApiRequest(path, options = {}) {
  const config = await getConfig();
  const appOrigin = allowedAppOrigin(config[STORAGE_KEYS.appOrigin]);
  const token = String(config[STORAGE_KEYS.token] || "").trim();
  if (!appOrigin || !token) {
    return {
      ok: false,
      status: 401,
      error: "Connect this browser once from Vintrack Account.",
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`${appOrigin}${path}`, {
      method: options.method || "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: "no-store",
      signal: controller.signal,
    });
    const contentType = response.headers.get("content-type") || "";
    const data = contentType.includes("application/json")
      ? await response.json().catch(() => ({}))
      : {};
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: companionErrorMessage(response.status, data),
      };
    }
    return { ok: true, status: response.status, data };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error:
        error?.name === "AbortError"
          ? "Vintrack companion request timed out."
          : "Vintrack companion is temporarily unreachable.",
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function inspectCompanionContext(activeUrl) {
  if (!isVintedDomain(domainFromUrl(activeUrl))) {
    return { ok: true, data: { kind: "unsupported" } };
  }
  return companionApiRequest("/api/extension/context/inspect", {
    method: "POST",
    body: { url: activeUrl },
  });
}

async function companionState(sender) {
  const [config, activeUrl] = await Promise.all([
    getConfig(),
    companionActiveUrl(sender),
  ]);
  const runtimeState = formatRuntimeState(config);
  if (!runtimeState.configured) {
    return {
      ok: true,
      ...runtimeState,
      activeUrl,
      appOrigin: allowedAppOrigin(config[STORAGE_KEYS.appOrigin]),
      overview: null,
      context: { kind: "unsupported" },
    };
  }

  const [overview, context] = await Promise.all([
    companionApiRequest("/api/extension/overview"),
    inspectCompanionContext(activeUrl),
  ]);
  return {
    ok: overview.ok,
    ...runtimeState,
    activeUrl,
    appOrigin: allowedAppOrigin(config[STORAGE_KEYS.appOrigin]),
    overview: overview.ok ? overview.data : null,
    context: context.ok ? context.data : { kind: "unsupported" },
    error: overview.ok ? "" : overview.error,
    contextError: context.ok ? "" : context.error,
  };
}

const COMPANION_DESTINATIONS = {
  dashboard: "/dashboard",
  monitors: "/monitors",
  newMonitor: "/monitors/new",
  notifications: "/dashboard?notifications=1",
  feed: "/feed",
  priceWatches: "/price-watches",
  account: "/account",
  chats: "/chats",
  favorites: "/liked",
};

async function openVintrackPath(path) {
  const config = await getConfig();
  const appOrigin = allowedAppOrigin(config[STORAGE_KEYS.appOrigin]);
  if (!appOrigin) {
    return { ok: false, error: "Vintrack is not connected." };
  }
  await extensionApi.tabs.create({ url: `${appOrigin}${path}` });
  return { ok: true };
}

async function openCompanionDestination(destination, id) {
  if (destination === "monitor" && /^\d+$/.test(String(id || ""))) {
    return openVintrackPath(`/monitors/${id}`);
  }
  if (destination === "priceWatch" && /^\d+$/.test(String(id || ""))) {
    return openVintrackPath(`/price-watches?watch=${id}`);
  }
  const path = COMPANION_DESTINATIONS[destination];
  return path
    ? openVintrackPath(path)
    : { ok: false, error: "Unsupported Vintrack destination." };
}

async function openCompanionHandoff(sender, kind) {
  const activeUrl = await companionActiveUrl(sender);
  const context = await inspectCompanionContext(activeUrl);
  if (!context.ok) return context;
  if (kind === "monitor" && context.data?.kind === "catalog") {
    return openVintrackPath(
      `/monitors/new#vintrack-vinted-search=${encodeURIComponent(
        context.data.handoffUrl,
      )}`,
    );
  }
  if (kind === "priceWatch" && context.data?.kind === "item") {
    return openVintrackPath(
      `/price-watches#vintrack-vinted-item=${encodeURIComponent(
        context.data.handoffUrl,
      )}`,
    );
  }
  return { ok: false, error: "This Vinted page cannot be imported." };
}

async function notifyCompanionMode(mode) {
  const tabs = await extensionApi.tabs.query({});
  await Promise.all(
    tabs
      .filter((tab) => isVintedDomain(domainFromUrl(tab.url || "")))
      .map((tab) =>
        extensionApi.tabs
          .sendMessage(tab.id, {
            type: "VINTRACK_COMPANION_MODE_CHANGED",
            payload: { mode },
          })
          .catch(() => {}),
      ),
  );
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
    const companionSender =
      isExtensionPageSender(sender) || isSupportedVintedSender(sender);

    if (message?.type === "VINTRACK_COMPANION_MODE") {
      if (!companionSender) {
        sendResponse({ ok: false, error: "Unauthorized extension sender" });
        return;
      }
      const config = await getConfig();
      sendResponse({
        ok: true,
        companionMode:
          config[STORAGE_KEYS.companionMode] === "popup" ? "popup" : "inline",
      });
      return;
    }

    if (message?.type === "VINTRACK_COMPANION_STATE") {
      if (!companionSender) {
        sendResponse({ ok: false, error: "Unauthorized extension sender" });
        return;
      }
      sendResponse(await companionState(sender));
      return;
    }

    if (message?.type === "VINTRACK_COMPANION_FEED") {
      if (!companionSender) {
        sendResponse({ ok: false, error: "Unauthorized extension sender" });
        return;
      }
      const result = await companionApiRequest("/api/extension/feed");
      sendResponse(result.ok ? { ok: true, ...result.data } : result);
      return;
    }

    if (message?.type === "VINTRACK_COMPANION_PRICE_WATCHES") {
      if (!companionSender) {
        sendResponse({ ok: false, error: "Unauthorized extension sender" });
        return;
      }
      const cursor = String(message?.payload?.cursor || "").trim();
      const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
      const result = await companionApiRequest(
        `/api/extension/price-watches?limit=10${suffix}`,
      );
      sendResponse(result.ok ? { ok: true, ...result.data } : result);
      return;
    }

    if (message?.type === "VINTRACK_COMPANION_WATCH_MUTATION") {
      if (!companionSender) {
        sendResponse({ ok: false, error: "Unauthorized extension sender" });
        return;
      }
      const id = String(message?.payload?.id || "");
      const operation = message?.payload?.operation;
      if (!/^\d+$/.test(id)) {
        sendResponse({ ok: false, error: "Invalid Price Watch." });
        return;
      }
      if (operation === "delete") {
        const result = await companionApiRequest(
          `/api/extension/price-watches/${id}`,
          { method: "DELETE" },
        );
        sendResponse(result.ok ? { ok: true } : result);
        return;
      }
      if (operation === "active" || operation === "paused") {
        const result = await companionApiRequest(
          `/api/extension/price-watches/${id}`,
          { method: "PATCH", body: { status: operation } },
        );
        sendResponse(result.ok ? { ok: true, ...result.data } : result);
        return;
      }
      sendResponse({ ok: false, error: "Unsupported Price Watch action." });
      return;
    }

    if (message?.type === "VINTRACK_COMPANION_OPEN") {
      if (!companionSender) {
        sendResponse({ ok: false, error: "Unauthorized extension sender" });
        return;
      }
      sendResponse(
        await openCompanionDestination(
          message?.payload?.destination,
          message?.payload?.id,
        ),
      );
      return;
    }

    if (message?.type === "VINTRACK_COMPANION_HANDOFF") {
      if (!companionSender) {
        sendResponse({ ok: false, error: "Unauthorized extension sender" });
        return;
      }
      sendResponse(await openCompanionHandoff(sender, message?.payload?.kind));
      return;
    }

    if (message?.type === "VINTRACK_COMPANION_SET_MODE") {
      if (!companionSender) {
        sendResponse({ ok: false, error: "Unauthorized extension sender" });
        return;
      }
      const mode = message?.payload?.mode === "popup" ? "popup" : "inline";
      await extensionApi.storage.local.set({
        [STORAGE_KEYS.companionMode]: mode,
      });
      await notifyCompanionMode(mode);
      sendResponse({ ok: true, companionMode: mode });
      return;
    }

    if (message?.type === "VINTRACK_COMPANION_MANUAL_SYNC") {
      if (!companionSender) {
        sendResponse({ ok: false, error: "Unauthorized extension sender" });
        return;
      }
      const results = await syncAndPersistPreferredOrAllDomains("", {
        bypassAutoRecoveryCooldown: true,
        preferOpenTab: true,
        allowAccountSwitch: true,
      });
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
      });
      return;
    }

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
        sendResponse({
          ok: false,
          error: "Invalid Vintrack connection origin",
        });
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
          bypassAutoRecoveryCooldown: true,
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
          bypassAutoRecoveryCooldown: true,
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
      const configuredOrigin = allowedAppOrigin(config[STORAGE_KEYS.appOrigin]);
      if (!configuredOrigin || !isAllowedAppSender(sender, configuredOrigin)) {
        sendResponse({ ok: false, ignored: true });
        return;
      }

      await extensionApi.storage.local.set({ [STORAGE_KEYS.theme]: theme });
      sendResponse({ ok: true, theme });
      return;
    }

    if (message?.type === "VINTRACK_EXTENSION_BUY") {
      const config = await getConfig();
      const configuredOrigin = allowedAppOrigin(config[STORAGE_KEYS.appOrigin]);
      if (!configuredOrigin || !isAllowedAppSender(sender, configuredOrigin)) {
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
