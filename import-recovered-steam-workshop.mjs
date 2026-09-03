import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { cleanSteamDescription, replaceCatalogItems } from "./mirror-main-workshop.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const ITEMS_PATH = join(ROOT, "items.json");
const CATALOG_PATH = join(ROOT, "cloudflare", "catalog.mjs");
const MAIN_MANIFEST_PATH = join(ROOT, "main-workshop-manifest.json");
const RECOVERY_MANIFEST_PATH = join(ROOT, "steam-recovery-manifest.json");
const CACHE_ROOT = join(ROOT, ".steam-recovery-cache");
const STATE_PATH = join(CACHE_ROOT, "state.json");
const LAST_ERROR_PATH = join(CACHE_ROOT, "last-error.txt");
const PREPARED_ROOT = join(CACHE_ROOT, "prepared");
const METADATA_ROOT = join(CACHE_ROOT, "metadata");
const HELPER_PATH = join(ROOT, "prepare-recovered-steam-item.ps1");
const STEAM_DETAILS_API = "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/";
const R2_BUCKET = "marble-race-workshop-content";
const R2_PUBLIC_BASE = "https://content.marble.kevin-kuhn.dev";
const MIRROR_SOURCE = "steam-recovery";
const RECOVERED_ID_FLOOR = 2000;

export function parseRecoveryArguments(argv) {
  const options = {
    downloads: join(homedir(), "Downloads"), report: null, plan: false,
    push: false, nonInteractive: false, maxItems: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--downloads") options.downloads = resolve(argv[++index]);
    else if (argument === "--report") options.report = resolve(argv[++index]);
    else if (argument === "--plan") options.plan = true;
    else if (argument === "--push") options.push = true;
    else if (argument === "--non-interactive") options.nonInteractive = true;
    else if (argument === "--max-items") {
      options.maxItems = Number(argv[++index]);
      if (!Number.isInteger(options.maxItems) || options.maxItems < 1) throw new Error("--max-items requires a positive integer.");
    } else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.plan && options.push) throw new Error("--plan cannot be combined with --push.");
  if (options.maxItems !== null && !options.plan) throw new Error("--max-items is limited to --plan so a partial recovery cannot be published accidentally.");
  return options;
}

export function assignRecoveredIds(existingItems, savedRecords, candidates, floor = RECOVERED_ID_FLOOR) {
  const used = new Set(existingItems.map((item) => Number(item.Id)));
  const saved = new Map(savedRecords.map((record) => [String(record.SteamWorkshopId), Number(record.Id)]));
  const result = new Map();
  let next = floor;
  for (const candidate of [...candidates].sort((left, right) => Number(left.steamId) - Number(right.steamId))) {
    const prior = saved.get(String(candidate.steamId));
    if (Number.isSafeInteger(prior) && prior >= floor && prior < 10000 && (!used.has(prior) || existingItems.some((item) => Number(item.Id) === prior && String(item.SteamWorkshopId) === String(candidate.steamId)))) {
      result.set(String(candidate.steamId), prior); used.add(prior); continue;
    }
    while (used.has(next) && next < 10000) next += 1;
    if (next >= 10000) throw new Error("The reserved recovered-item ID range 2000–9999 is full.");
    result.set(String(candidate.steamId), next); used.add(next); next += 1;
  }
  return result;
}

export function buildRecoveredItem(candidate, steam, prepared, record) {
  const tags = Array.isArray(steam.tags) ? steam.tags.map((entry) => String(entry?.tag ?? entry).trim()).filter(Boolean) : [];
  return {
    Id: Number(record.Id),
    Name: String(steam.title || candidate.embeddedName || `Steam item ${candidate.steamId}`).trim(),
    ResourceType: Number(prepared.ResourceType),
    TimeStamp: Number(steam.time_created || candidate.embeddedTimestamp || 0),
    AuthorId: String(steam.creator || "0"),
    AuthorName: String(candidate.embeddedAuthor || steam.author_name || "Unknown").trim() || "Unknown",
    PreviewUri: record.PreviewUri,
    PayloadUri: record.PayloadUri,
    Description: cleanSteamDescription(steam.description) || candidate.embeddedDescription || `Archived from Steam Workshop item ${candidate.steamId}.`,
    PayloadLength: Number(record.PayloadLength),
    Version: String(prepared.Version || candidate.embeddedVersion || "1.0.0"),
    Tags: tags.length ? tags : [resourceTypeName(prepared.ResourceType)],
    Downloads: Number(steam.subscriptions || 0),
    Rating: Number(steam.favorited || 0),
    MirrorSource: MIRROR_SOURCE,
    MirrorStatus: "active",
    SourcePayloadUri: `https://steamcommunity.com/sharedfiles/filedetails/?id=${candidate.steamId}`,
    SourcePreviewUri: String(steam.preview_url || ""),
    MirrorSourceTimestamp: Number(steam.time_created || candidate.embeddedTimestamp || 0),
    SteamWorkshopId: String(candidate.steamId),
    SteamAuthorId: String(steam.creator || "0"),
    SteamTimeUpdated: Number(steam.time_updated || 0),
    PayloadSha256: record.PayloadSha256,
    PreviewSha256: record.PreviewSha256,
    RecoveryArchiveName: basename(candidate.archivePath),
  };
}

