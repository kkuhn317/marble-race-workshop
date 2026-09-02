import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const REPO_ROOT = dirname(fileURLToPath(import.meta.url));
const ITEMS_PATH = join(REPO_ROOT, "items.json");
const TEMPLATE_PATH = join(REPO_ROOT, "duplicate-review-template.html");
const REPORT_PATH = join(REPO_ROOT, "duplicate-review.html");
const CACHE_ROOT = join(REPO_ROOT, ".duplicate-scan-cache");
const STATE_PATH = join(CACHE_ROOT, "fingerprints.json");
const MIN_LAYOUT_TOKENS = 4;
const MIN_NEAR_TOKENS = 20;
const NEAR_THRESHOLD = 0.9;
const MINHASH_SEEDS = Array.from({ length: 20 }, (_, index) => 0x9e3779b1 ^ Math.imul(index + 1, 0x85ebca6b));

export function parseArguments(argv) {
  const options = { includeCustom: false, reportOnly: false, limit: null, itemIds: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--include-custom") options.includeCustom = true;
    else if (argument === "--report-only") options.reportOnly = true;
    else if (argument === "--limit") {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < 1) throw new Error("--limit requires a positive integer.");
      options.limit = value;
    } else if (argument === "--item-id") {
      const value = Number(argv[++index]);
      if (!Number.isSafeInteger(value) || value < 1) throw new Error("--item-id requires a positive integer.");
      options.itemIds.push(value);
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

export function canonicalize(value, depth = 0) {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry, depth + 1));
  if (!value || typeof value !== "object") return value;
  const ignored = new Set(["WorkshopId", "Timestamp", "Author", "Description", "ThumbnailPath", "Version", "GUID"]);
  return Object.fromEntries(Object.keys(value).sort().flatMap((key) => {
    if (ignored.has(key) || (depth === 0 && key === "Id")) return [];
    return [[key, canonicalize(value[key], depth + 1)]];
  }));
}

export function extractLayoutTokens(level) {
  const tokens = [];
  walk(level?.BlockGroups, (item) => {
    if (!item || typeof item !== "object") return;
    const attributes = Object.fromEntries(Object.entries(item.Attributes || {})
      .filter(([key]) => !/(?:renderer|material|texture|audio|music|_uv)/i.test(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, String(value).replace(/\b[0-9a-f]{8}\b/gi, "<guid>")]));
    tokens.push(stableStringify({ ID: item.ID || item.Name || "", Attributes: attributes }));
  });
  return [...new Set(tokens)].sort();
}

