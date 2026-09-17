import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const items = JSON.parse(fs.readFileSync(path.join(root, "items.json"), "utf8"));
const rows = items
  .map((item) => [Number(item.Id), Math.max(0, Number(item.Downloads) || 0)])
  .filter(([id]) => Number.isSafeInteger(id))
  .sort((left, right) => left[0] - right[0]);
const statements = [
  "CREATE TABLE IF NOT EXISTS download_counts (",
  "  item_id INTEGER PRIMARY KEY,",
  "  downloads INTEGER NOT NULL DEFAULT 0 CHECK (downloads >= 0),",
  "  updated_at INTEGER NOT NULL DEFAULT (unixepoch())",
  ");",
  "",
];
for (let index = 0; index < rows.length; index += 100) {
  const values = rows.slice(index, index + 100).map(([id, downloads]) => `(${id}, ${downloads}, unixepoch())`);
  statements.push(
    "INSERT INTO download_counts (item_id, downloads, updated_at) VALUES",
    `  ${values.join(",\n  ")}`,
    "ON CONFLICT(item_id) DO UPDATE SET downloads = MAX(download_counts.downloads, excluded.downloads);",
    "",
  );
}
const outputPath = path.join(root, "migrations", "0001_seed_download_counts.sql");
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${statements.join("\n")}\n`);
console.log(`Wrote ${outputPath} with ${rows.length} seeded counters.`);
