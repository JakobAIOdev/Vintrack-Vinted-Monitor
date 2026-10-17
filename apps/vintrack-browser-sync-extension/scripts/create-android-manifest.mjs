import { readFile, writeFile } from "node:fs/promises";

const manifestPath = process.argv[2];
if (!manifestPath) throw new Error("manifest path is required");

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (!manifest.browser_specific_settings?.gecko || manifest.background?.service_worker) {
  throw new Error("Android preview requires the Firefox event-page manifest");
}

// Keep Android availability out of the listed release until device validation.
manifest.name = `${manifest.name} (Android Preview)`;
manifest.browser_specific_settings.gecko_android = {
  strict_min_version: "142.0",
};
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 4)}\n`);
