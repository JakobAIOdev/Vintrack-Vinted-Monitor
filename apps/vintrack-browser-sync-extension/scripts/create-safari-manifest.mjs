import { readFile, writeFile } from "node:fs/promises";

const manifestPath = process.argv[2];
if (!manifestPath) throw new Error("manifest path is required");

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (!manifest.browser_specific_settings?.gecko || manifest.background?.service_worker) {
  throw new Error("Safari preview requires the Firefox event-page manifest");
}

manifest.name = `${manifest.name} (Safari Preview)`;
// Safari 18 adds access to HttpOnly cookies through the cookies API.
manifest.browser_specific_settings = { safari: { strict_min_version: "18.0" } };
manifest.background.persistent = false;
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 4)}\n`);