async function main() {
  const options = parseRecoveryArguments(process.argv.slice(2));
  if (options.help) return printHelp();
  ensureCatalogFilesClean();
  await mkdir(PREPARED_ROOT, { recursive: true });
  await mkdir(METADATA_ROOT, { recursive: true });

  const reportPath = options.report || await findLatestReport(options.downloads);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const targetIds = new Set((report.missing || []).map(String));
  if (!targetIds.size) throw new Error("The selected recovery report contains no missing Steam IDs.");
  console.log(`Reading ${targetIds.size} recovered Steam item(s) from ${options.downloads} ...`);

  const [existingItems, mainManifest, recoveryManifest, state] = await Promise.all([
    readJson(ITEMS_PATH), readJson(MAIN_MANIFEST_PATH),
    readJsonIfExists(RECOVERY_MANIFEST_PATH, { SchemaVersion: 1, Items: [] }),
    readJsonIfExists(STATE_PATH, { SchemaVersion: 1, Items: [] }),
  ]);
  const alreadyMirrored = new Set((mainManifest.Items || []).map((item) => String(item.SteamWorkshopId)));
  const idsToRecover = [...targetIds].filter((id) => !alreadyMirrored.has(id));
  const allSteamDetails = await fetchSteamDetails(idsToRecover);
  const archives = await discoverArchives(options.downloads, targetIds, report.results || [], allSteamDetails);
  const candidates = [...archives.values()].filter((candidate) => !alreadyMirrored.has(candidate.steamId));
  const missingArchives = [...targetIds].filter((id) => !alreadyMirrored.has(id) && !archives.has(id));
  if (missingArchives.length) throw new Error(`No recovered ZIP was found for Steam ID(s): ${missingArchives.join(", ")}`);
  if (options.maxItems !== null) candidates.splice(options.maxItems);

  const steamDetails = new Map(candidates.map((candidate) => [candidate.steamId, allSteamDetails.get(candidate.steamId)]));
  await addAuthorNames(steamDetails);
  const idMap = assignRecoveredIds(existingItems, recoveryManifest.Items || [], candidates);
  for (const candidate of candidates) candidate.assignedId = idMap.get(candidate.steamId);

  const modern = candidates.filter((item) => item.format === "modern").length;
  const legacy = candidates.length - modern;
  console.log("\nRecovery import plan");
  console.log(`  Items:          ${candidates.length}`);
  console.log(`  Modern:         ${modern}`);
  console.log(`  Legacy convert: ${legacy}`);
  console.log(`  ID range:       ${Math.min(...candidates.map((item) => item.assignedId))}–${Math.max(...candidates.map((item) => item.assignedId))}`);
  console.log("  Dates:          original Steam creation dates");
  if (options.plan) return;
  if (!options.nonInteractive && !await askYesNo("Prepare and upload this recovered batch to R2?", false)) return;

  const stateMap = new Map((state.Items || []).map((record) => [String(record.SteamWorkshopId), record]));
  const finalRecords = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const steam = steamDetails.get(candidate.steamId) || {};
    console.log(`\n[${index + 1}/${candidates.length}] ${steam.title || candidate.embeddedName || candidate.steamId}`);
    const archiveSha = await hashFile(candidate.archivePath);
    let record = stateMap.get(candidate.steamId);
    if (!record || record.ArchiveSha256 !== archiveSha || Number(record.Id) !== candidate.assignedId || !existsSync(record.PreparedPayloadPath) || !existsSync(record.PreparedPreviewPath)) {
      record = await prepareCandidate(candidate, steam, archiveSha);
      stateMap.set(candidate.steamId, record);
      await writeState(stateMap);
    } else console.log("  Reusing prepared checkpoint.");
    if (!record.Uploaded) {
      uploadR2Object(record.PayloadKey, record.PreparedPayloadPath, "application/zip");
      uploadR2Object(record.PreviewKey, record.PreparedPreviewPath, record.PreviewContentType);
      record.Uploaded = true;
      stateMap.set(candidate.steamId, record);
      await writeState(stateMap);
    } else console.log("  Reusing R2 upload checkpoint.");
    finalRecords.push(record);
  }

  const preparedById = new Map(finalRecords.map((record) => [String(record.SteamWorkshopId), record]));
  const importedItems = candidates.map((candidate) => {
    const record = preparedById.get(candidate.steamId);
    return buildRecoveredItem(candidate, steamDetails.get(candidate.steamId) || {}, record.PreparedInfo, record);
  });
  const incomingIds = new Set(importedItems.map((item) => Number(item.Id)));
  const retained = existingItems.filter((item) => item.MirrorSource !== MIRROR_SOURCE || !incomingIds.has(Number(item.Id)));
  const merged = [...retained, ...importedItems].sort((left, right) => Number(left.Id) - Number(right.Id));
  const recordsBySteamId = new Map((recoveryManifest.Items || []).map((record) => [String(record.SteamWorkshopId), record]));
  for (const record of finalRecords) recordsBySteamId.set(String(record.SteamWorkshopId), publicManifestRecord(record));
  const finalManifest = { SchemaVersion: 1, GeneratedAt: new Date().toISOString(), ItemCount: recordsBySteamId.size, Items: [...recordsBySteamId.values()].sort((a, b) => Number(a.Id) - Number(b.Id)) };
  await updateCatalog(merged, finalManifest);
  console.log(`\nPrepared ${importedItems.length} recovered item(s). All tests passed.`);
  const shouldPush = options.push || (!options.nonInteractive && await askYesNo("Commit and deploy the recovered items now?", false));
  if (shouldPush) commitAndPush();
  else console.log("Catalog changes are local. Run this tool again with --push, or commit them when ready.");
}

