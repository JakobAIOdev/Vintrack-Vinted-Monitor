# Browser extension setup

The extension is optional for catalog monitoring. It is needed to sync an
authorized Vinted browser session for linked-account actions. Install it on the
computer and browser where you use Vinted, even when Vintrack runs on a VPS.

Choose the instructions for your dashboard:

| Dashboard | Build to install |
| --- | --- |
| `https://vintrack.jakobaio.dev` | Public Chrome ZIP or signed Firefox add-on |
| `http://localhost:3000` or `http://127.0.0.1:3000` | Local development build |
| Your own HTTPS domain | Custom self-hosted build |

The popup has no server-URL setting. The extension checks both manifest
permissions and explicit origin allowlists in `background.js` and
`content-script.js`. Changing `AUTH_URL` or only editing a manifest does not
make the public extension work on a custom domain.

## Official demo

For Chrome:

1. Download the [Chrome ZIP](https://github.com/JakobAIOdev/Vintrack-Vinted-Monitor/releases/latest/download/vintrack-browser-sync-extension.zip).
2. Unzip it into a permanent folder on your computer.
3. Open `chrome://extensions`, enable **Developer mode**, and select **Load unpacked**.
4. Select the extracted folder containing `manifest.json`, following
   [Chrome's unpacked installation instructions](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked).
5. Reload any already-open Vintrack and Vinted pages, then follow
   [Link your account](#link-your-account).

For Firefox, install the [signed add-on from Mozilla](https://addons.mozilla.org/firefox/addon/vintrack-browser-sync/),
grant the requested permissions, reload already-open pages, and link your account.
The current Firefox manifest requires Firefox 142 or newer.

## Localhost

Run these commands from the repository root on your desktop computer. They
require Node.js, Bash and `zip`; Docker alone does not provide those host tools.

```bash
bash apps/vintrack-browser-sync-extension/scripts/build-packages.sh
```

For Chrome, use **Load unpacked** to select
`apps/vintrack-browser-sync-extension/dist/chrome-development`. It supports the
two localhost origins in the table, with port **3000**. The public ZIP and
`dist/chrome` do not have localhost permissions.

For Firefox, create a separate local copy and add the development permissions:

```bash
cp -R apps/vintrack-browser-sync-extension/dist/firefox apps/vintrack-browser-sync-extension/dist/firefox-development
node apps/vintrack-browser-sync-extension/scripts/create-development-manifest.mjs apps/vintrack-browser-sync-extension/dist/firefox-development/manifest.json
```

Start with a fresh `firefox-development` folder when repeating this step.
Open `about:debugging#/runtime/this-firefox`, select **Load Temporary Add-on**,
and choose `dist/firefox-development/manifest.json` inside the extension folder.
This installation is removed when Firefox restarts, as documented by
[Mozilla](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/).
Reload already-open pages before linking.

## Self-hosted domain

The public Chrome ZIP and AMO add-on only authorize the official dashboard.
Create a custom copy for the exact HTTPS origin used in your server's `AUTH_URL`.
Use a hostname with a valid HTTPS certificate and no subpath.

### 1. Build on your desktop computer

Clone the repository there if it only exists on your server. Check out the
release you run on the server. From the repository root:

```bash
bash apps/vintrack-browser-sync-extension/scripts/build-packages.sh
```

This validates the original extension and produces `dist/chrome` and
`dist/firefox`. Keep those originals as the inputs for the next step.

### 2. Create copies for your origin

Replace `https://vintrack.example.com` in the first line below with your exact
`AUTH_URL`. Paste the entire block into Bash or Zsh from the repository root.
It creates separate `chrome-selfhost` and `firefox-selfhost` folders, updating
the manifest and both JavaScript origin allowlists. It leaves Vinted permissions
unchanged and gives the Firefox copy a separate add-on ID.

```bash
node --input-type=module - https://vintrack.example.com <<'NODE'
import { cp, readFile, writeFile, access } from "node:fs/promises";
const url = new URL(process.argv[2]);
if (url.protocol !== "https:" || url.username || url.password ||
    url.pathname !== "/" || url.search || url.hash) {
  throw new Error("Use an HTTPS origin without credentials, path, query or fragment.");
}
const origin = url.origin;
const official = "https://vintrack.jakobaio.dev";
const root = "apps/vintrack-browser-sync-extension/dist";
for (const browser of ["chrome", "firefox"]) {
  const target = `${root}/${browser}-selfhost`;
  let exists = false;
  try { await access(target); exists = true; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (exists) throw new Error(`${target} already exists; move it aside before rebuilding.`);
  await cp(`${root}/${browser}`, target, { recursive: true });
  for (const file of ["background.js", "content-script.js", "manifest.json"]) {
    const path = `${target}/${file}`;
    const source = await readFile(path, "utf8");
    if (!source.includes(official)) throw new Error(`Expected origin missing in ${path}`);
    await writeFile(path, source.replaceAll(official, origin));
  }
  const path = `${target}/manifest.json`;
  const manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.name = `Vintrack Browser Sync (${url.hostname})`;
  if (browser === "firefox") {
    manifest.browser_specific_settings.gecko.id = `vintrack-browser-sync@${url.hostname}`;
  }
  await writeFile(path, `${JSON.stringify(manifest, null, 4)}\n`);
  console.log(`Created ${target} for ${origin}`);
}
NODE
```

Use exact hostnames; do not grant all websites with `<all_urls>` or wildcard
Vintrack origins. If you change the server's hostname or port later, regenerate
these copies. The release validation script targets the official build, so it
is run before customizing; browser detection and linking below verify your
custom origin.

### 3. Install in Chrome

1. Disable any other Vintrack extension in that browser to avoid duplicate syncs.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Select **Load unpacked** and choose
   `apps/vintrack-browser-sync-extension/dist/chrome-selfhost`.
4. Grant the required permissions and keep that folder in place.
5. Reload your dashboard and any open Vinted pages, then link your account below.

An unpacked build has no automatic release updates. For an update, build fresh
copies for the same origin, replace the contents at the installed folder path,
click **Reload** on the extension, and reload the dashboard and Vinted tabs.

### 4. Install in Firefox

For testing, open `about:debugging#/runtime/this-firefox`, select
**Load Temporary Add-on**, and choose
`apps/vintrack-browser-sync-extension/dist/firefox-selfhost/manifest.json`.
Grant permissions, reload both sites and link your account. Firefox removes
temporary add-ons on restart.

For a persistent Firefox Stable installation, submit your custom
`firefox-selfhost` build to Mozilla for **unlisted/self-distributed signing**,
using its separate add-on ID. Install the resulting signed `.xpi` through
**Add-ons and themes → gear menu → Install Add-on From File**. See Mozilla's
[signing overview](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)
and [self-distributed installation guide](https://extensionworkshop.com/documentation/publish/install-self-distributed/).
The build script does not sign custom Firefox packages. Editing a signed public
add-on invalidates its signature. For custom updates, increment the custom
manifest version and sign the new build with the same custom ID; arrange your
own update distribution or install the new signed file manually.

`BROWSER_EXTENSION_FIREFOX_URL` can point your dashboard's Firefox download link
at your own signed build. It does not change the extension's allowed origins.
The Chrome download link currently points at the project's public release ZIP;
provide your custom Chrome folder separately to users of your instance.

## Link your account

1. Sign in to your Vintrack dashboard with Discord or OIDC.
2. In the same browser profile, sign in to the Vinted regional site you intend
   to link, for example `https://www.vinted.de`.
3. Reload Vintrack and Vinted tabs that were open before extension installation.
4. Open **Account → Link With Installed Extension** on your own Vintrack instance
   and approve the connection. Allow Firefox site/data permissions when prompted.
5. Confirm **Account** shows the intended Vinted identity and browser-sync
   status. Open the extension popup and check its linked-account status too.

The browser must remain running for automatic maintenance. Login or security
prompts on Vinted may require you to open Vinted and sync again. Firefox
containers and private windows require an existing tab in that same context.
See the [privacy policy](browser-extension-privacy.md) for the limited session
information sent to your instance.

## If detection or linking fails

- **Extension not detected:** check that the loaded folder is the correct build,
  the dashboard origin matches both allowlists, and the manifest contains that
  host in `host_permissions` and `content_scripts[].matches`. Reload the
  extension and dashboard after changes.
- **Invalid Vintrack connection origin:** manifest permissions alone are
  insufficient; update both JavaScript allowlists as in the custom-build step.
- **Localhost fails:** use port 3000 and the development build; `http://localhost`
  without a port is not in the JavaScript allowlists.
- **Firefox stops syncing after restart:** a temporary installation was removed;
  reload it or install your signed custom build.
- **An older version is blocked:** compare the build's manifest version with
  the server's `BROWSER_EXTENSION_MIN_VERSION`; install a compatible build.

Developer validation, session-refresh details, and release publishing are
documented in the [extension README](../apps/vintrack-browser-sync-extension/README.md).
