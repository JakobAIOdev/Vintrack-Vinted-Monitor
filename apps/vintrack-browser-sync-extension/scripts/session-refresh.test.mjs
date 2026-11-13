import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(
  new URL("../background.js", import.meta.url),
  "utf8",
);
const appOrigin = "https://vintrack.jakobaio.dev";
const initialNow = Date.parse("2026-10-02T12:00:00Z");
const clone = (value) => JSON.parse(JSON.stringify(value));
function token(expiresAt, issuedAt = initialNow / 1000) {
  return `synthetic.${Buffer.from(JSON.stringify({ exp: expiresAt / 1000, iat: issuedAt, sub: "42" })).toString("base64url")}.signature`;
}
function response(status = 200, body = {}, headers = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers,
  });
}

function harness(options = {}) {
  let now = options.now || initialNow;
  const storage = options.storage || {
    browserLinkToken: "synthetic-link",
    vintrackAppOrigin: appOrigin,
    vintrackSyncedDomains: ["www.vinted.de"],
  };
  let cookies = options.cookies || [
    {
      name: "access_token_web",
      domain: ".vinted.de",
      storeId: "0",
      value: token(now + 60_000),
    },
  ];
  const calls = [];
  const cookieReads = [];
  const tabMutations = [];
  const tabMessages = [];
  const listeners = {};
  const event = (name) => ({
    addListener(fn) {
      listeners[name] = fn;
    },
    removeListener() {},
  });
  const api = {
    storage: {
      local: {
        async get(keys) {
          return Object.fromEntries(
            (typeof keys === "string" ? [keys] : keys)
              .filter((key) => key in storage)
              .map((key) => [key, clone(storage[key])]),
          );
        },
        async set(values) {
          Object.assign(storage, clone(values));
        },
        async remove(keys) {
          for (const key of typeof keys === "string" ? [keys] : keys)
            delete storage[key];
        },
      },
    },
    cookies: {
      async get(details) {
        cookieReads.push(details.name);
        const host = new URL(details.url).hostname;
        const cookie =
          cookies.find(
            (cookie) =>
              cookie.name === details.name &&
              (host === cookie.domain.replace(/^\./, "") ||
                host.endsWith(`.${cookie.domain.replace(/^\./, "")}`)) &&
              cookie.storeId ===
                (details.storeId ||
                  (options.firefox ? "firefox-default" : "0")),
          ) || null;
        return cookie ? clone(cookie) : null;
      },
      async getAll(details) {
        return cookies.filter(
          (cookie) =>
            cookie.name === details.name &&
            cookie.storeId ===
              (details.storeId || (options.firefox ? "firefox-default" : "0")),
        );
      },
      onChanged: event("cookie"),
    },
    tabs: {
      async query() {
        return options.tabs || [];
      },
      async sendMessage(id, message) {
        tabMessages.push({ id, message });
        if (message.type === "VINTRACK_TAB_PING") return { ok: true };
        if (message.type === "VINTRACK_GET_BROWSER_ACCOUNT")
          return { ok: true, accountId: 42 };
        return (
          options.onTabRefresh?.(id, message, rotate) || {
            ok: true,
            status: 200,
          }
        );
      },
      ...Object.fromEntries(
        ["create", "update", "reload", "remove"].map((name) => [
          name,
          async (...args) => {
            tabMutations.push({ name, args });
            throw new Error(`Unexpected tab mutation: ${name}`);
          },
        ]),
      ),
      onActivated: event("activated"),
      onUpdated: event("updated"),
    },
    alarms: { create() {}, onAlarm: event("alarm") },
    runtime: {
      getManifest: () => ({
        version: "0.2.1",
        ...(options.firefox
          ? {
              browser_specific_settings: { gecko: { id: "synthetic-firefox" } },
            }
          : {}),
        content_scripts: [{ matches: [`${appOrigin}/*`] }],
      }),
      getURL: path => `${options.firefox ? "moz-extension" : "chrome-extension"}://synthetic-own${path}`,
      onStartup: event("startup"),
      onInstalled: event("installed"),
      onMessage: event("message"),
    },
    permissions: {
      async getAll() {
        return {};
      },
    },
  };
  function rotate(storeId = options.firefox ? "firefox-default" : "0") {
    const existing = cookies.find((cookie) => cookie.storeId === storeId);
    const fresh = {
      name: "access_token_web",
      domain: ".vinted.de",
      storeId,
      value: token(now + 3_600_000, now / 1000 + 1),
    };
    if (existing) Object.assign(existing, fresh);
    else cookies.push(fresh);
  }
  const context = vm.createContext({
    [options.firefox ? "browser" : "chrome"]: api,
    ...(options.browserAlias ? { browser: api } : {}),
    crypto: webcrypto,
    TextEncoder,
    URL,
    AbortController,
    atob,
    navigator: { userAgent: "Synthetic test browser" },
    console,
    Date: class extends Date {
      static now() {
        return now;
      }
    },
    setTimeout: (fn, ms) =>
      setTimeout(
        fn,
        ms === 750 || (options.fastTimeout && ms === 12000) ? 1 : ms,
      ),
    clearTimeout,
    fetch: async (url, init = {}) => {
      calls.push({ url, init });
      if (options.fetch) return options.fetch(url, init, rotate);
      if (url.startsWith(appOrigin))
        return response(200, { status: "completed", domain: "www.vinted.de" });
      if (init.method === "POST") {
        rotate();
        return response();
      }
      return response(200, '<meta name="csrf-token" content="synthetic-csrf">');
    },
  });
  vm.runInContext(source, context);
  return {
    context,
    storage,
    calls,
    cookieReads,
    tabMutations,
    tabMessages,
    listeners,
    rotate,
    advance(ms) {
      now += ms;
    },
    setCookies(value) {
      cookies = value;
    },
    get now() {
      return now;
    },
  };
}
const target = [{ domain: "www.vinted.de", storeId: "0" }];
const vintedCalls = (h) =>
  h.calls.filter(({ url }) => !url.startsWith(appOrigin));

