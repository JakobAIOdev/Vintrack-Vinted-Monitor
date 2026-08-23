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
    const normalized = String(hostname || "")
      .trim()
      .toLowerCase();
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

  let companionMode = "inline";
  let companionDrawerHost = null;
  let companionController = null;
  let companionObserver = null;
  let companionUrlTimer = null;
  let companionRenderTimer = null;
  let lastCompanionUrl = window.location.href;

  function companionShortcutLabel() {
    const platform = String(
      navigator.userAgentData?.platform ||
        navigator.platform ||
        navigator.userAgent ||
        "",
    );
    return /mac|iphone|ipad/i.test(platform)
      ? "Option + Shift + V"
      : "Alt + Shift + V";
  }

  function vintrackMark() {
    const namespace = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(namespace, "svg");
    svg.setAttribute("viewBox", "0 0 64 64");
    svg.setAttribute("aria-hidden", "true");
    svg.style.cssText =
      "display:block;width:30px;height:30px;border-radius:7px;box-shadow:0 3px 10px rgba(9,9,11,.18);";

    const shape = (name, attributes) => {
      const node = document.createElementNS(namespace, name);
      for (const [key, value] of Object.entries(attributes)) {
        node.setAttribute(key, value);
      }
      return node;
    };

    svg.append(
      shape("rect", {
        width: "64",
        height: "64",
        rx: "14",
        fill: "#09090b",
      }),
      shape("path", {
        d: "M16 15h10l6 23 6-23h10L38 49H26L16 15Z",
        fill: "#fafafa",
      }),
    );
    return svg;
  }

  function nativeCompanionButton(label, kind) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.vintrackCompanionButton = kind;
    const isHeaderAction = kind === "header";
    button.setAttribute(
      "aria-label",
      isHeaderAction
        ? `${label} · Shortcut ${companionShortcutLabel()}`
        : label,
    );
    if (isHeaderAction) {
      button.title = `Open Vintrack Companion · ${companionShortcutLabel()}`;
    }
    const isCatalogAction = kind === "catalog";
    button.style.cssText = [
      "display:inline-flex",
      "align-items:center",
      "justify-content:center",
      "gap:6px",
      isHeaderAction ? "width:38px" : "width:auto",
      isHeaderAction ? "min-height:38px" : "min-height:36px",
      isHeaderAction
        ? "margin:4px 8px"
        : isCatalogAction
          ? "margin:0"
          : "margin:6px",
      isHeaderAction
        ? "padding:3px"
        : isCatalogAction
          ? "padding:8px 14px"
          : "padding:7px 12px",
      isHeaderAction ? "border:0" : "border:1px solid #0f172a",
      isHeaderAction
        ? "border-radius:12px"
        : isCatalogAction
          ? "border-radius:999px"
          : "border-radius:10px",
      isCatalogAction ? "color:#f8fafc" : "color:#0f172a",
      isHeaderAction
        ? "background:transparent"
        : isCatalogAction
          ? "background:#0f172a"
          : "background:#fff",
      "font:650 13px/1.2 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
      "cursor:pointer",
      "white-space:nowrap",
      isHeaderAction
        ? "box-shadow:none"
        : isCatalogAction
          ? "box-shadow:0 8px 20px rgba(15,23,42,.16)"
          : "box-shadow:none",
      "transition:transform 150ms ease,filter 150ms ease",
      "z-index:2",
    ].join(";");
    if (isHeaderAction) {
      button.appendChild(vintrackMark());
    } else {
      button.appendChild(document.createTextNode(label));
    }
    button.addEventListener("mouseenter", () => {
      if (isHeaderAction) {
        button.style.transform = "translateY(-1px)";
        button.style.filter = "brightness(1.06)";
      } else {
        button.style.background = isCatalogAction ? "#1e293b" : "#f1f4f8";
      }
    });
    button.addEventListener("mouseleave", () => {
      if (isHeaderAction) {
        button.style.transform = "none";
        button.style.filter = "none";
      } else {
        button.style.background = isCatalogAction ? "#0f172a" : "#fff";
      }
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openCompanionDrawer();
    });
    return button;
  }

  function closeCompanionDrawer() {
    companionController?.destroy?.();
    companionController = null;
    companionDrawerHost?.remove();
    companionDrawerHost = null;
  }

  function openCompanionDrawer() {
    if (companionMode !== "inline" || companionDrawerHost) return;
    const runtime = getRuntime();
    if (!runtime?.getURL || !globalThis.VintrackCompanion?.mount) return;

    const host = document.createElement("div");
    host.dataset.vintrackCompanionDrawer = "true";
    host.style.cssText =
      "position:fixed;inset:0;z-index:2147483646;pointer-events:none;";
    const shadow = host.attachShadow({ mode: "closed" });
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = runtime.getURL("companion.css");
    const backdrop = document.createElement("button");
    backdrop.type = "button";
    backdrop.setAttribute("aria-label", "Close Vintrack Companion");
    backdrop.style.cssText =
      "position:absolute;inset:0;border:0;background:rgba(7,22,25,.34);pointer-events:auto;cursor:default;";
    const drawer = document.createElement("aside");
    drawer.setAttribute("aria-label", "Vintrack Companion");
    drawer.style.cssText =
      "position:absolute;top:0;right:0;width:min(430px,100vw);height:100vh;overflow:hidden;background:#f5f7f8;box-shadow:-20px 0 60px rgba(7,22,25,.24);pointer-events:auto;";
    backdrop.addEventListener("click", closeCompanionDrawer);
    shadow.append(stylesheet, backdrop, drawer);
    (document.body || document.documentElement).appendChild(host);
    companionDrawerHost = host;
    companionController = globalThis.VintrackCompanion.mount(drawer, {
      surface: "drawer",
      onClose: closeCompanionDrawer,
      onStateChange: updateInlineActionState,
    });
  }

  function updateInlineActionState(state) {
    const context = state?.context;
    const headerButton = document.querySelector(
      '[data-vintrack-companion-button="header"]',
    );
    if (headerButton) {
      const linked = Boolean(state?.overview?.account?.linked);
      headerButton.title = linked
        ? `Vintrack is linked · ${companionShortcutLabel()}`
        : `Open Vintrack Companion · ${companionShortcutLabel()}`;
    }

    const catalogButton = document.querySelector(
      '[data-vintrack-companion-button="catalog"]',
    );
    if (catalogButton && context?.kind === "catalog") {
      catalogButton.textContent = context.matchingMonitor
        ? "✓ Open monitor in Vintrack"
        : "＋ Create monitor for this search";
      catalogButton.title = context.matchingMonitor?.name || "";
    }

    const itemLabel =
      context?.kind === "item" && context.priceWatch
        ? "✓ Price tracked in Vintrack"
        : "＋ Track price with Vintrack";
    for (const button of document.querySelectorAll(
      '[data-vintrack-companion-button^="item-"]',
    )) {
      if (context?.kind === "item") button.textContent = itemLabel;
    }
  }

  function removeInlineCompanion() {
    for (const node of document.querySelectorAll(
      "[data-vintrack-companion-button], [data-vintrack-companion-mount]",
    )) {
      node.remove();
    }
    closeCompanionDrawer();
    if (companionUrlTimer) {
      window.clearInterval(companionUrlTimer);
      companionUrlTimer = null;
    }
  }

  function visibleCatalogFilterTrigger() {
    const triggers = Array.from(
      document.querySelectorAll(
        '[data-testid^="catalog--"][data-testid$="-filter--trigger"]',
      ),
    );
    return (
      triggers.find(
        (trigger) =>
          trigger.getClientRects().length > 0 && trigger.offsetParent !== null,
      ) || triggers[0]
    );
  }

  function catalogFilterRow() {
    const trigger = visibleCatalogFilterTrigger();
    if (!trigger) return null;
    let candidate = trigger.parentElement;
    for (let depth = 0; candidate && depth < 6; depth += 1) {
      const count = candidate.querySelectorAll(
        '[data-testid^="catalog--"][data-testid$="-filter--trigger"]',
      ).length;
      if (count >= 2) return candidate;
      candidate = candidate.parentElement;
    }
    return null;
  }

  function placeInlineCompanionButtons() {
    if (companionMode !== "inline" || !isVintedHost(window.location.hostname)) {
      return;
    }

    const logo = document.querySelector('[data-testid="header-logo-id"]');
    const headerTarget = logo?.parentElement;
    if (
      headerTarget &&
      !document.querySelector('[data-vintrack-companion-button="header"]')
    ) {
      headerTarget.appendChild(nativeCompanionButton("Vintrack", "header"));
    }

    const path = window.location.pathname.replace(/\/+$/, "") || "/";
    if (path === "/catalog") {
      const catalogTarget = catalogFilterRow();
      if (
        catalogTarget &&
        !document.querySelector('[data-vintrack-companion-mount="catalog"]')
      ) {
        const mount = document.createElement("div");
        mount.dataset.vintrackCompanionMount = "catalog";
        mount.style.cssText =
          "display:inline-flex;align-items:center;margin:0 8px 8px 0;order:-1;";
        mount.appendChild(
          nativeCompanionButton("＋ Create monitor for this search", "catalog"),
        );
        catalogTarget.prepend(mount);
      }
    }

    if (/^\/items\/[1-9]\d*(?:-|$)/.test(path)) {
      const desktopTarget =
        document.querySelector(
          '[data-testid="item-desktops-only-container"] #sidebar',
        ) || document.querySelector("main.item-information #sidebar");
      if (
        desktopTarget &&
        !document.querySelector(
          '[data-vintrack-companion-button="item-desktop"]',
        )
      ) {
        desktopTarget.prepend(
          nativeCompanionButton("＋ Track price with Vintrack", "item-desktop"),
        );
      }
      const mobileTarget = document.querySelector(
        '[data-testid="item-mobiles-only-container"]',
      );
      if (
        mobileTarget &&
        !document.querySelector(
          '[data-vintrack-companion-button="item-mobile"]',
        )
      ) {
        mobileTarget.prepend(
          nativeCompanionButton("＋ Track price with Vintrack", "item-mobile"),
        );
      }
    }
  }

  function scheduleInlineCompanionRender() {
    if (companionRenderTimer) return;
    companionRenderTimer = window.setTimeout(() => {
      companionRenderTimer = null;
      if (lastCompanionUrl !== window.location.href) {
        lastCompanionUrl = window.location.href;
        closeCompanionDrawer();
        for (const node of document.querySelectorAll(
          '[data-vintrack-companion-button]:not([data-vintrack-companion-button="header"]), [data-vintrack-companion-mount]',
        )) {
          node.remove();
        }
      }
      placeInlineCompanionButtons();
    }, 80);
  }

  function setCompanionMode(mode) {
    companionMode = mode === "popup" ? "popup" : "inline";
    if (companionMode !== "inline") {
      removeInlineCompanion();
      return;
    }
    scheduleInlineCompanionRender();
    if (!companionUrlTimer) {
      companionUrlTimer = window.setInterval(
        scheduleInlineCompanionRender,
        750,
      );
    }
  }

  function setupInlineCompanion() {
    if (!isVintedHost(window.location.hostname)) return;
    if (!companionObserver) {
      companionObserver = new MutationObserver(scheduleInlineCompanionRender);
      companionObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
      window.addEventListener("popstate", scheduleInlineCompanionRender);
      window.addEventListener("hashchange", scheduleInlineCompanionRender);
    }
    sendRuntimeMessage(
      { type: "VINTRACK_COMPANION_MODE" },
      (response, runtimeError) => {
        if (!runtimeError) {
          setCompanionMode(response?.companionMode);
        }
      },
    );
  }

  function handleCompanionShortcut(event) {
    if (
      companionMode !== "inline" ||
      !event.altKey ||
      !event.shiftKey ||
      event.code !== "KeyV" ||
      event.repeat
    ) {
      return;
    }
    event.preventDefault();
    if (companionDrawerHost) {
      closeCompanionDrawer();
    } else {
      openCompanionDrawer();
    }
  }

  ensurePageBridge();
  watchVintrackTheme();
  setupInlineCompanion();
  window.addEventListener("keydown", handleCompanionShortcut);

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
                  error: runtimeError.message || "Extension checkout failed",
                }
              : response || { ok: false },
          );
        },
      );
    }
  });

  const runtime = getRuntime();
  runtime?.onMessage?.addListener((message, _sender, sendResponse) => {
    if (message?.type === "VINTRACK_COMPANION_MODE_CHANGED") {
      setCompanionMode(message.payload?.mode);
      sendResponseSafely(sendResponse, {
        ok: true,
        companionMode,
      });
      return false;
    }

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