export function jaccard(left, right) {
  const a = new Set(left);
  const b = new Set(right);
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function buildMatches(items, records) {
  const byId = new Map(items.map((item) => [Number(item.Id), item]));
  const matches = [];
  const coveredPairs = new Set();

  const payloadGroups = groupBy(records, (record) => record.PayloadSha256);
  for (const recordsInGroup of payloadGroups.values()) {
    const ids = uniqueIds(recordsInGroup);
    if (ids.length < 2) continue;
    matches.push(makeMatch("exact-payload", 100, "Identical archive files", ids, [], byId));
    addCoveredPairs(coveredPairs, ids);
  }

  const components = records.flatMap((record) => record.Components || [])
    .filter((component) => component.Kind === "level" && component.TokenCount >= MIN_LAYOUT_TOKENS);
  const exactGroups = groupBy(components, (component) => component.CanonicalHash);
  for (const group of exactGroups.values()) {
    const ids = uniqueIds(group);
    if (ids.length < 2 || allPairsCovered(coveredPairs, ids)) continue;
    matches.push(makeMatch(
      "exact-content", 98, "Same level content after author, workshop, preview, version, and GUID metadata are removed",
      ids, summarizeComponents(group), byId,
    ));
    addCoveredPairs(coveredPairs, ids);
  }

  const layoutGroups = groupBy(components, (component) => component.LayoutHash);
  for (const group of layoutGroups.values()) {
    const ids = uniqueIds(group);
    if (ids.length < 2 || allPairsCovered(coveredPairs, ids)) continue;
    matches.push(makeMatch(
      "exact-layout", 94, "Identical track objects and gameplay attributes; visual materials may differ",
      ids, summarizeComponents(group), byId,
    ));
    addCoveredPairs(coveredPairs, ids);
  }

  const nearComponents = components.filter((component) => component.TokenCount >= MIN_NEAR_TOKENS);
  const candidates = minhashCandidates(nearComponents);
  for (const [leftIndex, rightIndex] of candidates) {
    const left = nearComponents[leftIndex];
    const right = nearComponents[rightIndex];
    if (left.ItemId === right.ItemId) continue;
    const pairKey = idPair(left.ItemId, right.ItemId);
    if (coveredPairs.has(pairKey)) continue;
    const similarity = jaccard(left.LayoutTokens, right.LayoutTokens);
    if (similarity < NEAR_THRESHOLD) continue;
    matches.push(makeMatch(
      "near-layout", Math.round(75 + similarity * 20),
      `${Math.round(similarity * 100)}% of track objects and gameplay attributes match`,
      [left.ItemId, right.ItemId], summarizeComponents([left, right]), byId,
    ));
    coveredPairs.add(pairKey);
  }

  return matches
    .filter((match) => match.Items.length >= 2)
    .sort((left, right) => right.Confidence - left.Confidence
      || left.Items[0].TimeStamp - right.Items[0].TimeStamp
      || left.Key.localeCompare(right.Key));
}

export function makeFingerprintRecord(item, payloadSha256, components) {
  return {
    ItemId: Number(item.Id),
    PayloadUri: String(item.PayloadUri),
    PayloadLength: Number(item.PayloadLength),
    PayloadSha256: payloadSha256,
    Components: components,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(`Workshop duplicate scanner\n\nDouble-click scan-workshop-duplicates.bat for a full official-workshop scan.\n\nOptions:\n  --include-custom  Also compare your custom uploads\n  --report-only     Rebuild the review page from cached fingerprints\n  --item-id ID      Scan selected item ID (repeatable)\n  --limit N         Scan only the first N selected items\n  --help            Show this help`);
    return;
  }

  let items = JSON.parse(await readFile(ITEMS_PATH, "utf8"));
  if (!options.includeCustom) items = items.filter((item) => item.MirrorSource === "official-main");
  if (options.itemIds.length > 0) {
    const selected = new Set(options.itemIds);
    items = items.filter((item) => selected.has(Number(item.Id)));
  }
  if (options.limit !== null) items = items.slice(0, options.limit);
  if (items.length === 0) throw new Error("No workshop items matched the selected scan options.");

  await mkdir(CACHE_ROOT, { recursive: true });
  const state = await readJson(STATE_PATH, { SchemaVersion: 1, Records: [] });
  const stateById = new Map((state.Records || []).map((record) => [Number(record.ItemId), record]));
  const records = [];

  if (!options.reportOnly) {
    console.log(`Scanning ${items.length} workshop archive(s). Completed fingerprints will be reused if interrupted.`);
    let index = 0;
    for (const item of items) {
      index += 1;
      const cached = stateById.get(Number(item.Id));
      if (cached && cached.PayloadUri === item.PayloadUri && cached.PayloadLength === Number(item.PayloadLength)) {
        console.log(`[${index}/${items.length}] ${item.Name} (ID ${item.Id}): cached.`);
        records.push(cached);
        continue;
      }
      console.log(`[${index}/${items.length}] ${item.Name} (ID ${item.Id}): downloading and fingerprinting ...`);
      try {
        const record = await fingerprintItem(item);
        stateById.set(Number(item.Id), record);
        records.push(record);
        await writeJsonAtomic(STATE_PATH, {
          SchemaVersion: 1,
          UpdatedAt: new Date().toISOString(),
          Records: [...stateById.values()].sort((a, b) => a.ItemId - b.ItemId),
        });
      } catch (error) {
        console.error(`  Skipped: ${error.message}`);
      }
    }
  } else {
    for (const item of items) {
      const cached = stateById.get(Number(item.Id));
      if (cached) records.push(cached);
    }
  }

  const scannedItems = items.filter((item) => records.some((record) => record.ItemId === Number(item.Id)));
  const matches = buildMatches(scannedItems, records);
  const report = {
    SchemaVersion: 1,
    GeneratedAt: new Date().toISOString(),
    Scope: options.includeCustom ? "Official and custom workshop items" : "Official workshop items",
    Stats: {
      SelectedItems: items.length,
      ScannedItems: scannedItems.length,
      PotentialDuplicateGroups: matches.length,
      HighConfidenceGroups: matches.filter((match) => match.Confidence >= 94).length,
      CrossAuthorGroups: matches.filter((match) => match.DifferentAuthors).length,
    },
    Matches: matches,
  };
  await generateReport(report);
  console.log(`\nReview page created: ${REPORT_PATH}`);
  console.log(`${matches.length} potential duplicate group(s) found; ${report.Stats.HighConfidenceGroups} are high confidence.`);
}

async function fingerprintItem(item) {
  const workingRoot = join(tmpdir(), `marble-duplicate-${item.Id}-${randomUUID()}`);
  const zipPath = join(workingRoot, "payload.zip");
  const extractedRoot = join(workingRoot, "json");
  await mkdir(extractedRoot, { recursive: true });
  try {
    await download(item.PayloadUri, zipPath, Number(item.PayloadLength));
    const payloadSha256 = await hashFile(zipPath);
    const extracted = spawnSync("7z", ["x", "-y", `-o${extractedRoot}`, "-r", "--", zipPath, "*.json"], {
      cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    });
    if (extracted.error) throw extracted.error;
    if (extracted.status !== 0) throw new Error(`7-Zip extraction failed: ${extracted.stderr || extracted.stdout}`);
    const jsonFiles = await listFiles(extractedRoot);
    const components = [];
    for (const filePath of jsonFiles) {
      if (basename(filePath).toLowerCase() !== "level.json") continue;
      const fileStat = await stat(filePath);
      if (fileStat.size > 64 * 1024 * 1024) continue;
      try {
        const parsed = JSON.parse(await readFile(filePath, "utf8"));
        const layoutTokens = extractLayoutTokens(parsed);
        components.push({
          ItemId: Number(item.Id),
          Kind: "level",
          Path: relative(extractedRoot, filePath).replaceAll("\\", "/"),
          CanonicalHash: hashText(stableStringify(canonicalize(parsed))),
          LayoutHash: hashText(stableStringify(layoutTokens)),
          TokenCount: layoutTokens.length,
          LayoutTokens: layoutTokens,
          MinHash: minhash(layoutTokens),
        });
      } catch {
        // One malformed nested JSON file should not prevent scanning the archive.
      }
    }
    return makeFingerprintRecord(item, payloadSha256, components);
  } finally {
    await rm(workingRoot, { recursive: true, force: true });
  }
}

async function download(url, destination, expectedLength) {
  const partial = `${destination}.part`;
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await rm(partial, { force: true });
    try {
      const response = await fetch(url, { headers: { "user-agent": "MarbleRaceDuplicateScanner/1.0" } });
      if (!response.ok || !response.body) throw new Error(`${response.status} ${response.statusText}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
      const downloaded = await stat(partial);
      if (expectedLength > 0 && downloaded.size !== expectedLength) {
        throw new Error(`expected ${expectedLength} bytes, received ${downloaded.size}`);
      }
      await rename(partial, destination);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 4) await new Promise((resolvePromise) => setTimeout(resolvePromise, 500 * (2 ** (attempt - 1))));
    }
  }
  throw new Error(`download failed after four attempts: ${lastError?.message || lastError}`);
}

async function generateReport(report) {
  const template = await readFile(TEMPLATE_PATH, "utf8");
  const json = JSON.stringify(report).replaceAll("<", "\\u003c");
  if (!template.includes("/*__DUPLICATE_REPORT_DATA__*/")) throw new Error("Review template data marker is missing.");
  await writeFile(REPORT_PATH, template.replace("/*__DUPLICATE_REPORT_DATA__*/", json), "utf8");
}

function makeMatch(kind, confidence, reason, ids, components, byId) {
  const sortedIds = [...new Set(ids.map(Number))].sort((a, b) => a - b);
  const itemSummaries = sortedIds.map((id) => summarizeItem(byId.get(id))).filter(Boolean)
    .sort((left, right) => left.TimeStamp - right.TimeStamp || left.Id - right.Id);
  return {
    Key: `${kind}:${sortedIds.join("-")}`,
    Kind: kind,
    Confidence: confidence,
    Reason: reason,
    OldestItemId: itemSummaries[0]?.Id ?? null,
    DifferentAuthors: new Set(itemSummaries.map((item) => item.AuthorName.trim().toLowerCase())).size > 1,
    Items: itemSummaries,
    Components: components,
  };
}

function summarizeItem(item) {
  if (!item) return null;
  return {
    Id: Number(item.Id), Name: String(item.Name), AuthorName: String(item.AuthorName || "Unknown"),
    TimeStamp: Number(item.TimeStamp), ResourceType: Number(item.ResourceType),
    PreviewUri: String(item.PreviewUri || ""), SteamWorkshopId: item.SteamWorkshopId ? String(item.SteamWorkshopId) : null,
  };
}

function summarizeComponents(components) {
  return components.map((component) => ({ ItemId: component.ItemId, Path: component.Path, TokenCount: component.TokenCount }));
}

function minhashCandidates(components) {
  const buckets = new Map();
  const pairs = new Set();
  components.forEach((component, index) => {
    const signature = component.MinHash || minhash(component.LayoutTokens);
    for (let band = 0; band < 5; band += 1) {
      const key = `${band}:${signature.slice(band * 4, band * 4 + 4).join(",")}`;
      const existing = buckets.get(key) || [];
      for (const otherIndex of existing) pairs.add(`${Math.min(index, otherIndex)}:${Math.max(index, otherIndex)}`);
      existing.push(index);
      buckets.set(key, existing);
    }
  });
  return [...pairs].map((pair) => pair.split(":").map(Number));
}

function minhash(tokens) {
  if (!tokens.length) return MINHASH_SEEDS.map(() => 0xffffffff);
  return MINHASH_SEEDS.map((seed) => {
    let minimum = 0xffffffff;
    for (const token of tokens) minimum = Math.min(minimum, hash32(token, seed));
    return minimum >>> 0;
  });
}

function hash32(text, seed) {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function walk(value, visit) {
  if (Array.isArray(value)) {
    for (const entry of value) walk(entry, visit);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (value.Item) visit(value.Item);
  for (const entry of Object.values(value)) walk(entry, visit);
}

function stableStringify(value) {
  return JSON.stringify(value);
}

function hashText(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  const handle = await import("node:fs").then(({ createReadStream }) => createReadStream(filePath));
  for await (const chunk of handle) hash.update(chunk);
  return hash.digest("hex");
}

async function listFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile()) files.push(fullPath);
    }
  }
  await visit(root);
  return files;
}

function groupBy(values, keySelector) {
  const groups = new Map();
  for (const value of values) {
    const key = keySelector(value);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(value);
  }
  return groups;
}

function uniqueIds(values) {
  return [...new Set(values.map((value) => Number(value.ItemId)))].sort((a, b) => a - b);
}

function idPair(left, right) {
  return `${Math.min(Number(left), Number(right))}:${Math.max(Number(left), Number(right))}`;
}

function addCoveredPairs(target, ids) {
  for (let left = 0; left < ids.length; left += 1) {
    for (let right = left + 1; right < ids.length; right += 1) target.add(idPair(ids[left], ids[right]));
  }
}

function allPairsCovered(target, ids) {
  for (let left = 0; left < ids.length; left += 1) {
    for (let right = left + 1; right < ids.length; right += 1) {
      if (!target.has(idPair(ids[left], ids[right]))) return false;
    }
  }
  return true;
}

async function readJson(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rm(filePath, { force: true });
  await rename(temporary, filePath);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`\nDuplicate scan failed: ${error.message}`);
    process.exitCode = 1;
  });
}