test("expired token refreshes silently, rotates cookies and syncs only the access token", async () => {
  const h = harness();
  const result = await h.context.syncAndPersistAllDomains();
  assert.equal(result[0].ok, true);
  assert.equal(vintedCalls(h).length, 2);
  for (const { init } of vintedCalls(h)) {
    assert.equal(init.credentials, "include");
    assert.equal(init.redirect, "error");
    assert.equal(init.headers?.Cookie, undefined);
  }
  const body = JSON.parse(
    h.calls.find(({ url }) => url.startsWith(appOrigin)).init.body,
  );
  assert.equal(body.refresh_token, undefined);
  assert.equal(body.cookie_header, undefined);
  assert.equal(h.storage.vintrackLastSyncStatus, "ok");
  assert.deepEqual(h.tabMutations, []);
});

test("alarms, cookie events and concurrent calls share a refresh lifecycle", async () => {
  const h = harness();
  await Promise.all([
    h.context.syncAndPersistAllDomains(),
    h.context.syncAndPersistAllDomains(),
    h.context.syncAndPersistPreferredOrAllDomains("vinted.de"),
  ]);
  assert.equal(
    vintedCalls(h).filter(({ init }) => init.method === "POST").length,
    1,
  );
  assert.deepEqual(h.tabMutations, []);
});

test("healthy token receipts survive worker restart and expire after ten minutes", async () => {
  const cookies = [
    {
      name: "access_token_web",
      domain: ".vinted.de",
      storeId: "0",
      value: token(initialNow + 3_600_000),
    },
  ];
  const h = harness({ cookies });
  await h.context.syncAndPersistAllDomains();
  const restarted = harness({ storage: h.storage, cookies });
  const cached = await restarted.context.syncAndPersistAllDomains();
  assert.equal(cached[0].cached, true);
  assert.equal(restarted.calls.length, 0);
  restarted.advance(600_001);
  await restarted.context.syncAndPersistAllDomains();
  assert.equal(restarted.calls.length, 1);
});

test("a different browser-link token cannot reuse a sync receipt", async () => {
  const h = harness();
  await h.context.syncAndPersistAllDomains();
  h.storage.browserLinkToken = "another-synthetic-link";
  await h.context.syncAndPersistAllDomains();
  assert.equal(
    h.calls.filter(({ url }) => url.startsWith(appOrigin)).length,
    2,
  );
});

test("401/403 require user action and backoff survives worker restart", async () => {
  for (const status of [401, 403]) {
    const options = {
      fetch: async () => response(status, "sensitive upstream body"),
    };
    const h = harness(options);
    const results = await h.context.syncAndPersistAllDomains();
    assert.equal(results[0].requiresUserAction, true);
    assert.ok(!JSON.stringify(h.storage).includes("sensitive upstream body"));
    const restarted = harness({ ...options, storage: h.storage });
    await restarted.context.syncAndPersistAllDomains();
    assert.equal(restarted.calls.length, 0);
    await restarted.context.syncAndPersistPreferredOrAllDomains(
      "www.vinted.de",
      { bypassAutoRecoveryCooldown: true },
    );
    assert.equal(restarted.calls.length, 1);
    assert.deepEqual(restarted.tabMutations, []);
  }
});

test("rate limits respect Retry-After even for an explicit retry", async () => {
  const h = harness({
    fetch: async () => response(429, {}, { "Retry-After": "900" }),
  });
  await h.context.syncAndPersistAllDomains();
  const next =
    h.storage.vintrackBrowserRefreshState["www.vinted.de|0"].nextAttemptAt;
  assert.equal(next - h.now, 900_000);
  await h.context.syncAndPersistPreferredOrAllDomains("vinted.de", {
    bypassAutoRecoveryCooldown: true,
  });
  assert.equal(h.calls.length, 1);
  h.advance(900_001);
  await h.context.syncAndPersistAllDomains();
  assert.equal(h.calls.length, 2);
});

test("transient failures retry with increasing durable delays", async () => {
  const h = harness({
    fetch: async () => {
      throw new Error("network offline");
    },
  });
  await h.context.syncAndPersistAllDomains();
  assert.equal(
    h.storage.vintrackBrowserRefreshState["www.vinted.de|0"].nextAttemptAt -
      h.now,
    60_000,
  );
  await h.context.syncAndPersistAllDomains();
  assert.equal(h.calls.length, 1);
  h.advance(60_001);
  await h.context.syncAndPersistAllDomains();
  assert.equal(
    h.storage.vintrackBrowserRefreshState["www.vinted.de|0"].nextAttemptAt -
      h.now,
    120_000,
  );
});

