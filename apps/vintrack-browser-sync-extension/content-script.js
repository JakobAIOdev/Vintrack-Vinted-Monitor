(function () {
  const extensionApi = globalThis.browser || globalThis.chrome;
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

  function getRuntime() {
    const runtime = extensionApi?.runtime;
    return runtime?.sendMessage ? runtime : null;
  }

  function sendRuntimeMessage(message, callback) {
    const runtime = getRuntime();
    if (!runtime) {
      callback?.(undefined, {
        message: "Extension context unavailable. Reload this page.",
      });
      return false;
    }

    try {
      Promise.resolve(runtime.sendMessage(message))
        .then((response) => callback?.(response, undefined))
        .catch((error) =>
          callback?.(undefined, {
            message:
              error instanceof Error
                ? error.message
                : "Extension context unavailable. Reload this page.",
          }),
        );
      return true;
    } catch (error) {
      callback?.(undefined, {
        message:
          error instanceof Error
            ? error.message
            : "Extension context unavailable. Reload this page.",
      });
      return false;
    }
  }

  function sendResponseSafely(sendResponse, payload) {
    try {
      sendResponse(payload);
    } catch {
      // Chrome invalidates pending response channels when an extension reloads.
    }
  }

  function isVintedHost(hostname) {
    const normalized = String(hostname || "").trim().toLowerCase();
    return SUPPORTED_VINTED_DOMAINS.some(
      (supported) =>
        normalized === supported || normalized.endsWith(`.${supported}`),
    );
  }

  function isVintrackAppOrigin(origin) {
    return VINTRACK_APP_ORIGINS.has(String(origin || ""));
  }

  function post(type, payload) {
    window.postMessage({ type, payload }, window.location.origin);
  }

  function ensurePageBridge() {
    if (!isVintedHost(window.location.hostname)) {
      return;
    }

    if (document.documentElement.dataset.vintrackPageBridge === "ready") {
      return;
    }

    const runtime = getRuntime();
    if (!runtime?.getURL) {
      return;
    }

    const script = document.createElement("script");
    try {
      script.src = runtime.getURL("page-bridge.js");
    } catch {
      return;
    }
    script.async = false;
    script.dataset.vintrackPageBridge = "true";
    script.onload = () => {
      document.documentElement.dataset.vintrackPageBridge = "ready";
      script.remove();
    };

    (document.head || document.documentElement).appendChild(script);
  }

  function resolveVintrackTheme() {
    const classes = document.documentElement.classList;
    if (classes.contains("dark")) {
      return "dark";
    }
    if (classes.contains("light")) {
      return "light";
    }
    const darkPreference = window.matchMedia?.("(prefers-color-scheme: dark)");
    return darkPreference?.matches ? "dark" : "light";
  }

  function syncVintrackTheme() {
    if (!isVintrackAppOrigin(window.location.origin)) {
      return;
    }

    sendRuntimeMessage(
      {
        type: "VINTRACK_EXTENSION_SET_THEME",
        payload: {
          theme: resolveVintrackTheme(),
        },
      },
      () => {
        // The background script ignores non-Vintrack origins.
      },
    );
  }

  function watchVintrackTheme() {
    if (!isVintrackAppOrigin(window.location.origin)) {
      return;
    }

    if (document.documentElement.dataset.vintrackThemeBridge === "ready") {
      return;
    }
    document.documentElement.dataset.vintrackThemeBridge = "ready";

    const syncSoon = () => window.setTimeout(syncVintrackTheme, 0);
    syncSoon();

    document.addEventListener("DOMContentLoaded", syncSoon, { once: true });
    new MutationObserver(syncSoon).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    const darkPreference = window.matchMedia?.("(prefers-color-scheme: dark)");
    darkPreference?.addEventListener?.("change", syncSoon);
  }

  function waitForPageBridgeReady(timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (document.documentElement.dataset.vintrackPageBridge === "ready") {
        resolve();
        return;
      }

      const timeout = window.setTimeout(() => {
        window.removeEventListener("message", handleReady);
        reject(new Error("Vinted page bridge did not become ready"));
      }, timeoutMs);

      function handleReady(event) {
        if (
          event.source !== window ||
          event.data?.type !== "VINTRACK_PAGE_BRIDGE_READY"
        ) {
          return;
        }

        window.clearTimeout(timeout);
        window.removeEventListener("message", handleReady);
        document.documentElement.dataset.vintrackPageBridge = "ready";
        resolve();
      }

      window.addEventListener("message", handleReady);
    });
  }

  function requestPageBuy(payload) {
    return new Promise((resolve) => {
      const requestId = payload?.requestId || crypto.randomUUID();
      const timeout = window.setTimeout(() => {
        window.removeEventListener("message", handleResponse);
        resolve({
          ok: false,
          code: "page_bridge_timeout",
          error: "Vinted page bridge did not answer in time",
          requestId,
        });
      }, 30000);

      function handleResponse(event) {
        if (
          event.source !== window ||
          event.data?.type !== "VINTRACK_PAGE_BUY_RESPONSE" ||
          event.data.payload?.requestId !== requestId
        ) {
          return;
        }

        window.clearTimeout(timeout);
        window.removeEventListener("message", handleResponse);
        resolve(event.data.payload);
      }

      window.addEventListener("message", handleResponse);
      window.postMessage(
        {
          type: "VINTRACK_PAGE_BUY_REQUEST",
          payload: { ...payload, requestId },
        },
        window.location.origin,
      );
    });
  }

  function requestPageSessionRefresh(payload = {}) {
    return new Promise((resolve) => {
      const requestId = payload?.requestId || crypto.randomUUID();
      const timeout = window.setTimeout(() => {
        window.removeEventListener("message", handleResponse);
        resolve({
          ok: false,
          code: "page_bridge_timeout",
          error: "Vinted page bridge did not answer in time",
          requestId,
        });
      }, 30000);

      function handleResponse(event) {
        if (
          event.source !== window ||
          event.data?.type !== "VINTRACK_PAGE_SESSION_REFRESH_RESPONSE" ||
          event.data.payload?.requestId !== requestId
        ) {
          return;
        }

        window.clearTimeout(timeout);
        window.removeEventListener("message", handleResponse);
        resolve(event.data.payload);
      }

      window.addEventListener("message", handleResponse);
      window.postMessage(
        {
          type: "VINTRACK_PAGE_SESSION_REFRESH_REQUEST",
          payload: { ...payload, requestId },
        },
        window.location.origin,
      );
    });
  }

  function requestPageAccount(payload = {}) {
    return new Promise((resolve) => {
      const requestId = payload?.requestId || crypto.randomUUID();
      const timeout = window.setTimeout(() => {
        window.removeEventListener("message", handleResponse);
        resolve({
          ok: false,
          code: "page_bridge_timeout",
          error: "Vinted page bridge did not identify the open account in time",
          requestId,
        });
      }, 15000);

      function handleResponse(event) {
        if (
          event.source !== window ||
          event.data?.type !== "VINTRACK_PAGE_ACCOUNT_RESPONSE" ||
          event.data.payload?.requestId !== requestId
        ) {
          return;
        }

        window.clearTimeout(timeout);
        window.removeEventListener("message", handleResponse);
        resolve(event.data.payload);
      }

      window.addEventListener("message", handleResponse);
      window.postMessage(
        {
          type: "VINTRACK_PAGE_ACCOUNT_REQUEST",
          payload: { ...payload, requestId },
        },
        window.location.origin,
      );
    });
  }

  ensurePageBridge();
  watchVintrackTheme();

  if (isVintrackAppOrigin(window.location.origin)) {
    sendRuntimeMessage(
      { type: "VINTRACK_EXTENSION_PING" },
      (response, runtimeError) => {
        if (runtimeError) {
          return;
        }
        post("VINTRACK_EXTENSION_READY", response || { installed: true });
      },
    );
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data?.type) {
      return;
    }
    if (!isVintrackAppOrigin(window.location.origin)) {
      return;
    }

    if (event.data.type === "VINTRACK_EXTENSION_PING") {
      sendRuntimeMessage(
        { type: "VINTRACK_EXTENSION_PING" },
        (response, runtimeError) => {
          if (runtimeError) {
            return;
          }
          post("VINTRACK_EXTENSION_READY", response || { installed: true });
        },
      );
      return;
    }

    if (event.data.type === "VINTRACK_EXTENSION_CONNECT") {
      sendRuntimeMessage(
        {
          type: "VINTRACK_EXTENSION_CONNECT",
          payload: event.data.payload,
        },
        (response, runtimeError) => {
          post(
            "VINTRACK_EXTENSION_CONNECT_RESULT",
            runtimeError
              ? {
                  ok: false,
                  error: runtimeError.message || "Extension connection failed",
                }
              : response || {
                  ok: false,
                  error: "Extension connection returned no result",
                },
          );
          syncVintrackTheme();
        },
      );
      return;
    }

    if (event.data.type === "VINTRACK_EXTENSION_MANUAL_SYNC") {
      sendRuntimeMessage(
        {
          type: "VINTRACK_EXTENSION_MANUAL_SYNC",
          payload: event.data.payload,
        },
        (response, runtimeError) => {
          post(
            "VINTRACK_EXTENSION_MANUAL_SYNC_RESULT",
            runtimeError
              ? {
                  ok: false,
                  error: runtimeError.message || "Extension sync failed",
                }
              : response || {
                  ok: false,
                  error: "Extension sync returned no result",
                },
          );
        },
      );
      return;
    }

    if (event.data.type === "VINTRACK_EXTENSION_BUY") {
      sendRuntimeMessage(
        {
          type: "VINTRACK_EXTENSION_BUY",
          payload: event.data.payload,
        },
        (response, runtimeError) => {
          post(
            "VINTRACK_EXTENSION_BUY_RESULT",
            runtimeError
              ? {
                  ok: false,
                  error:
                    runtimeError.message || "Extension checkout failed",
                }
              : response || { ok: false },
          );
        },
      );
    }
  });

  const runtime = getRuntime();
  runtime?.onMessage?.addListener((message, _sender, sendResponse) => {
    if (message?.type === "VINTRACK_TAB_PING") {
      sendResponseSafely(sendResponse, {
        ok: true,
        isVintedPage: isVintedHost(window.location.hostname),
      });
      return false;
    }

    if (message?.type === "VINTRACK_RUN_BROWSER_BUY") {
      ensurePageBridge();
      waitForPageBridgeReady()
        .then(() => requestPageBuy(message.payload))
        .then((response) => sendResponseSafely(sendResponse, response))
        .catch((error) =>
          sendResponseSafely(sendResponse, {
            ok: false,
            code: "page_bridge_error",
            error:
              error instanceof Error
                ? error.message
                : "Unknown page bridge error",
            requestId: message.payload?.requestId,
          }),
        );
      return true;
    }

    if (message?.type === "VINTRACK_REFRESH_BROWSER_SESSION") {
      ensurePageBridge();
      waitForPageBridgeReady()
        .then(() => requestPageSessionRefresh(message.payload))
        .then((response) => sendResponseSafely(sendResponse, response))
        .catch((error) =>
          sendResponseSafely(sendResponse, {
            ok: false,
            code: "page_bridge_error",
            error:
              error instanceof Error
                ? error.message
                : "Unknown page bridge error",
            requestId: message.payload?.requestId,
          }),
        );
      return true;
    }

    if (message?.type === "VINTRACK_GET_BROWSER_ACCOUNT") {
      ensurePageBridge();
      waitForPageBridgeReady()
        .then(() => requestPageAccount(message.payload))
        .then((response) => sendResponseSafely(sendResponse, response))
        .catch((error) =>
          sendResponseSafely(sendResponse, {
            ok: false,
            code: "page_bridge_error",
            error:
              error instanceof Error
                ? error.message
                : "Unknown browser account lookup error",
            requestId: message.payload?.requestId,
          }),
        );
      return true;
    }

    return false;
  });
})();