async function discoverArchives(downloads, targetIds, reportResults, steamDetails) {
  const files = (await readdir(downloads, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".zip")
    .map((entry) => join(downloads, entry.name));
  const found = new Map();
  const filesByName = new Map(files.map((path) => [basename(path).toLocaleLowerCase(), path]));
  for (const [steamId, detail] of steamDetails) {
    const contentHandle = String(detail.hcontent_file || "");
    if (!/^\d+$/.test(contentHandle)) continue;
    const archivePath = filesByName.get(`depot_851640_${contentHandle}.zip`);
    if (!archivePath) continue;
    const candidate = inspectArchive(archivePath, steamId);
    if (candidate) found.set(steamId, candidate);
  }
  for (const result of reportResults) {
    const steamId = String(result.id || "");
    if (!result.ok || !targetIds.has(steamId) || !result.filename) continue;
    const exact = filesByName.get(basename(String(result.filename)).toLocaleLowerCase());
    const archivePath = exact || files
      .filter((path) => basename(path).toLocaleLowerCase().startsWith(`${basename(String(result.filename), extname(String(result.filename))).toLocaleLowerCase()} (`))
      .sort((left, right) => basename(right).localeCompare(basename(left)))[0];
    if (!archivePath) continue;
    const candidate = inspectArchive(archivePath, steamId);
    if (candidate) found.set(steamId, candidate);
  }
  for (const archivePath of files) {
    const candidate = inspectArchive(archivePath);
    if (!candidate || !targetIds.has(candidate.steamId)) continue;
    const current = found.get(candidate.steamId);
    if (!current || (await stat(archivePath)).mtimeMs > (await stat(current.archivePath)).mtimeMs) found.set(candidate.steamId, candidate);
  }
  return found;
}

function inspectArchive(archivePath, forcedSteamId = "") {
  const paths = listArchivePaths(archivePath);
  const infoPath = paths.find((entry) => /(^|\/)WorkshopItemInfo\.xml$/i.test(entry));
  const payloadPath = paths.find((entry) => /(^|\/)payload\.json$/i.test(entry));
  if (infoPath && payloadPath) {
    try {
      const info = readArchiveEntry(archivePath, infoPath);
      const payload = JSON.parse(readArchiveEntry(archivePath, payloadPath));
      const steamId = forcedSteamId || xmlValue(info, "PublishedFileId");
      if (!/^\d+$/.test(steamId)) return null;
      return {
        steamId, archivePath, format: "legacy", embeddedName: xmlValue(info, "Name"),
        embeddedDescription: xmlValue(info, "Description"), embeddedAuthor: String(payload.Author || ""),
        embeddedVersion: String(payload.AppVersion || "1.0.0"), embeddedTimestamp: 0,
      };
    } catch { return null; }
  }
  const rootPath = paths
    .filter((entry) => /(^|\/)(level|campaign|block)\.json$/i.test(entry))
    .sort((left, right) => {
      const depth = left.split("/").length - right.split("/").length;
      if (depth) return depth;
      const priority = (path) => /(^|\/)campaign\.json$/i.test(path) ? 0 : /(^|\/)level\.json$/i.test(path) ? 1 : 2;
      return priority(left) - priority(right);
    })[0];
  if (!rootPath) return null;
  try {
    const metadata = JSON.parse(readArchiveEntry(archivePath, rootPath));
    const steamId = forcedSteamId || String(metadata.WorkshopId || "");
    if (!/^\d+$/.test(steamId)) return null;
    return {
      steamId, archivePath, format: "modern", embeddedName: basename(dirname(rootPath)),
      embeddedDescription: String(metadata.Description || ""), embeddedAuthor: String(metadata.Author || ""),
      embeddedVersion: String(metadata.Version || "1.0.0"), embeddedTimestamp: Number(metadata.Timestamp || 0),
    };
  } catch { return null; }
}

function listArchivePaths(archivePath) {
  const result = run("7z", ["l", "-slt", "--", archivePath], { maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) return [];
  const body = result.output.includes("----------") ? result.output.split("----------").slice(1).join("----------") : result.output;
  return [...body.matchAll(/^Path = (.+)$/gm)].map((match) => match[1].trim().replaceAll("\\", "/"));
}

function readArchiveEntry(archivePath, entryPath) {
  const result = spawnSync("7z", ["e", "-so", "--", archivePath, entryPath], { cwd: ROOT, encoding: "utf8", windowsHide: true, maxBuffer: 128 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Could not read ${entryPath} from ${basename(archivePath)}.`);
  return result.stdout;
}

function xmlValue(xml, name) {
  const match = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`, "i"));
  return decodeXml(match?.[1] || "").trim();
}

function decodeXml(value) {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

async function fetchSteamDetails(ids) {
  const details = new Map();
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = ids.slice(offset, offset + 100);
    const body = new URLSearchParams({ itemcount: String(batch.length) });
    batch.forEach((id, index) => body.set(`publishedfileids[${index}]`, id));
    const response = await fetchWithRetry(STEAM_DETAILS_API, { method: "POST", body }, `Steam metadata batch ${offset / 100 + 1}`);
    const data = await response.json();
    for (const entry of data.response?.publishedfiledetails || []) if (Number(entry.result) === 1) details.set(String(entry.publishedfileid), entry);
  }
  const missing = ids.filter((id) => !details.has(String(id)));
  if (missing.length) throw new Error(`Steam metadata was unavailable for: ${missing.join(", ")}`);
  return details;
}

async function addAuthorNames(details) {
  const names = new Map();
  for (const detail of details.values()) {
    const creator = String(detail.creator || "0");
    if (names.has(creator)) { detail.author_name = names.get(creator); continue; }
    try {
      const response = await fetchWithRetry(`https://steamcommunity.com/profiles/${creator}?xml=1`, {}, `Steam profile ${creator}`);
      const name = xmlValue(await response.text(), "steamID") || "Unknown";
      names.set(creator, name); detail.author_name = name;
    } catch { names.set(creator, "Unknown"); detail.author_name = "Unknown"; }
  }
}

async function prepareCandidate(candidate, steam, archiveSha) {
  const id = candidate.assignedId;
  const itemRoot = join(PREPARED_ROOT, candidate.steamId);
  await mkdir(itemRoot, { recursive: true });
  const payloadPath = join(itemRoot, "payload.zip");
  const previewPath = join(itemRoot, "preview.bin");
  const infoPath = join(itemRoot, "prepared-info.json");
  const metadataPath = join(METADATA_ROOT, `${candidate.steamId}.json`);
  const tags = Array.isArray(steam.tags) ? steam.tags.map((entry) => String(entry?.tag || "")).filter(Boolean) : [];
  await writeFile(metadataPath, `${JSON.stringify({ ...steam, author_name: candidate.embeddedAuthor || steam.author_name || "Unknown", tags }, null, 2)}\n`, "utf8");
  let fallbackPreview = "";
  if (steam.preview_url) {
    fallbackPreview = join(itemRoot, "steam-preview.bin");
    const response = await fetchWithRetry(steam.preview_url, {}, `preview for ${candidate.steamId}`);
    await writeFile(fallbackPreview, Buffer.from(await response.arrayBuffer()));
  }
  const arguments_ = [
    "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", HELPER_PATH,
    "-ArchivePath", candidate.archivePath, "-MetadataPath", metadataPath,
    "-OutputZipPath", payloadPath, "-OutputPreviewPath", previewPath, "-OutputInfoPath", infoPath,
  ];
  if (fallbackPreview) arguments_.push("-FallbackPreviewPath", fallbackPreview);
  const prepared = run("powershell.exe", arguments_, { maxBuffer: 64 * 1024 * 1024 });
  if (prepared.status !== 0) throw new Error(`Could not prepare Steam item ${candidate.steamId}.\n${prepared.output}`);
  const [info, payloadStats] = await Promise.all([readJson(infoPath), stat(payloadPath)]);
  const previewType = await detectImage(previewPath);
  const timestamp = Number(steam.time_created || candidate.embeddedTimestamp || 0);
  const stem = `${id}-${timestamp || candidate.steamId}`;
  const payloadKey = `steam-recovery/payloads/${stem}.zip`;
  const previewKey = `steam-recovery/previews/${stem}.${previewType.extension}`;
  return {
    SteamWorkshopId: candidate.steamId, Id: id, ArchiveSha256: archiveSha,
    PreparedPayloadPath: payloadPath, PreparedPreviewPath: previewPath, PreparedInfo: info,
    PayloadKey: payloadKey, PreviewKey: previewKey,
    PayloadUri: `${R2_PUBLIC_BASE}/${payloadKey}`, PreviewUri: `${R2_PUBLIC_BASE}/${previewKey}`,
    PayloadLength: payloadStats.size, PayloadSha256: await hashFile(payloadPath), PreviewSha256: await hashFile(previewPath),
    PreviewContentType: previewType.contentType, Uploaded: false,
  };
}

async function detectImage(path) {
  const bytes = (await readFile(path)).subarray(0, 12);
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { extension: "png", contentType: "image/png" };
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { extension: "jpg", contentType: "image/jpeg" };
  throw new Error(`${basename(path)} is not a PNG or JPEG image.`);
}

function uploadR2Object(key, filePath, contentType) {
  const wrangler = join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
  if (!existsSync(wrangler)) throw new Error("Wrangler is not installed. Run npm install once.");
  console.log(`  Uploading ${key} ...`);
  const environment = { ...process.env };
  delete environment.CODEX_CI;
  const result = spawnSync(process.execPath, [wrangler, "r2", "object", "put", `${R2_BUCKET}/${key}`, "--file", filePath, "--content-type", contentType, "--cache-control", "public, max-age=31536000, immutable", "--remote"], {
    cwd: ROOT, env: environment, stdio: "inherit", windowsHide: false,
  });
  if (result.status !== 0) throw new Error(`R2 upload failed for ${key}. Run this tool again to resume.`);
}

async function updateCatalog(items, manifest) {
  const originalItems = await readFile(ITEMS_PATH, "utf8");
  const originalCatalog = await readFile(CATALOG_PATH, "utf8");
  const originalManifest = existsSync(RECOVERY_MANIFEST_PATH) ? await readFile(RECOVERY_MANIFEST_PATH, "utf8") : null;
  try {
    await writeFile(ITEMS_PATH, `${JSON.stringify(items, null, 2)}\n`, "utf8");
    await writeFile(CATALOG_PATH, replaceCatalogItems(originalCatalog, items), "utf8");
    await writeAtomic(RECOVERY_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
    const tests = run(process.execPath, ["--test"], { stdio: "inherit" });
    if (tests.status !== 0) throw new Error("Tests failed; catalog changes were rolled back.");
  } catch (error) {
    await writeFile(ITEMS_PATH, originalItems, "utf8");
    await writeFile(CATALOG_PATH, originalCatalog, "utf8");
    if (originalManifest === null) await rm(RECOVERY_MANIFEST_PATH, { force: true }); else await writeFile(RECOVERY_MANIFEST_PATH, originalManifest, "utf8");
    throw error;
  }
}

function publicManifestRecord(record) {
  const { PreparedPayloadPath: _payload, PreparedPreviewPath: _preview, PreparedInfo: _info, PreviewContentType: _type, Uploaded: _uploaded, ...publicRecord } = record;
  return publicRecord;
}

async function writeState(stateMap) {
  await mkdir(CACHE_ROOT, { recursive: true });
  await writeAtomic(STATE_PATH, `${JSON.stringify({ SchemaVersion: 1, Items: [...stateMap.values()] }, null, 2)}\n`);
}

function commitAndPush() {
  const files = ["items.json", "cloudflare/catalog.mjs", "steam-recovery-manifest.json"];
  requireRun("git", gitArgs(["add", "--", ...files]));
  requireRun("git", gitArgs(["commit", "--only", "-m", "Import recovered Steam workshop items", "--", ...files]));
  requireRun("git", gitArgs(["push", "origin", "HEAD"]));
  console.log("Recovered items were pushed to GitHub. Cloudflare will deploy the updated catalog.");
}

function ensureCatalogFilesClean() {
  const files = ["items.json", "cloudflare/catalog.mjs", "steam-recovery-manifest.json"];
  const result = run("git", gitArgs(["status", "--porcelain", "--", ...files]));
  if (result.status !== 0) throw new Error(`Could not inspect the repository.\n${result.output}`);
  if (result.output.trim()) throw new Error("The catalog or recovery manifest has uncommitted changes. Finish those changes before running the recovery importer.");
}

function gitArgs(args) { return ["-c", `safe.directory=${ROOT.replaceAll("\\", "/")}`, "-C", ROOT, ...args]; }
function requireRun(command, args) { const result = run(command, args); if (result.status !== 0) throw new Error(`${command} failed.\n${result.output}`); }
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: "utf8", windowsHide: true, maxBuffer: options.maxBuffer || 16 * 1024 * 1024, stdio: options.stdio || "pipe" });
  return { status: result.status ?? 1, output: `${result.stdout || ""}${result.stderr || ""}` };
}