test("a Vintrack outage or invalid link never triggers a Vinted refresh", async () => {
  for (const status of [401, 403, 404, 429, 502]) {
    const h = harness({
      cookies: [
        {
          name: "access_token_web",
          domain: ".vinted.de",
          storeId: "0",
          value: token(initialNow + 3_600_000),
        },
      ],
      fetch: async () => response(status, { error: "Vintrack unavailable" }),
    });
    await h.context.syncAndPersistAllDomains();
    assert.equal(vintedCalls(h).length, 0);
    assert.deepEqual(h.tabMutations, []);
  }
});

test("HTTP success without cookie rotation remains a failure", async () => {
  const h = harness({
    fetch: async (url, init) =>
      init.method === "POST"
        ? response()
        : response(200, '<meta name="csrf-token" content="synthetic-csrf">'),
  });
  const result = await h.context.syncAndPersistAllDomains();
  assert.equal(result[0].reason, "browser-token-not-rotated");
  assert.equal(h.storage.vintrackLastSyncStatus, "error");
});

test("missing cookies recover only the remembered session domain", async () => {
  const h = harness({ cookies: [] });
  await h.context.syncAndPersistAllDomains();
  assert.equal(vintedCalls(h).length, 2);
  assert.ok(
    vintedCalls(h).every(
      ({ url }) => new URL(url).hostname === "www.vinted.de",
    ),
  );
  assert.deepEqual(h.tabMutations, []);
});

test("unconfigured installations do not refresh or mark a session as failed", async () => {
  const h = harness({ storage: {} });
  await h.context.syncAndPersistAllDomains();
  assert.equal(h.calls.length, 0);
  assert.equal(h.storage.vintrackLastSyncStatus, undefined);
});

test("the most recent matching tab refreshes once without reload or navigation", async () => {
  const h = harness({
    tabs: [
      { id: 1, url: "https://vinted.de/items/1", lastAccessed: 1 },
      { id: 2, url: "https://www.vinted.de/items/2", lastAccessed: 2 },
    ],
    onTabRefresh(id, message, rotate) {
      rotate();
      return { ok: true, status: 200 };
    },
  });
  await h.context.syncAndPersistAllDomains();
  assert.equal(vintedCalls(h).length, 0);
  assert.equal(
    h.tabMessages.filter(
      ({ message }) => message.type === "VINTRACK_REFRESH_BROWSER_SESSION",
    ).length,
    1,
  );
  assert.equal(h.tabMessages[0].id, 2);
  assert.deepEqual(h.tabMutations, []);
});

test("closed Firefox containers never refresh in the default cookie store", async () => {
  const h = harness({ firefox: true, cookies: [] });
  const result = await h.context.refreshVintedBrowserSessions([
    { domain: "vinted.de", storeId: "firefox-container-1" },
  ]);
  assert.equal(result[0].reason, "browser-context-required");
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.tabMutations, []);
});

test("missing container cookies retain the saved cookie-store context", async () => {
  const h = harness({ firefox: true, cookies: [] });
  h.storage.vintrackSyncedSessions = [
    { domain: "www.vinted.de", storeId: "firefox-container-1" },
  ];
  await h.context.syncAndPersistPreferredOrAllDomains("www.vinted.de");
  assert.equal(h.calls.length, 0);
  assert.match(h.storage.vintrackLastSyncError, /container/);
});

test("an open Firefox container refreshes only its matching tab", async () => {
  const h = harness({
    firefox: true,
    cookies: [
      {
        name: "access_token_web",
        domain: ".vinted.de",
        storeId: "firefox-container-1",
        value: token(initialNow + 60_000),
      },
    ],
    tabs: [
      {
        id: 1,
        url: "https://www.vinted.de/",
        cookieStoreId: "firefox-default",
        lastAccessed: 20,
      },
      {
        id: 2,
        url: "https://www.vinted.de/",
        cookieStoreId: "firefox-container-1",
        lastAccessed: 10,
      },
    ],
    onTabRefresh(id, message, rotate) {
      rotate("firefox-container-1");
      return { ok: true, status: 200 };
    },
  });
  const result = await h.context.refreshVintedBrowserSessions([
    { domain: "vinted.de", storeId: "firefox-container-1" },
  ]);
  assert.equal(result[0].ok, true);
  assert.equal(h.tabMessages[0].id, 2);
  assert.equal(h.calls.length, 0);
});

test("security failures in an open tab are not retried in a different context", async () => {
  const h = harness({
    tabs: [{ id: 1, url: "https://www.vinted.de/" }],
    onTabRefresh() {
      return { ok: false, status: 403 };
    },
  });
  const result = await h.context.syncAndPersistAllDomains();
  assert.equal(result[0].requiresUserAction, true);
  assert.equal(h.calls.length, 0);
});

test("refresh requests time out and leave a durable retry delay", async () => {
  const h = harness({
    fastTimeout: true,
    fetch: async (url, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        );
      }),
  });
  const result = await h.context.refreshVintedBrowserSessions(target);
  assert.equal(result[0].ok, false);
  assert.ok(
    h.storage.vintrackBrowserRefreshState["www.vinted.de|0"].nextAttemptAt >
      h.now,
  );
});

