import { readFile, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import membership from "./campaign-membership.cjs";

const ROOT = fileURLToPath(new URL(".", import.meta.url));

export async function refreshCampaignLinks() {
  const items = JSON.parse(await readFile(resolve(ROOT, "items.json"), "utf8"));
  const cache = JSON.parse(await readFile(resolve(ROOT, ".duplicate-scan-cache/fingerprints.json"), "utf8"));
  const approvals = JSON.parse(await readFile(resolve(ROOT, "campaign-link-approvals.json"), "utf8"));
  const destination = resolve(ROOT, "campaign-level-links.json");
  const existing = JSON.parse(await readFile(destination, "utf8"));
  const candidates = membership.buildCampaignMemberships(items, cache.Records || [], approvals.Links || []);
  const links = membership.mergeCampaignMemberships(items, existing.Links || [], candidates, approvals.ExcludedPairs || []);
  const before = new Set((existing.Links || []).map((link) => `${link.LevelId}:${link.CampaignId}`));
  const added = links.filter((link) => !before.has(`${link.LevelId}:${link.CampaignId}`)).length;
  await writeFile(`${destination}.tmp`, `${JSON.stringify({ SchemaVersion: 1, Links: links }, null, 2)}\n`);
  await rename(`${destination}.tmp`, destination);
  console.log(`Campaign links: ${links.length} total; ${added} new. Existing links and review choices were preserved. Publish changes in Workshop Manager when ready.`);
  return links;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  refreshCampaignLinks().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
