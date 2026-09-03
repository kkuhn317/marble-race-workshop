import { readFile, writeFile } from "node:fs/promises";

const [levelPath, steamMetadataPath, blockPath, summaryPath] = process.argv.slice(2);
if (![levelPath, steamMetadataPath, blockPath, summaryPath].every(Boolean)) {
  throw new Error("Usage: node convert-transitional-level.mjs LEVEL STEAM BLOCK SUMMARY");
}

const [levelText, steamText] = await Promise.all([
  readFile(levelPath, "utf8"),
  readFile(steamMetadataPath, "utf8"),
]);
const level = JSON.parse(levelText);
const steam = JSON.parse(steamText);
if (!level.BlockGroups || typeof level.BlockGroups !== "object") {
  throw new Error("The level does not contain embedded BlockGroups.");
}

// A few early levels contain hundreds of nested empty containers. Traverse
// iteratively so conversion is not limited by Windows PowerShell's recursion.
const pending = [level.BlockGroups];
while (pending.length) {
  const node = pending.pop();
  if (!node || typeof node !== "object") continue;
  const attributes = node.Item?.Attributes;
  if (attributes && typeof attributes === "object" && !Array.isArray(attributes)) {
    node.Item.Attributes = Object.fromEntries(
      Object.entries(attributes).map(([key, value]) => [key.toLowerCase(), value]),
    );
  }
  if (Array.isArray(node.Children)) pending.push(...node.Children);
  for (const [key, value] of Object.entries(node)) {
    if (key !== "Children" && key !== "Item" && value && typeof value === "object") pending.push(value);
  }
}

const materials = Array.isArray(level.Materials) ? level.Materials : [];
const blockGroups = level.BlockGroups;
delete level.BlockGroups;
delete level.Materials;
level.WorkshopId = Number(steam.publishedfileid);
level.Timestamp = Number(steam.time_created || 0);
level.Author = String(steam.author_name || "Unknown");
level.Description = String(steam.description || "");
level.Tags = Array.isArray(steam.tags) ? steam.tags : [];
level.Version = String(level.Version || "1.0.0");
level.Type = "Level";

await Promise.all([
  writeFile(blockPath, `${JSON.stringify(blockGroups, null, 2)}\n`, "utf8"),
  writeFile(levelPath, `${JSON.stringify(level, null, 2)}\n`, "utf8"),
  writeFile(summaryPath, `${JSON.stringify({ Materials: materials }, null, 2)}\n`, "utf8"),
]);