async function hashFile(path) { const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex"); }
async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }
async function readJsonIfExists(path, fallback) { return existsSync(path) ? readJson(path) : fallback; }
async function writeAtomic(path, content) { const temporary = `${path}.${randomUUID()}.tmp`; await writeFile(temporary, content, "utf8"); await rename(temporary, path); }
async function fetchWithRetry(url, options, label) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, { ...options, headers: { "user-agent": "MarbleRacePreservationImporter/1.0", ...(options.headers || {}) } });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return response;
    } catch (error) { lastError = error; if (attempt < 4) await new Promise((resolvePromise) => setTimeout(resolvePromise, 500 * (2 ** (attempt - 1)))); }
  }
  throw new Error(`Could not fetch ${label}: ${lastError?.message || lastError}`);
}

async function findLatestReport(downloads) {
  const reports = (await readdir(downloads, { withFileTypes: true })).filter((entry) => entry.isFile() && /^marble-race-steam-recovery-report.*\.json$/i.test(entry.name));
  if (!reports.length) throw new Error("No marble-race-steam-recovery-report JSON file was found in Downloads.");
  const withTimes = await Promise.all(reports.map(async (entry) => ({ path: join(downloads, entry.name), time: (await stat(join(downloads, entry.name))).mtimeMs })));
  return withTimes.sort((left, right) => right.time - left.time)[0].path;
}

