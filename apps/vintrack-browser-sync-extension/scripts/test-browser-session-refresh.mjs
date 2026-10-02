import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(join(root, "apps/control-center/package.json"));
const { chromium } = require("playwright");
const extensionDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const browserArgument = process.argv.find((value) =>
  value.startsWith("--browser="),
);
const browsers = browserArgument
  ? [browserArgument.split("=")[1]]
  : ["chromium", "firefox"];
for (const browser of browsers)
  assert.ok(["chromium", "firefox"].includes(browser));

function syntheticToken(seconds, issuedAt) {
  const claims = {
    exp: Math.floor(Date.now() / 1000) + seconds,
    iat: issuedAt,
    sub: "42",
  };
  return (
    "synthetic." +
    Buffer.from(JSON.stringify(claims)).toString("base64url") +
    ".signature"
  );
}

async function listen(server) {
  await new Promise((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen),
  );
  return server.address().port;
}

async function startFixture(directory) {
  const keyPath = join(directory, "key.pem"),
    certPath = join(directory, "cert.pem");
  const caKey = join(directory, "ca-key.pem"),
    caPath = join(directory, "ca.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      caKey,
      "-out",
      caPath,
      "-days",
      "1",
      "-subj",
      "/CN=Vintrack isolated test CA",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
    ],
    { stdio: "ignore" },
  );
  const csrPath = join(directory, "server.csr"),
    extensionsPath = join(directory, "server.ext");
  execFileSync(
    "openssl",
    [
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      csrPath,
      "-subj",
      "/CN=www.vinted.de",
    ],
    { stdio: "ignore" },
  );
  await writeFile(
    extensionsPath,
    "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:www.vinted.de,DNS:vintrack.jakobaio.dev\n",
  );
  execFileSync(
    "openssl",
    [
      "x509",
      "-req",
      "-in",
      csrPath,
      "-CA",
      caPath,
      "-CAkey",
      caKey,
      "-CAcreateserial",
      "-out",
      certPath,
      "-days",
      "1",
      "-extfile",
      extensionsPath,
    ],
    { stdio: "ignore" },
  );
  const certificate = await readFile(certPath, "utf8"),
    caCertificate = await readFile(caPath, "utf8");
  const requests = [];
  const fixture = {
    status: 200,
    rotate: true,
    csrfFormat: "flight",
    freshToken: "",
    requests,
    connections: { accepted: 0, rejected: 0, tlsErrors: [] },
  };
  const server = https.createServer(
    { key: await readFile(keyPath), cert: certificate },
    (req, res) => {
      const host = req.headers.host?.split(":")[0];
      res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "X-Csrf-Token, Content-Type",
      );
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      requests.push({
        host,
        path: req.url,
        method: req.method,
        fromVintedPage: req.headers.origin === "https://www.vinted.de",
        refreshCookieSent: (req.headers.cookie || "").includes(
          "refresh_token_web=synthetic-refresh",
        ),
        csrfHeader: req.headers["x-csrf-token"] === "synthetic-csrf",
        containerCookieSent: (req.headers.cookie || "").includes(
          "test_context=container",
        ),
      });
      if (
        host === "www.vinted.de" &&
        (req.url === "/" || req.url.startsWith("/items/"))
      ) {
        res.setHeader("Content-Type", "text/html");
        const csrf =
          fixture.csrfFormat === "flight"
            ? "<script>self.__next_f=[];self.__next_f.push([1," +
              JSON.stringify(JSON.stringify({ CSRF_TOKEN: "synthetic-csrf" })) +
              "])</script>"
            : '<meta name="csrf-token" content="synthetic-csrf">';
        res.end(
          "<!doctype html><html><head>" +
            csrf +
            "</head><body>Isolated Vinted fixture</body></html>",
        );
      } else if (
        host === "www.vinted.de" &&
        req.url === "/web/api/auth/refresh"
      ) {
        res.statusCode = fixture.status;
        if (fixture.status === 429) res.setHeader("Retry-After", "900");
        if (fixture.status === 200 && fixture.rotate) {
          res.setHeader(
            "Set-Cookie",
            "access_token_web=" +
              fixture.freshToken +
              "; Domain=.vinted.de; Path=/; Secure; SameSite=Strict",
          );
        }
        res.setHeader("Content-Type", "application/json");
        res.end("{}");
      } else if (
        host === "vintrack.jakobaio.dev" &&
        req.url === "/api/account/extension-sync/complete"
      ) {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({ status: "completed", domain: "www.vinted.de" }),
        );
      } else {
        res.statusCode = 404;
        res.end();
      }
    },
  );
  server.on("tlsClientError", (error) =>
    fixture.connections.tlsErrors.push(error.code),
  );
  const serverPort = await listen(server);
  const sockets = new Set();
  const proxy = http.createServer((req, res) => {
    res.writeHead(502);
    res.end();
  });
  proxy.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    // Browser startup probes can reset connections rejected by the allowlist.
    socket.on("error", () => socket.destroy());
  });
  proxy.on("connect", (req, socket, head) => {
    // Nothing in a test profile can reach a real Vinted/Vintrack endpoint.
    if (!["www.vinted.de:443", "vintrack.jakobaio.dev:443"].includes(req.url)) {
      fixture.connections.rejected++;
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    fixture.connections.accepted++;
    const upstream = net.connect(serverPort, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    for (const connection of [socket, upstream]) {
      sockets.add(connection);
      connection.on("close", () => sockets.delete(connection));
      connection.on("error", () => {
        socket.destroy();
        upstream.destroy();
      });
    }
  });
  const proxyPort = await listen(proxy);
  return {
    ...fixture,
    fixture,
    proxyPort,
    certificate: caCertificate,
    async close() {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      proxy.closeAllConnections();
      await Promise.all([
        new Promise((done) => server.close(done)),
        new Promise((done) => proxy.close(done)),
      ]);
    },
  };
}

async function chromeDriver(directory, proxyPort) {
  const source = join(extensionDir, "dist/chrome");
  const context = await chromium.launchPersistentContext(
    join(directory, "chrome-profile"),
    {
      channel: "chromium",
      headless: true,
      proxy: { server: "http://127.0.0.1:" + proxyPort },
      args: [
        "--ignore-certificate-errors",
        "--disable-extensions-except=" + source,
        "--load-extension=" + source,
      ],
    },
  );
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker", { timeout: 15000 }));
  return {
    evaluate: (expression) => worker.evaluate(expression),
    close: () => context.close(),
    defaultStoreId: "0",
  };
}

async function firefoxDriver(directory, proxyPort, certificate) {
  let webExtDirectory = process.env.VINTRACK_WEB_EXT_DIR;
  if (!webExtDirectory) {
    const executable = execFileSync("which", ["web-ext"], {
      encoding: "utf8",
    }).trim();
    webExtDirectory = resolve(dirname(await realpath(executable)), "..");
  }
  const moduleURL = (file) => pathToFileURL(join(webExtDirectory, file)).href;
  const app = await import(moduleURL("lib/firefox/index.js"));
  const { connectWithMaxRetries } = await import(
    moduleURL("lib/firefox/remote.js")
  );
  const profile = await app.createProfile({
    customPrefs: {
      "network.proxy.type": 1,
      "network.proxy.ssl": "127.0.0.1",
      "network.proxy.ssl_port": proxyPort,
      "network.proxy.http": "127.0.0.1",
      "network.proxy.http_port": proxyPort,
      "network.proxy.no_proxies_on": "",
      "privacy.userContext.enabled": true,
    },
  });
  let running, remote;
  try {
    running = await app.run(profile, {
      firefoxBinary:
        process.env.VINTRACK_FIREFOX_BINARY ||
        "/Applications/Firefox.app/Contents/MacOS/firefox",
      binaryArgs: ["-headless"],
    });
    remote = await connectWithMaxRetries({ port: running.debuggerPort });
    const client = remote.client,
      targets = [],
      evaluations = [];
    const handle = client._handleMessage.bind(client);
    client._handleMessage = (packet) => {
      if (packet.type === "evaluationResult") {
        evaluations.push(packet);
        return;
      }
      if (packet.type === "target-available-form") {
        targets.push(packet.target);
        if (!client._active.has(packet.from)) return;
      }
      handle(packet);
    };
    async function execute(consoleActor, text) {
      const { resultID } = await client.request({
        to: consoleActor,
        type: "evaluateJSAsync",
        text,
      });
      const started = Date.now();
      while (Date.now() - started < 35000) {
        const index = evaluations.findIndex(
          (packet) => packet.resultID === resultID,
        );
        if (index !== -1) {
          const packet = evaluations.splice(index, 1)[0];
          if (packet.hasException) throw new Error(packet.exceptionMessage);
          return packet.result;
        }
        await new Promise((done) => setTimeout(done, 20));
      }
      throw new Error("Firefox evaluation timed out");
    }
    async function evaluate(consoleActor, expression) {
      await execute(
        consoleActor,
        "globalThis.__vintrackNativeTestResult=undefined;Promise.resolve(" +
          expression +
          ").then(value=>{globalThis.__vintrackNativeTestResult=JSON.stringify({ok:true,value});}," +
          "error=>{globalThis.__vintrackNativeTestResult=JSON.stringify({ok:false,error:error.message});});'scheduled'",
      );
      const started = Date.now();
      while (Date.now() - started < 35000) {
        const serialized = await execute(
          consoleActor,
          "globalThis.__vintrackNativeTestResult || ''",
        );
        if (typeof serialized === "string" && serialized) {
          const result = JSON.parse(serialized);
          if (!result.ok) throw new Error(result.error);
          return result.value;
        }
        await new Promise((done) => setTimeout(done, 20));
      }
      throw new Error("Firefox async operation timed out");
    }
    const { processDescriptor } = await client.request({
      to: "root",
      type: "getProcess",
      id: 0,
    });
    const { process: parentTarget } = await client.request({
      to: processDescriptor.actor,
      type: "getTarget",
    });
    const certificateBase64 = certificate.replace(/-----[^-]+-----|\s/g, "");
    await evaluate(
      parentTarget.consoleActor,
      "JSON.stringify((()=>{const db=Cc['@mozilla.org/security/x509certdb;1'].getService(Ci.nsIX509CertDB);db.addCertFromBase64(" +
        JSON.stringify(certificateBase64) +
        ",'CT,,');return {trustedTestCertificate:true};})())",
    );
    await remote.installTemporaryAddon(join(extensionDir, "dist/firefox"));
    const addon = await remote.getInstalledAddon(
      "vintrack-browser-sync@jakobaio.dev",
    );
    const watcher = await client.request({
      to: addon.actor,
      type: "getWatcher",
    });
    await client.request({
      to: watcher.actor,
      type: "watchTargets",
      targetType: "frame",
    });
    const start = Date.now();
    while (
      !targets.some((target) => !target.isFallbackExtensionDocument) &&
      Date.now() - start < 10000
    ) {
      await new Promise((done) => setTimeout(done, 50));
    }
    const background = targets.find(
      (target) => !target.isFallbackExtensionDocument,
    );
    assert.ok(background, "Firefox background target missing");
    return {
      defaultStoreId: "firefox-default",
      evaluate: (expression) => evaluate(background.consoleActor, expression),
      async close() {
        remote.disconnect();
        const exited = new Promise((done) =>
          running.firefox.once("close", done),
        );
        running.firefox.kill();
        await exited;
        await rm(profile.path(), { recursive: true, force: true });
      },
    };
  } catch (error) {
    remote?.disconnect();
    if (running?.firefox) {
      const exited = new Promise((done) => running.firefox.once("close", done));
      running.firefox.kill();
      await exited;
    }
    await rm(profile.path(), { recursive: true, force: true });
    throw error;
  }
}

async function runBrowser(name, directory, transport) {
  let driver =
    name === "chromium"
      ? await chromeDriver(directory, transport.proxyPort)
      : await firefoxDriver(
          directory,
          transport.proxyPort,
          transport.certificate,
        );
  const fixture = transport.fixture;
  let sequence = 0;
  async function seed() {
    fixture.requests.length = 0;
    fixture.status = 200;
    fixture.rotate = true;
    fixture.csrfFormat = "flight";
    fixture.freshToken = syntheticToken(
      3600,
      Math.floor(Date.now() / 1000) + ++sequence,
    );
    const stale = syntheticToken(45, Math.floor(Date.now() / 1000) - 1);
    await driver.evaluate(
      "(async()=>{" +
        "await extensionApi.storage.local.clear();" +
        "await extensionApi.cookies.set({url:'https://www.vinted.de/',name:'access_token_web',value:" +
        JSON.stringify(stale) +
        ",domain:'.vinted.de',path:'/',secure:true,sameSite:'strict',storeId:" +
        JSON.stringify(driver.defaultStoreId) +
        "});" +
        "await extensionApi.cookies.set({url:'https://www.vinted.de/',name:'refresh_token_web',value:'synthetic-refresh',domain:'.vinted.de',path:'/',secure:true,httpOnly:true,sameSite:'strict',storeId:" +
        JSON.stringify(driver.defaultStoreId) +
        "});" +
        "for(const timer of syncTimers.values())clearTimeout(timer);syncTimers.clear();" +
        "await extensionApi.storage.local.set({browserLinkToken:'synthetic-link',vintrackAppOrigin:'https://vintrack.jakobaio.dev',vintrackSyncedDomains:['www.vinted.de']});return true;})()",
    );
  }
  const tabs = () =>
    driver.evaluate(
      "extensionApi.tabs.query({}).then(tabs=>tabs.map(({id,url,active})=>({id,url,active})))",
    );
  const refreshRequests = () =>
    fixture.requests.filter(
      (request) => request.path === "/web/api/auth/refresh",
    );
  try {
    await seed();
    const before = await tabs();
    const results = await driver.evaluate(
      "Promise.all([syncAndPersistAllDomains(),syncAndPersistAllDomains()])",
    );
    if (!results.every((result) => result[0].ok))
      console.log(
        JSON.stringify({
          browser: name,
          results,
          requests: fixture.requests,
          connections: fixture.connections,
          network: await driver.evaluate(
            "fetch(\'https://www.vinted.de/\').then(r=>({status:r.status})).catch(e=>({name:e.name,message:e.message}))",
          ),
        }),
      );
    assert.ok(
      results.every((result) => result[0].ok),
      name + ": native refresh failed",
    );
    assert.equal(refreshRequests().length, 1);
    assert.ok(
      refreshRequests()[0].refreshCookieSent,
      name + ": HttpOnly refresh cookie not sent",
    );
    assert.ok(refreshRequests()[0].csrfHeader, name + ": CSRF context missing");
    assert.deepEqual(await tabs(), before, name + ": refresh changed tabs");
    console.log(
      name + ": native background HTTPS/cookies/rotation/concurrency passed",
    );

    await seed();
    await driver.evaluate(
      "extensionApi.alarms.create('vintrackPeriodicSync',{when:Date.now()+250})",
    );
    const alarmStarted = Date.now();
    let alarmCompleted = false;
    while (Date.now() - alarmStarted < 20000) {
      alarmCompleted = await driver.evaluate(
        "extensionApi.storage.local.get('vintrackLastSyncStatus').then(state=>state.vintrackLastSyncStatus==='ok')",
      );
      if (alarmCompleted) break;
      await new Promise((done) => setTimeout(done, 100));
    }
    assert.ok(alarmCompleted, name + ": automatic alarm did not sync");
    assert.equal(refreshRequests().length, 1);
    assert.deepEqual(await tabs(), before);
    console.log(
      name + ": native alarm refreshes automatically without tabs passed",
    );

    await seed();
    fixture.status = 401;
    const failed = await driver.evaluate("syncAndPersistAllDomains()");
    assert.equal(failed[0].requiresUserAction, true);
    await driver.evaluate("syncAndPersistAllDomains()");
    assert.equal(refreshRequests().length, 1);
    assert.deepEqual(await tabs(), before);
    console.log(name + ": login failure stops without tab mutations passed");

    await seed();
    fixture.status = 429;
    await driver.evaluate("syncAndPersistAllDomains()");
    await driver.evaluate(
      "syncAndPersistPreferredOrAllDomains('www.vinted.de',{bypassAutoRecoveryCooldown:true})",
    );
    assert.equal(refreshRequests().length, 1);
    console.log(name + ": rate limit survives explicit retry passed");
    if (name === "chromium") {
      await driver.close();
      driver = await chromeDriver(directory, transport.proxyPort);
      await driver.evaluate("syncAndPersistAllDomains()");
      assert.equal(refreshRequests().length, 1);
      console.log(
        name + ": durable rate limit survives browser/worker restart passed",
      );
    }

    await seed();
    fixture.rotate = false;
    const unchanged = await driver.evaluate("syncAndPersistAllDomains()");
    assert.equal(unchanged[0].reason, "browser-token-not-rotated");
    console.log(
      name + ": success response without cookie rotation stays failed passed",
    );

    await seed();
    fixture.csrfFormat = "meta";
    const opened = await driver.evaluate(
      "extensionApi.tabs.create({url:'https://www.vinted.de/items/123',active:false}).then(tab=>({id:tab.id}))",
    );
    await driver.evaluate(
      "waitForTabLoad(" +
        opened.id +
        ").then(()=>waitForTabBridge(" +
        opened.id +
        ")).then(()=>true)",
    );
    const existing = await tabs();
    const pageResult = await driver.evaluate("syncAndPersistAllDomains()");
    assert.equal(pageResult[0].ok, true);
    assert.equal(refreshRequests().length, 1);
    assert.ok(
      refreshRequests()[0].fromVintedPage,
      name + ": page bridge was bypassed",
    );
    assert.deepEqual(await tabs(), existing);
    console.log(
      name + ": existing-tab page bridge without reload/navigation passed",
    );
    await driver.evaluate(
      "extensionApi.tabs.remove(" + opened.id + ").then(()=>true)",
    );
    if (name === "firefox") {
      await seed();
      fixture.csrfFormat = "meta";
      const container = await driver.evaluate(
        "extensionApi.tabs.create({url:'https://www.vinted.de/items/123',active:false,cookieStoreId:'firefox-container-1'}).then(tab=>({id:tab.id}))",
      );
      await driver.evaluate(
        "waitForTabLoad(" +
          container.id +
          ").then(()=>waitForTabBridge(" +
          container.id +
          ")).then(()=>true)",
      );
      const containerStale = syntheticToken(
        45,
        Math.floor(Date.now() / 1000) - 1,
      );
      await driver.evaluate(
        "extensionApi.cookies.set({url:'https://www.vinted.de/',name:'access_token_web',value:" +
          JSON.stringify(containerStale) +
          ",domain:'.vinted.de',path:'/',secure:true,sameSite:'strict',storeId:'firefox-container-1'}).then(()=>true)",
      );
      await driver.evaluate(
        "extensionApi.cookies.set({url:'https://www.vinted.de/',name:'refresh_token_web',value:'synthetic-refresh',domain:'.vinted.de',path:'/',secure:true,httpOnly:true,sameSite:'strict',storeId:'firefox-container-1'}).then(()=>true)",
      );
      await driver.evaluate(
        "extensionApi.cookies.set({url:'https://www.vinted.de/',name:'test_context',value:'container',domain:'.vinted.de',path:'/',secure:true,sameSite:'strict',storeId:'firefox-container-1'}).then(()=>true)",
      );
      const containerBefore = await tabs();
      fixture.requests.length = 0;
      const refreshed = await driver.evaluate(
        "refreshVintedBrowserSessions([{domain:'www.vinted.de',storeId:'firefox-container-1'}])",
      );
      assert.equal(refreshed[0].ok, true);
      assert.ok(
        refreshRequests().some((request) => request.containerCookieSent),
      );
      assert.ok(refreshRequests()[0].fromVintedPage);
      assert.deepEqual(await tabs(), containerBefore);
      console.log(
        name +
          ": open container refresh preserves its cookie store and tabs passed",
      );
      await driver.evaluate(
        "extensionApi.tabs.remove(" + container.id + ").then(()=>true)",
      );
      fixture.requests.length = 0;
      const closed = await driver.evaluate(
        "refreshVintedBrowserSessions([{domain:'www.vinted.de',storeId:'firefox-container-1'}])",
      );
      assert.equal(closed[0].reason, "browser-context-required");
      assert.equal(fixture.requests.length, 0);
      console.log(
        name +
          ": closed container never falls back to the default store passed",
      );
    }
  } finally {
    await driver.close();
  }
}

const directory = await mkdtemp(
  join(tmpdir(), "vintrack-browser-session-tests-"),
);
let transport;
try {
  transport = await startFixture(directory);
  for (const browser of browsers)
    await runBrowser(browser, directory, transport);
} finally {
  await transport?.close();
  await rm(directory, { recursive: true, force: true });
}