test("unsupported and lookalike domains never receive refresh requests", async () => {
  const h = harness();
  await h.context.refreshVintedBrowserSessions([
    { domain: "vinted.de.example.com" },
    { domain: "evilvinted.de" },
    { domain: "vinted.xyz" },
  ]);
  assert.equal(h.calls.length, 0);
});

test("an externally renewed token clears a login cooldown and user-action status", async () => {
  let fail = true;
  const h = harness({
    fetch: async (url) =>
      url.startsWith(appOrigin)
        ? response(200, { status: "completed", domain: "www.vinted.de" })
        : response(fail ? 403 : 200),
  });
  await h.context.syncAndPersistAllDomains();
  assert.equal(h.storage.vintrackLastSyncNeedsUserAction, true);
  fail = false;
  h.rotate();
  await h.context.syncAndPersistAllDomains();
  assert.equal(h.storage.vintrackLastSyncNeedsUserAction, false);
  assert.equal(h.storage.vintrackLastSyncError, "");
  assert.deepEqual(h.storage.vintrackBrowserRefreshState, {});
});

test("periodic sync renews a saved Firefox container without default-store requests", async () => {
  const h = harness({
    firefox: true,
    cookies: [
      {
        name: "access_token_web",
        domain: ".vinted.de",
        storeId: "firefox-container-1",
        value: token(initialNow + 60_000),
      },
    ],
    tabs: [
      {
        id: 2,
        url: "https://www.vinted.de/",
        cookieStoreId: "firefox-container-1",
      },
    ],
    onTabRefresh(id, message, rotate) {
      rotate("firefox-container-1");
      return { ok: true, status: 200 };
    },
  });
  h.storage.vintrackSyncedSessions = [
    { domain: "www.vinted.de", storeId: "firefox-container-1" },
  ];
  const result = await h.context.syncAndPersistAllDomains();
  assert.equal(result[0].ok, true);
  assert.equal(vintedCalls(h).length, 0);
  assert.equal(h.tabMessages[0].id, 2);
});

test("automatic events for unrelated accounts do not disturb the linked context", async () => {
  const h = harness();
  h.storage.vintrackSyncedSessions = [
    { domain: "www.vinted.fr", storeId: "0" },
  ];
  await h.context.syncAndPersistPreferredOrAllDomains("vinted.de", {
    storeId: "0",
  });
  assert.equal(h.calls.length, 0);
  assert.equal(h.storage.vintrackLastSyncStatus, undefined);
});

test("200 challenge pages without CSRF never lead to a refresh POST", async () => {
  const h = harness({
    fetch: async () => response(200, "<html>Security check</html>"),
  });
  const result = await h.context.syncAndPersistAllDomains();
  assert.equal(result[0].requiresUserAction, true);
  assert.equal(h.calls.length, 1);
});

test("base and www aliases share the same rate-limit cooldown", async () => {
  const h = harness({
    fetch: async () => response(429, {}, { "Retry-After": "900" }),
  });
  await h.context.refreshVintedBrowserSessions([{ domain: "vinted.de" }]);
  await h.context.refreshVintedBrowserSessions(target, {
    bypassAutoRecoveryCooldown: true,
  });
  assert.equal(h.calls.length, 1);
});

test("a missing explicitly selected container token never falls back to the default token", async () => {
  const h = harness({
    firefox: true,
    cookies: [
      {
        name: "access_token_web",
        domain: ".vinted.de",
        storeId: "firefox-default",
        value: token(initialNow + 3_600_000),
      },
    ],
  });
  const result = await h.context.syncAndPersistPreferredOrAllDomains(
    "www.vinted.de",
    { storeId: "firefox-container-1" },
  );
  assert.equal(result[0].reason, "browser-context-required");
  assert.equal(h.calls.length, 0);
});

test("current escaped Next.js CSRF_TOKEN works without a meta tag", async () => {
  const h = harness({
    fetch: async (url, init, rotate) => {
      if (url.startsWith(appOrigin))
        return response(200, { status: "completed", domain: "www.vinted.de" });
      if (init.method === "POST") {
        assert.equal(init.headers["X-Csrf-Token"], "synthetic-csrf");
        rotate();
        return response();
      }
      return response(
        200,
        "<script>self.__next_f.push([1," +
          JSON.stringify(JSON.stringify({ CSRF_TOKEN: "synthetic-csrf" })) +
          "])</script>",
      );
    },
  });
  const results = await h.context.syncAndPersistAllDomains();
  assert.equal(results[0].ok, true);
});

test("Chromium browser namespace alias does not change its cookie-store identity", async () => {
  const h = harness({ browserAlias: true });
  const results = await h.context.syncAndPersistAllDomains();
  assert.equal(results[0].ok, true);
});


test("extension pages are authorized only for their own extension origin", () => {
  for (const [options, scheme] of [[{}, "chrome-extension"], [{ firefox: true }, "moz-extension"]]) {
    const h = harness(options);
    assert.equal(h.context.isExtensionPageSender({ url: `${scheme}://synthetic-own/popup.html` }), true);
    for (const url of [`${scheme}://foreign/popup.html`, "https://synthetic-own/popup.html", "https://vintrack.jakobaio.dev", "invalid"]) {
      assert.equal(h.context.isExtensionPageSender({ url }), false, url);
    }
  }
});