async function askYesNo(question, defaultValue) {
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try { const answer = (await reader.question(`${question} ${defaultValue ? "[Y/n]" : "[y/N]"}: `)).trim(); return answer ? /^y(?:es)?$/i.test(answer) : defaultValue; }
  finally { reader.close(); }
}

function resourceTypeName(value) { return ["level", "block", "campaign"][Number(value)] || "workshop"; }
function printHelp() {
  console.log(`Recovered Steam workshop importer

Options:
  --plan                 Inventory only; no conversion, uploads, or changes
  --downloads PATH       Folder containing recovered ZIPs (default: Downloads)
  --report PATH          Recovery report JSON (default: newest in Downloads)
  --max-items N          Limit a test/plan run to N items
  --non-interactive      Do not ask questions
  --push                 Commit and push after a successful import
  --help                 Show this help`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === resolve(fileURLToPath(import.meta.url))) main().catch(async (error) => {
  const message = `Recovery import failed: ${error.stack || error.message || error}\n`;
  try { await mkdir(CACHE_ROOT, { recursive: true }); await writeFile(LAST_ERROR_PATH, message, "utf8"); } catch {}
  console.error(`\n${message.trim()}`);
  console.error(`The error was also saved to ${LAST_ERROR_PATH}`);
  console.error("Prepared files and successful R2 uploads were checkpointed. Run the tool again to resume.");
  process.exitCode = 1;
});
