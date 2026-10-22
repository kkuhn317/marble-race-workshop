import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprintItem, isReusableFingerprint } from "./scan-workshop-duplicates.mjs";
import { refreshCampaignLinks } from "./build-campaign-links.mjs";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const CACHE = resolve(ROOT, ".duplicate-scan-cache/fingerprints.json");

export function pendingCampaignItems(items, records) {
  const cached = new Map(records.map((record) => [Number(record.ItemId), record]));
  return items.filter((item) => [0, 2].includes(item.ResourceType)
    && !isReusableFingerprint(cached.get(Number(item.Id)), item));
}

async function main() {
  const items = JSON.parse(await readFile(resolve(ROOT, "items.json"), "utf8"));
  let state;
  try { state = JSON.parse(await readFile(CACHE, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; state = { SchemaVersion: 1, Records: [] }; }
  const records = new Map(state.Records.map((record) => [Number(record.ItemId), record]));
  const pending = pendingCampaignItems(items, state.Records);
  console.log(`${pending.length} new or changed archives to scan. Unchanged items will use their existing fingerprints.`);
  await mkdir(resolve(ROOT, ".duplicate-scan-cache"), { recursive: true });
  let failed = 0;
  for (const [index, item] of pending.entries()) {
    console.log(`[${index + 1}/${pending.length}] ${item.Name} (#${item.Id}): scanning...`);
    try {
      records.set(Number(item.Id), await fingerprintItem(item));
      await writeFile(`${CACHE}.tmp`, `${JSON.stringify({ SchemaVersion: 1, UpdatedAt: new Date().toISOString(), Records: [...records.values()] }, null, 2)}\n`);
      await rename(`${CACHE}.tmp`, CACHE);
    } catch (error) {
      failed += 1;
      console.error(`Could not scan #${item.Id}: ${error.message}. It will be retried next time.`);
    }
  }
  await refreshCampaignLinks();
  if (failed) { console.error(`${failed} archives could not be scanned. Existing links were kept.`); process.exitCode = 1; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