test("runtime capabilities advertise desktop checkout without network requests", async () => {
  for (const options of [{}, { firefox: true }]) {
    const h = harness(options);
    const result = await new Promise(resolve => h.listeners.message({ type: "VINTRACK_EXTENSION_PING" }, { url: `${appOrigin}/checkout/17/123` }, resolve));
    assert.equal(result.ok, true);
    assert.equal(result.configured, true);
    assert.deepEqual(clone(result.checkoutCapabilities), { prepare: true, automaticPayment: true });
    assert.equal(h.calls.length, 0);
    assert.equal(h.tabMessages.length, 0);
  }
});


test("ordinary token sync never reads or copies checkout-context cookies", async () => {
  const h = harness({ cookies: [
    {name:"access_token_web", domain:".vinted.de",storeId:"0",value:token(initialNow+3600000)},
    {name:"datadome", domain:".vinted.de",storeId:"0",value:"synthetic-dd"},
    {name:"_vinted_fr_session", domain:".vinted.de",storeId:"0",value:"synthetic-session"},
    {name:"v_udt", domain:".vinted.de",storeId:"0",value:"synthetic-device"},
  ] });
  await h.context.performDomainSync("www.vinted.de");
  assert.deepEqual(h.cookieReads, ["access_token_web"]);
  assert.equal(JSON.parse(h.calls[0].init.body).checkout_context, undefined);
});

test("expanded checkout consent preserves Vinted session cookies without copying refresh credentials", async () => {
  const h = harness({ cookies: [
    {name:"access_token_web",domain:".vinted.de",storeId:"0",value:token(initialNow+3600000)},
    {name:"datadome",domain:".vinted.de",storeId:"0",value:"synthetic-dd"},
    {name:"anon_id",domain:".vinted.de",storeId:"0",value:"synthetic-anon"},
    {name:"_vinted_fr_session",domain:".vinted.de",storeId:"0",value:"synthetic-session"},
    {name:"v_udt",domain:".vinted.de",storeId:"0",value:"synthetic-device"},
    {name:"refresh_token_web",domain:".vinted.de",storeId:"0",value:"synthetic-refresh"},
  ], onTabRefresh: () => ({ok:true,accountId:42,csrfToken:"synthetic-csrf"}) });
  h.context.ensureVintedBuyTab = async () => ({tabId:7});
  const result = await h.context.performDomainSync("www.vinted.de", {includeCheckoutContext:true,checkoutContextConsent:2});
  assert.equal(result.ok,true);
  const body = JSON.parse(h.calls[0].init.body);
  assert.deepEqual(body.checkout_context, {consent_version:2,cookies:{datadome:"synthetic-dd",anon_id:"synthetic-anon",_vinted_fr_session:"synthetic-session",v_udt:"synthetic-device"},csrf_token:"synthetic-csrf"});
  assert.deepEqual(h.cookieReads,["access_token_web","datadome","anon_id","_vinted_fr_session","v_udt"]);
  assert.equal(body.refresh_token,undefined);
  for (const value of ["synthetic-session","synthetic-device","synthetic-refresh"]) assert.ok(!JSON.stringify(h.storage).includes(value));
});

test("explicit checkout sync sends only the allowed context to its configured origin and does not store it locally", async () => {
  const h = harness({ cookies: [
    {name:"access_token_web",domain:".vinted.de",storeId:"0",value:token(initialNow+3600000)},
    {name:"datadome",domain:".vinted.de",storeId:"0",value:"synthetic-dd"},
    {name:"anon_id",domain:".vinted.de",storeId:"0",value:"synthetic-anon"},
    {name:"refresh_token_web",domain:".vinted.de",storeId:"0",value:"synthetic-refresh"},
  ], onTabRefresh: () => ({ok:true,accountId:42,csrfToken:"synthetic-csrf"}) });
  h.context.ensureVintedBuyTab = async () => ({tabId:7});
  const first = await h.context.performDomainSync("www.vinted.de", {includeCheckoutContext:true});
  assert.equal(first.ok, true);
  const body = JSON.parse(h.calls[0].init.body);
  assert.deepEqual(body.checkout_context, {consent_version:1,cookies:{datadome:"synthetic-dd",anon_id:"synthetic-anon"},csrf_token:"synthetic-csrf"});
  assert.equal(body.refresh_token, undefined);
  assert.deepEqual(h.cookieReads, ["access_token_web","datadome","anon_id"]);
  assert.ok(!JSON.stringify(h.storage).includes("synthetic-dd"));
  assert.ok(!JSON.stringify(h.storage).includes("synthetic-csrf"));
  await h.context.performDomainSync("www.vinted.de", {includeCheckoutContext:true});
  assert.equal(h.calls.length, 2, "a token receipt cannot suppress explicit context sync");
});

for (const options of [{accountId:99,csrfToken:"synthetic-csrf"},{accountId:42,csrfToken:""}]) {
 test("checkout-context account or CSRF mismatch never leaves the browser", async () => {
  const h = harness({cookies:[{name:"access_token_web",domain:".vinted.de",storeId:"0",value:token(initialNow+3600000)}],onTabRefresh:()=>({ok:true,...options})});
  h.context.ensureVintedBuyTab=async()=>({tabId:7});
  const result=await h.context.performDomainSync("www.vinted.de",{includeCheckoutContext:true});
  assert.equal(result.ok,false);
  assert.equal(h.calls.length,0);
  assert.deepEqual(h.cookieReads,["access_token_web"]);
 });
}

