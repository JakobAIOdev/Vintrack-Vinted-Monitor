import { readFile, writeFile } from "node:fs/promises";

const manifestPath = process.argv[2];
if (!manifestPath) {
  throw new Error("manifest path is required");
}

const developmentPatterns = [
  "http://localhost/*",
  "http://127.0.0.1/*",
];
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

manifest.name = `${manifest.name} (Development)`;
manifest.host_permissions = [
  ...developmentPatterns,
  ...manifest.host_permissions,
];
for (const contentScript of manifest.content_scripts || []) {
  contentScript.matches = [...developmentPatterns, ...contentScript.matches];
}

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 4)}\n`);
