import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const extensionDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const productionAppPattern = "https://vintrack.jakobaio.dev/*";
const runtimeAppOrigins = [
  "https://vintrack.jakobaio.dev",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];
const vintedDomains = [
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
const vintedPatterns = vintedDomains.map((domain) => `https://*.${domain}/*`);

async function readJson(name) {
  return JSON.parse(await readFile(resolve(extensionDir, name), "utf8"));
}

function sorted(values) {
  return [...values].sort();
}

function assertManifestOrigins(manifest, name) {
  assert.ok(
    !JSON.stringify(manifest).includes("<all_urls>"),
    `${name} must not request <all_urls>`,
  );
  assert.deepEqual(
    sorted(manifest.host_permissions),
    sorted([productionAppPattern, ...vintedPatterns]),
    `${name} host_permissions differ from the production allowlist`,
  );
  assert.deepEqual(
    sorted(manifest.content_scripts[0].matches),
    sorted([productionAppPattern, ...vintedPatterns]),
    `${name} content-script matches differ from the production allowlist`,
  );
  assert.deepEqual(
    sorted(manifest.web_accessible_resources[0].matches),
    sorted(vintedPatterns),
    `${name} exposes the page bridge outside supported Vinted origins`,
  );
  assert.deepEqual(
    manifest.content_scripts[0].js,
    ["companion.js", "content-script.js"],
    `${name} must load the shared companion before the content script`,
  );
  assert.deepEqual(
    sorted(manifest.web_accessible_resources[0].resources),
    sorted(["page-bridge.js", "companion.css"]),
    `${name} must expose only the page bridge and companion stylesheet`,
  );
}

const chromeManifest = await readJson("manifest.json");
const firefoxManifest = await readJson("manifest.firefox.json");

assert.equal(
  chromeManifest.version,
  firefoxManifest.version,
  "Chrome and Firefox versions must be identical",
);
assert.match(chromeManifest.version, /^\d+(?:\.\d+){1,3}$/);
assertManifestOrigins(chromeManifest, "manifest.json");
assertManifestOrigins(firefoxManifest, "manifest.firefox.json");

const expectedTagArgumentIndex = process.argv.indexOf("--tag");
if (expectedTagArgumentIndex !== -1) {
  const tag = process.argv[expectedTagArgumentIndex + 1] || "";
  assert.equal(
    tag,
    `extension-v${chromeManifest.version}`,
    "Release tag must match both manifest versions",
  );
}

const developmentManifestArgumentIndex = process.argv.indexOf(
  "--development-manifest",
);
if (developmentManifestArgumentIndex !== -1) {
  const developmentManifestPath =
    process.argv[developmentManifestArgumentIndex + 1] || "";
  assert.ok(developmentManifestPath, "Development manifest path is required");
  const developmentManifest = JSON.parse(
    await readFile(resolve(developmentManifestPath), "utf8"),
  );
  const developmentPatterns = ["http://localhost/*", "http://127.0.0.1/*"];
  assert.equal(developmentManifest.version, chromeManifest.version);
  assert.match(developmentManifest.name, /\(Development\)$/);
  assert.deepEqual(
    sorted(developmentManifest.host_permissions),
    sorted([...developmentPatterns, productionAppPattern, ...vintedPatterns]),
    "Development host permissions differ from the explicit allowlist",
  );
  assert.deepEqual(
    sorted(developmentManifest.content_scripts[0].matches),
    sorted([...developmentPatterns, productionAppPattern, ...vintedPatterns]),
    "Development content-script matches differ from the explicit allowlist",
  );
}

assert.equal(
  firefoxManifest.browser_specific_settings?.gecko?.id,
  "vintrack-browser-sync@jakobaio.dev",
  "Firefox MV3 builds require a stable AMO add-on ID",
);
assert.equal(
  firefoxManifest.browser_specific_settings.gecko.strict_min_version,
  "142.0",
  "Firefox data-consent support requires Firefox 142 or newer",
);
assert.deepEqual(
  sorted(
    firefoxManifest.browser_specific_settings.gecko.data_collection_permissions
      .required,
  ),
  sorted([
    "authenticationInfo",
    "personallyIdentifyingInfo",
    "browsingActivity",
    "websiteContent",
  ]),
  "Firefox required data disclosures are incomplete",
);
assert.deepEqual(
  firefoxManifest.browser_specific_settings.gecko.data_collection_permissions
    .optional,
  ["technicalAndInteraction"],
  "Firefox technical data must remain optional",
);

const background = await readFile(
  resolve(extensionDir, "background.js"),
  "utf8",
);
const contentScript = await readFile(
  resolve(extensionDir, "content-script.js"),
  "utf8",
);
const companion = await readFile(resolve(extensionDir, "companion.js"), "utf8");
const iconSvg = await readFile(
  resolve(extensionDir, "icons/vintrack.svg"),
  "utf8",
);

for (const source of [background, contentScript]) {
  for (const origin of runtimeAppOrigins) {
    assert.ok(
      source.includes(`"${origin}"`),
      `Runtime app-origin allowlist is missing ${origin}`,
    );
  }
  assert.ok(
    !source.includes("/(^|\\.)vinted\\./"),
    "Runtime code must not accept arbitrary vinted.* domains",
  );
}

function isAllowedAppOrigin(value) {
  try {
    return runtimeAppOrigins.includes(new URL(value).origin);
  } catch {
    return false;
  }
}

function isSupportedVintedHost(value) {
  const hostname = String(value || "").toLowerCase();
  return vintedDomains.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
  );
}