test("context capture requires both the configured sender and explicit context consent", async () => {
 for (const sender of [{url:"https://evil.test"},{url:`${appOrigin}/account`}]) {
  const h=harness();
  const result=await new Promise(resolve=>h.listeners.message({type:"VINTRACK_EXTENSION_MANUAL_SYNC",payload:{preferredDomain:"www.vinted.de",includeCheckoutContext:true}},sender,resolve));
  assert.equal(result.ok,false);
  assert.equal(h.calls.length,0);
  assert.equal(h.cookieReads.length,0);
 }
});

// Background checkout-context sync after one explicit consent.
const grantKey = "vintrackCheckoutContextGrant";
const revokeType = "VINTRACK_EXTENSION_REVOKE_CHECKOUT_CONTEXT";
const contextCookieNames = [
  "access_token_web",
  "datadome",
  "anon_id",
  "_vinted_fr_session",
  "v_udt",
];
const fullContext = {
  consent_version: 2,
  cookies: {
    datadome: "synthetic-dd",
    anon_id: "synthetic-anon",
    _vinted_fr_session: "synthetic-session",
    v_udt: "synthetic-device",
  },
  csrf_token: "synthetic-csrf",
};
function contextCookies(domain = ".vinted.de", storeId = "0") {
  return [
    ["access_token_web", token(initialNow + 3_600_000)],
    ["datadome", "synthetic-dd"],
    ["anon_id", "synthetic-anon"],
    ["_vinted_fr_session", "synthetic-session"],
    ["v_udt", "synthetic-device"],
    ["refresh_token_web", "synthetic-refresh"],
  ].map(([name, value]) => ({ name, domain, storeId, value }));
}
function contextHarness(options = {}) {
  return harness({
    cookies: contextCookies(),
    tabs: [{ id: 7, url: "https://www.vinted.de/", lastAccessed: 1 }],
    onTabRefresh: (id, message) =>
      message.type === "VINTRACK_GET_CHECKOUT_CONTEXT"
        ? { ok: true, accountId: 42, csrfToken: "synthetic-csrf" }
        : undefined,
    ...options,
  });
}
const storedGrant = (overrides = {}) => ({
  consentVersion: 2,
  appOrigin,
  accountId: 42,
  domain: "www.vinted.de",
  grantedAt: "2026-10-02T12:00:00.000Z",
  ...overrides,
});
const syncBodies = (h) =>
  h.calls
    .filter(({ url }) => url.startsWith(appOrigin))
    .map(({ init }) => JSON.parse(init.body));
const send = (h, message, sender = { url: `${appOrigin}/account` }) =>
  new Promise((resolve) => h.listeners.message(message, sender, resolve));
const allowCheckoutContext = (h, checkoutContextConsent = 2) => {
  h.context.ensureVintedBuyTab = async () => ({ tabId: 7 });
  return send(h, {
    type: "VINTRACK_EXTENSION_MANUAL_SYNC",
    payload: {
      preferredDomain: "www.vinted.de",
      includeCheckoutContext: true,
      checkoutContextConsent,
    },
  });
};

test("without a grant an automatic sync next to an open Vinted tab stays token-only", async () => {
  const h = contextHarness();
  const results = await h.context.syncAndPersistAllDomains();
  assert.equal(results[0].ok, true);
  assert.equal(syncBodies(h).length, 1);
  assert.equal(syncBodies(h)[0].checkout_context, undefined);
  assert.deepEqual(h.cookieReads, ["access_token_web"]);
  assert.deepEqual(h.tabMessages, []);
  const status = await send(h, { type: "VINTRACK_EXTENSION_PING" });
  assert.equal(status.checkoutContextBackgroundSync, false);
});

test("an explicit consented sync stores a grant without cookie, CSRF or token values", async () => {
  const h = contextHarness();
  const result = await allowCheckoutContext(h);
  assert.equal(result.ok, true);
  assert.equal(result.checkoutContextBackgroundSync, true);
  assert.deepEqual(syncBodies(h)[0].checkout_context, fullContext);
  const { grantedAt, ...grant } = h.storage[grantKey];
  assert.deepEqual(grant, {
    consentVersion: 2,
    appOrigin,
    accountId: 42,
    domain: "www.vinted.de",
  });
  assert.ok(Number.isFinite(Date.parse(grantedAt)));
  const persisted = JSON.stringify(h.storage);
  for (const { value } of contextCookies())
    assert.ok(!persisted.includes(value));
  assert.ok(!persisted.includes("synthetic-csrf"));

  const status = await send(h, { type: "VINTRACK_EXTENSION_PING" });
  assert.equal(status.checkoutContextBackgroundSync, true);
  for (const key of ["accountId", "domain", "grantedAt", grantKey])
    assert.equal(key in status, false);
});

test("a failed or version 1 context sync never creates a background grant", async () => {
  const refused = contextHarness({
    fetch: async () => response(400, { error: "synthetic refusal" }),
  });
  assert.equal((await allowCheckoutContext(refused)).ok, false);
  assert.equal(grantKey in refused.storage, false);

  const legacy = contextHarness();
  const result = await allowCheckoutContext(legacy, 1);
  assert.equal(result.ok, true);
  assert.equal(result.checkoutContextBackgroundSync, false);
  assert.equal(grantKey in legacy.storage, false);
});

