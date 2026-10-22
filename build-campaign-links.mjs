import { readFile, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import membership from "./campaign-membership.cjs";

const ROOT = fileURLToPath(new URL(".", import.meta.url));

export async function refreshCampaignLinks() {
  const items = JSON.parse(await readFile(resolve(ROOT, "items.json"), "utf8"));
  const cache = JSON.parse(await readFile(resolve(ROOT, ".duplicate-scan-cache/fingerprints.json"), "utf8"));
  const links = membership.buildCampaignMemberships(items, cache.Records || []);
  const destination = resolve(ROOT, "campaign-level-links.json");
  await writeFile(`${destination}.tmp`, `${JSON.stringify({ SchemaVersion: 1, Links: links }, null, 2)}\n`);
  await rename(`${destination}.tmp`, destination);
  console.log(`Updated campaign links: ${links.length} level/campaign matches. Publish changes in Workshop Manager to make them live.`);
  return links;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  refreshCampaignLinks().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