assert.equal(isAllowedAppOrigin("https://vintrack.jakobaio.dev/account"), true);
assert.equal(isAllowedAppOrigin("http://localhost:3000/account"), true);
assert.equal(isAllowedAppOrigin("http://127.0.0.1:3000/account"), true);
for (const foreignOrigin of [
  "https://example.com",
  "https://vintrack.jakobaio.dev.example.com",
  "http://vintrack.jakobaio.dev",
  "http://localhost:3001",
]) {
  assert.equal(
    isAllowedAppOrigin(foreignOrigin),
    false,
    `Foreign app origin unexpectedly allowed: ${foreignOrigin}`,
  );
}
for (const domain of vintedDomains) {
  assert.equal(isSupportedVintedHost(domain), true);
  assert.equal(isSupportedVintedHost(`www.${domain}`), true);
}
for (const foreignHost of [
  "vinted.xyz",
  "evilvinted.de",
  "vinted.de.example.com",
]) {
  assert.equal(
    isSupportedVintedHost(foreignHost),
    false,
    `Foreign Vinted host unexpectedly allowed: ${foreignHost}`,
  );
}

for (const messageType of [
  "VINTRACK_EXTENSION_CONNECT",
  "VINTRACK_EXTENSION_MANUAL_SYNC",
  "VINTRACK_EXTENSION_BUY",
  "VINTRACK_EXTENSION_SET_THEME",
]) {
  assert.ok(
    background.includes(messageType),
    `${messageType} handler is missing`,
  );
}
assert.ok(
  background.includes(
    'storage.vintrackCompanionMode === "popup" ? "popup" : "inline"',
  ),
  "Inline companion must be the default unless popup-only was selected",
);
for (const messageType of [
  "VINTRACK_COMPANION_MODE",
  "VINTRACK_COMPANION_STATE",
  "VINTRACK_COMPANION_FEED",
  "VINTRACK_COMPANION_PRICE_WATCHES",
  "VINTRACK_COMPANION_WATCH_MUTATION",
  "VINTRACK_COMPANION_HANDOFF",
  "VINTRACK_COMPANION_SET_MODE",
]) {
  assert.ok(
    background.includes(messageType),
    `${messageType} handler is missing`,
  );
}
assert.ok(
  contentScript.includes('attachShadow({ mode: "closed" })'),
  "Inline companion must isolate its drawer in a closed Shadow DOM",
);
assert.ok(
  contentScript.includes('[data-testid^="catalog--"]') &&
    contentScript.includes('[data-testid$="-filter--trigger"]') &&
    contentScript.includes('[data-testid="item-desktops-only-container"]'),
  "Inline companion must use stable semantic Vinted anchors",
);
assert.ok(
  companion.includes("confirm(") &&
    companion.includes('"VINTRACK_COMPANION_WATCH_MUTATION"'),
  "Destructive Price Watch actions require an explicit confirmation",
);
assert.ok(
  !companion.includes("VINTRACK_EXTENSION_BUY"),
  "Wave 4 companion must not expose the experimental checkout flow",
);
assert.ok(
  !companion.includes("LATEST FIND") &&
    !background.includes("VINTRACK_COMPANION_OPEN_VINTED"),
  "Overview must not restore the removed Latest Find action",
);
assert.ok(
  companion.includes("Create monitor for this search") &&
    companion.includes("Copy clean search link") &&
    contentScript.includes('event.code !== "KeyV"') &&
    companion.includes("handleStorageThemeChange") &&
    companion.includes("applyTheme(state.theme)") &&
    companion.includes("Option + Shift + V") &&
    companion.includes("startLiveFeed") &&
    contentScript.includes("function vintrackMark()") &&
    contentScript.includes("M16 15h10l6 23 6-23h10L38 49H26L16 15Z"),
  "Companion logo, platform shortcut, live feed, actions, or theme binding are missing",
);
assert.ok(
  iconSvg.includes("M16 15h10l6 23 6-23h10L38 49H26L16 15Z") &&
    !iconSvg.includes("#38BDF8"),
  "Extension icons must use the canonical Vintrack mark",
);
assert.ok(
  background.match(/isAllowedAppSender\(sender/g)?.length >= 4,
  "Sensitive runtime commands must validate sender.url",
);
assert.ok(
  contentScript.includes("if (!isVintrackAppOrigin(window.location.origin))"),
  "Content-script bridge must reject foreign app origins",
);
assert.ok(
  background.includes('autoRecoveryNextAt: "vintrackAutoRecoveryNextAt"'),
  "Auto-recovery cooldown state is missing",
);
assert.ok(
  background.includes("AUTO_RECOVERY_FAILURE_COOLDOWN_MS"),
  "Auto-recovery must apply a bounded failure cooldown",
);
assert.ok(
  background.includes("active: false"),
  "Session recovery must use an inactive Vinted tab",
);
assert.ok(
  background.includes("tabs.remove(recoveryTabId)"),
  "Temporary Vinted recovery tabs must be closed",
);
assert.ok(
  background.includes('result.reason === "no-open-vinted-tab"'),
  "Manual sync must recover when no Vinted tab is open",
);
assert.ok(
  background.includes("bypassAutoRecoveryCooldown: true"),
  "Explicit connect and sync actions must bypass the periodic cooldown",
);

console.log(`Extension validation passed for v${chromeManifest.version}`);