test("after the grant a renewed access token is synced with the version 2 context once", async () => {
  const h = contextHarness();
  await allowCheckoutContext(h);
  await h.context.syncAndPersistAllDomains();
  assert.equal(syncBodies(h).length, 1, "the unchanged token stays cached");

  h.rotate();
  h.cookieReads.length = 0;
  const results = await h.context.syncAndPersistAllDomains();
  assert.equal(results[0].ok, true);
  const body = syncBodies(h)[1];
  assert.deepEqual(body.checkout_context, fullContext);
  assert.equal(body.browser_vinted_id, 42);
  assert.equal(body.user_agent, "Synthetic test browser");
  assert.equal(body.refresh_token, undefined);
  assert.equal(body.cookie_header, undefined);
  assert.deepEqual(h.cookieReads, contextCookieNames);
  assert.deepEqual(h.tabMutations, []);

  // The same token is not sent with context again; the server keeps its copy.
  h.advance(600_001);
  await h.context.syncAndPersistAllDomains();
  assert.equal(syncBodies(h).length, 3);
  assert.equal(syncBodies(h)[2].checkout_context, undefined);

  const persisted = JSON.stringify(h.storage);
  for (const value of [
    "synthetic-dd",
    "synthetic-anon",
    "synthetic-session",
    "synthetic-device",
    "synthetic-refresh",
    "synthetic-csrf",
  ])
    assert.ok(!persisted.includes(value));
});

test("Sync now without the explicit flag carries the context while the grant matches", async () => {
  const h = contextHarness();
  h.storage[grantKey] = storedGrant();
  const result = await send(h, {
    type: "VINTRACK_EXTENSION_MANUAL_SYNC",
    payload: { preferredDomain: "www.vinted.de" },
  });
  assert.equal(result.ok, true);
  assert.equal(result.checkoutContextBackgroundSync, true);
  assert.deepEqual(syncBodies(h)[0].checkout_context, fullContext);
  assert.deepEqual(h.tabMutations, []);
});

test("a grant for another instance or account is not used and is cleared", async () => {
  for (const overrides of [
    { appOrigin: "http://localhost:3000" },
    { accountId: 99 },
  ]) {
    const h = contextHarness();
    h.storage[grantKey] = storedGrant(overrides);
    const status = await send(h, { type: "VINTRACK_EXTENSION_PING" });
    assert.equal(
      status.checkoutContextBackgroundSync,
      overrides.appOrigin === undefined,
    );
    const results = await h.context.syncAndPersistAllDomains();
    assert.equal(results[0].ok, true);
    assert.equal(syncBodies(h)[0].checkout_context, undefined);
    assert.deepEqual(h.cookieReads, ["access_token_web"]);
    assert.equal(grantKey in h.storage, false);
  }
});

test("a grant for another region is not used and ends once the linked region differs", async () => {
  const moved = contextHarness();
  moved.storage[grantKey] = storedGrant({ domain: "www.vinted.fr" });
  await moved.context.syncAndPersistAllDomains();
  assert.equal(syncBodies(moved)[0].checkout_context, undefined);
  assert.deepEqual(moved.cookieReads, ["access_token_web"]);
  assert.equal(grantKey in moved.storage, false);

  // A session the server ignores for another region leaves the grant alone.
  const ignored = contextHarness({
    cookies: contextCookies(".vinted.fr"),
    tabs: [{ id: 8, url: "https://www.vinted.fr/" }],
    fetch: async () =>
      response(200, {
        status: "ignored_domain",
        domain: "www.vinted.de",
        ignored_domain: "www.vinted.fr",
      }),
  });
  ignored.storage[grantKey] = storedGrant();
  const result = await ignored.context.performDomainSync("www.vinted.fr");
  assert.equal(result.ok, false);
  assert.equal(syncBodies(ignored)[0].checkout_context, undefined);
  assert.deepEqual(ignored.cookieReads, ["access_token_web"]);
  assert.deepEqual(ignored.storage[grantKey], storedGrant());
});

test("server account, region or removed-link answers end the grant", async () => {
  for (const [status, body] of [
    [200, { status: "ignored_account", domain: "www.vinted.de" }],
    [200, { status: "ignored_domain", domain: "www.vinted.fr" }],
    [409, { status: "browser_account_mismatch", domain: "www.vinted.de" }],
    [200, { status: "completed", domain: "www.vinted.de", vinted_id: 99 }],
    [404, { error: "browser link expired or not found" }],
  ]) {
    const h = contextHarness({ fetch: async () => response(status, body) });
    h.storage[grantKey] = storedGrant();
    await h.context.performDomainSync("www.vinted.de");
    assert.equal(grantKey in h.storage, false, JSON.stringify(body));
    assert.deepEqual(h.tabMutations, []);
  }
});

test("a Vintrack outage keeps the grant", async () => {
  for (const status of [404, 429, 502]) {
    const h = contextHarness({
      fetch: async () => response(status, { error: "Vintrack unavailable" }),
    });
    h.storage[grantKey] = storedGrant();
    const result = await h.context.performDomainSync("www.vinted.de");
    assert.equal(result.ok, false);
    assert.deepEqual(h.storage[grantKey], storedGrant());
  }
});

test("background context collection failures fall back to a successful token-only sync", async () => {
  const withoutDatadome = contextCookies().filter(
    ({ name }) => name !== "datadome",
  );
  const page = (payload) => ({
    onTabRefresh: (id, message) =>
      message.type === "VINTRACK_GET_CHECKOUT_CONTEXT" ? payload : undefined,
  });
  for (const [name, options] of [
    ["no open Vinted tab", { tabs: [] }],
    [
      "tab still loading",
      { tabs: [{ id: 7, url: "https://www.vinted.de/", status: "loading" }] },
    ],
    [
      "private window tab",
      { tabs: [{ id: 7, url: "https://www.vinted.de/", incognito: true }] },
    ],
    [
      "tab of another region",
      { tabs: [{ id: 7, url: "https://www.vinted.fr/" }] },
    ],
    ["page without CSRF token", page({ ok: false })],
    [
      "page signed in to another account",
      page({ ok: true, accountId: 99, csrfToken: "synthetic-csrf" }),
    ],
    ["missing datadome cookie", { cookies: withoutDatadome }],
    [
      "Firefox without the technical data permission",
      { firefox: true, cookies: contextCookies(".vinted.de", "firefox-default") },
    ],
  ]) {
    const h = contextHarness(options);
    h.storage[grantKey] = storedGrant();
    const results = await h.context.syncAndPersistAllDomains();
    assert.equal(results[0].ok, true, name);
    assert.equal(syncBodies(h).length, 1, name);
    assert.equal(syncBodies(h)[0].checkout_context, undefined, name);
    assert.equal(h.storage.vintrackLastSyncStatus, "ok", name);
    assert.deepEqual(h.tabMutations, [], name);
    assert.deepEqual(h.storage[grantKey], storedGrant(), name);
  }
});

test("a server refusal of the background context is retried as a token-only sync", async () => {
  const h = contextHarness({
    fetch: async (url, init) =>
      JSON.parse(init.body).checkout_context
        ? response(400, { error: "synthetic context refusal" })
        : response(200, { status: "completed", domain: "www.vinted.de" }),
  });
  h.storage[grantKey] = storedGrant();
  const results = await h.context.syncAndPersistAllDomains();
  assert.equal(results[0].ok, true);
  assert.deepEqual(
    syncBodies(h).map((body) => Boolean(body.checkout_context)),
    [true, false],
  );
  assert.equal(h.storage.vintrackLastSyncStatus, "ok");
  assert.deepEqual(h.storage[grantKey], storedGrant());
});

test("the revoke message clears the grant and later syncs stay token-only", async () => {
  const h = contextHarness();
  h.storage[grantKey] = storedGrant();
  const revoked = await send(h, { type: revokeType });
  assert.equal(revoked.ok, true);
  assert.equal(revoked.checkoutContextBackgroundSync, false);
  assert.equal(grantKey in h.storage, false);
  assert.equal(h.calls.length, 0);
  await h.context.syncAndPersistAllDomains();
  assert.equal(syncBodies(h)[0].checkout_context, undefined);
  assert.deepEqual(h.cookieReads, ["access_token_web"]);
  assert.deepEqual(h.tabMessages, []);
});

test("unauthorized senders can neither revoke nor create a background grant", async () => {
  for (const sender of [
    { url: "https://evil.test/account" },
    { url: "http://localhost:3000/account" },
    { url: "https://www.vinted.de/" },
    { url: "chrome-extension://foreign/popup.html" },
    {},
  ]) {
    const h = contextHarness();
    h.storage[grantKey] = storedGrant();
    const revoked = await send(h, { type: revokeType }, sender);
    assert.equal(revoked.ok, false);
    assert.equal(revoked.error, "Unauthorized extension sender");
    assert.deepEqual(h.storage[grantKey], storedGrant());

    delete h.storage[grantKey];
    h.context.ensureVintedBuyTab = async () => ({ tabId: 7 });
    const synced = await send(
      h,
      {
        type: "VINTRACK_EXTENSION_MANUAL_SYNC",
        payload: {
          preferredDomain: "www.vinted.de",
          includeCheckoutContext: true,
          checkoutContextConsent: 2,
        },
      },
      sender,
    );
    assert.equal(synced.ok, false);
    assert.equal(grantKey in h.storage, false);
    assert.equal(h.calls.length, 0);
    assert.equal(h.cookieReads.length, 0);
    assert.deepEqual(h.tabMessages, []);
  }
});

test("connecting another link or clearing the extension ends the grant", async () => {
  const relinked = contextHarness();
  relinked.storage[grantKey] = storedGrant();
  const connected = await send(relinked, {
    type: "VINTRACK_EXTENSION_CONNECT",
    payload: {
      token: "another-synthetic-link",
      appOrigin,
      preferredDomain: "www.vinted.de",
    },
  });
  assert.equal(connected.ok, true);
  assert.equal(connected.checkoutContextBackgroundSync, false);
  assert.equal(grantKey in relinked.storage, false);
  assert.equal(syncBodies(relinked)[0].checkout_context, undefined);

  const cleared = contextHarness();
  cleared.storage[grantKey] = storedGrant();
  const result = await send(
    cleared,
    { type: "VINTRACK_EXTENSION_CLEAR_LOCAL_STATE" },
    { url: "chrome-extension://synthetic-own/popup.html" },
  );
  assert.equal(result.ok, true);
  assert.equal(result.checkoutContextBackgroundSync, false);
  assert.equal(grantKey in cleared.storage, false);
});
