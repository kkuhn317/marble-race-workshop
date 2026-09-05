import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInterface } from "node:readline/promises";
import { repairMojibakeText } from "./text-encoding.mjs";

const REPO_ROOT = dirname(fileURLToPath(import.meta.url));
const ITEMS_PATH = join(REPO_ROOT, "items.json");
const CATALOG_PATH = join(REPO_ROOT, "cloudflare", "catalog.mjs");
const MANIFEST_PATH = join(REPO_ROOT, "main-workshop-manifest.json");
const CACHE_ROOT = join(REPO_ROOT, ".mirror-cache");
const STATE_PATH = join(CACHE_ROOT, "main-workshop-state.json");
const DOWNLOAD_ROOT = join(CACHE_ROOT, "downloads");
const SOURCE_API = "https://marbleraceapi.azurewebsites.net/api";
const STEAM_DETAILS_API = "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/";
const STEAM_APP_ID = 851640;
const MIRROR_SOURCE = "official-main";
const R2_BUCKET = "marble-race-workshop-content";
const R2_PUBLIC_BASE = "https://content.marble.kevin-kuhn.dev";
const LIVE_API = "https://marble.kevin-kuhn.dev/api";
const PAGE_SIZE = 100;

export function parseArguments(argv) {
  const options = {
    planOnly: false,
    validateDownloads: false,
    nonInteractive: false,
    push: false,
    force: false,
    help: false,
    maxItems: null,
    itemIds: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--plan") options.planOnly = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--validate-downloads") options.validateDownloads = true;
    else if (argument === "--non-interactive") options.nonInteractive = true;
    else if (argument === "--push") options.push = true;
    else if (argument === "--force") options.force = true;
    else if (argument === "--max-items") {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < 1) throw new Error("--max-items requires a positive integer.");
      options.maxItems = value;
    } else if (argument === "--item-id") {
      const value = Number(argv[++index]);
      if (!Number.isSafeInteger(value) || value < 1) throw new Error("--item-id requires a positive integer.");
      options.itemIds.push(value);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (options.planOnly && options.validateDownloads) {
    throw new Error("Choose either --plan or --validate-downloads, not both.");
  }
  if ((options.maxItems !== null || options.itemIds.length > 0)
      && !options.planOnly && !options.validateDownloads) {
    throw new Error("--max-items and --item-id are limited to planning or download validation so a partial mirror cannot be published accidentally.");
  }
  if (options.push && (options.planOnly || options.validateDownloads)) {
    throw new Error("--push cannot be combined with a read-only mode.");
  }
  return options;
}

export function cleanSteamDescription(value) {
  if (typeof value !== "string") return "";
  return repairMojibakeText(value)
    .replace(/\[img\][\s\S]*?\[\/img\]/gi, "")
    .replace(/\[url=[^\]]*\]([\s\S]*?)\[\/url\]/gi, "$1")
    .replace(/\[url\]([\s\S]*?)\[\/url\]/gi, "$1")
    .replace(/\[\/?(?:b|i|u|s|h[1-6]|quote|code|spoiler|list|table|tr|td|th|noparse)(?:=[^\]]*)?\]/gi, "")
    .replace(/\[\*\]/g, "- ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\0/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function isSafeArchivePath(entryPath) {
  if (typeof entryPath !== "string" || entryPath.length === 0) return false;
  const normalized = entryPath.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[a-z]:/i.test(normalized)) return false;
  return !normalized.split("/").includes("..");
}

export function isReusableMirrorRecord(record, source) {
  return Boolean(record
    && Number(record.Id) === Number(source.Id)
    && Number(record.SourceTimeStamp) === Number(source.TimeStamp)
    && Number(record.PayloadLength) === Number(source.PayloadLength)
    && record.SourcePayloadUri === source.PayloadUri
    && record.SourcePreviewUri === source.PreviewUri
    && typeof record.PayloadUri === "string"
    && typeof record.PreviewUri === "string"
    && typeof record.PayloadSha256 === "string"
    && typeof record.PreviewSha256 === "string");
}

export function buildMirroredItem(source, steam, record) {
  const steamWorkshopId = /^\d+$/.test(String(source.Description || ""))
    ? String(source.Description)
    : null;
  const steamDescription = cleanSteamDescription(steam?.description);
  const description = steamDescription
    || (!steamWorkshopId ? String(source.Description || "").trim() : "")
    || `Archived from Steam Workshop item ${steamWorkshopId}. The original description is unavailable.`;
  const tags = Array.isArray(steam?.tags)
    ? steam.tags.map((entry) => String(entry?.tag || "").trim()).filter(Boolean)
    : [];

  return {
    Id: Number(source.Id),
    Name: repairMojibakeText(source.Name || steam?.title || "").trim(),
    ResourceType: Number(source.ResourceType),
    TimeStamp: Number(source.TimeStamp),
    // Steam IDs exceed JavaScript's safe integer range. Keep the exact digits
    // internally; the API serializer emits them as an unquoted JSON integer.
    AuthorId: String(steam?.creator || source.AuthorId || "0"),
    AuthorName: repairMojibakeText(source.AuthorName || "Unknown").trim() || "Unknown",
    PreviewUri: record.PreviewUri,
    PayloadUri: record.PayloadUri,
    Description: description,
    PayloadLength: Number(source.PayloadLength),
    Version: String(source.Version || "0.0"),
    Tags: tags.length > 0 ? tags : [resourceTypeName(source.ResourceType)],
    Downloads: Number(steam?.subscriptions || 0),
    Rating: Number(steam?.favorited || 0),
    MirrorSource: MIRROR_SOURCE,
    MirrorStatus: "active",
    SourcePayloadUri: String(source.PayloadUri),
    SourcePreviewUri: String(source.PreviewUri),
    MirrorSourceTimestamp: Number(source.TimeStamp),
    SteamWorkshopId: steamWorkshopId,
    SteamAuthorId: String(steam?.creator || source.AuthorId || "0"),
    SteamTimeUpdated: Number(steam?.time_updated || 0),
    PayloadSha256: record.PayloadSha256,
    PreviewSha256: record.PreviewSha256,
  };
}

export function mergeCatalog(existingItems, mirroredItems) {
  const incomingIds = new Set(mirroredItems.map((item) => Number(item.Id)));
  const customItems = existingItems.filter((item) => item.MirrorSource !== MIRROR_SOURCE);
  const collision = customItems.find((item) => incomingIds.has(Number(item.Id)));
  if (collision) {
    throw new Error(`Official item ID ${collision.Id} collides with the existing custom item '${collision.Name}'.`);
  }

  const missingMirrors = existingItems
    .filter((item) => item.MirrorSource === MIRROR_SOURCE && !incomingIds.has(Number(item.Id)))
    .map((item) => ({
      ...item,
      Name: repairMojibakeText(item.Name),
      AuthorName: repairMojibakeText(item.AuthorName).trim() || "Unknown",
      Description: repairMojibakeText(item.Description),
      MirrorStatus: "missing-from-source",
    }));
  const officialItems = [...mirroredItems, ...missingMirrors]
    .sort((left, right) => Number(left.Id) - Number(right.Id));
  return [...customItems, ...officialItems];
}

export function replaceCatalogItems(catalogSource, items) {
  const catalogPattern = /^export const items = \[[\s\S]*?\r?\n\];(?=\r?\n\r?\nexport function json)/;
  const updated = catalogSource.replace(catalogPattern, `export const items = ${JSON.stringify(items, null, 2)};`);
  if (updated === catalogSource) throw new Error("Could not locate the generated item array in cloudflare/catalog.mjs.");
  return updated;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  console.log("Reading the official Marble Race workshop catalog ...");
  let sourceItems = await fetchOfficialCatalog();
  if (options.itemIds.length > 0) {
    const selected = new Set(options.itemIds);
    sourceItems = sourceItems.filter((item) => selected.has(Number(item.Id)));
    const missing = options.itemIds.filter((id) => !sourceItems.some((item) => Number(item.Id) === id));
    if (missing.length > 0) throw new Error(`Official item IDs were not found: ${missing.join(", ")}`);
  }
  if (options.maxItems !== null) sourceItems = sourceItems.slice(0, options.maxItems);

  console.log(`Recovering Steam metadata for ${sourceItems.length} item(s) ...`);
  const steamDetails = await fetchSteamDetails(sourceItems);
  const existingItems = JSON.parse(await readFile(ITEMS_PATH, "utf8"));
  if (!Array.isArray(existingItems)) throw new Error("items.json must contain an array.");
  const manifest = await readJsonIfExists(MANIFEST_PATH, { Items: [] });
  const state = await readJsonIfExists(STATE_PATH, { SchemaVersion: 1, Items: [] });
  const records = new Map();
  for (const record of [...(manifest.Items || []), ...(state.Items || [])]) {
    records.set(Number(record.Id), record);
  }
  const existingById = new Map(existingItems.map((item) => [Number(item.Id), item]));
  const selectedIds = new Set(sourceItems.map((item) => Number(item.Id)));
  const partialReadOnlySelection = options.itemIds.length > 0 || options.maxItems !== null;
  const missingFromSource = partialReadOnlySelection ? [] : existingItems.filter(
    (item) => item.MirrorSource === MIRROR_SOURCE && !selectedIds.has(Number(item.Id)),
  );

  const plan = sourceItems.map((source) => {
    const reusable = isReusableMirrorRecord(records.get(Number(source.Id)), source)
      ? records.get(Number(source.Id))
      : null;
    const steam = steamDetails.get(String(source.Description || ""));
    const desired = reusable ? buildMirroredItem(source, steam, reusable) : null;
    const existing = existingById.get(Number(source.Id));
    const metadataChanged = desired ? !samePublicAndMirrorMetadata(existing, desired) : true;
    return {
      source,
      steam,
      record: reusable,
      action: options.force || !reusable ? "copy" : metadataChanged ? "metadata" : "unchanged",
    };
  });

  printPlan(plan, sourceItems.length, missingFromSource.length);
  if (options.planOnly) {
    console.log("\nPlan complete. No files, R2 objects, or repository files were changed.");
    return;
  }

  if (options.validateDownloads) {
    await validateSelectedDownloads(plan);
    console.log("\nDownload validation passed. Nothing was uploaded or added to the catalog.");
    return;
  }

  if (plan.every((entry) => entry.action === "unchanged") && missingFromSource.length === 0) {
    console.log("\nThe mirror is already up to date. No uploads or repository changes are needed.");
    return;
  }

  ensureCatalogFilesClean();

  if (!options.nonInteractive) {
    const proceed = await askYesNo(`Mirror ${plan.filter((entry) => entry.action === "copy").length} new or changed payload(s) now?`, false);
    if (!proceed) {
      console.log("Cancelled before downloading or uploading anything.");
      return;
    }
  }

  await mkdir(DOWNLOAD_ROOT, { recursive: true });
  const stateById = new Map((state.Items || []).map((record) => [Number(record.Id), record]));
  const finalMirrored = [];
  const failures = [];
  let completed = 0;
  for (const entry of plan) {
    completed += 1;
    const label = `[${completed}/${plan.length}] ${entry.source.Name} (ID ${entry.source.Id})`;
    let record = entry.record;
    if (entry.action === "copy") {
      console.log(`\n${label}: downloading and mirroring files ...`);
      try {
        record = await mirrorItemFiles(entry.source, entry.steam);
        stateById.set(Number(record.Id), record);
        await writeJsonAtomic(STATE_PATH, {
          SchemaVersion: 1,
          UpdatedAt: new Date().toISOString(),
          Items: [...stateById.values()].sort((a, b) => Number(a.Id) - Number(b.Id)),
        });
      } catch (error) {
        const failure = { Id: entry.source.Id, Name: entry.source.Name, Error: error.message };
        failures.push(failure);
        console.error(`${label}: failed; continuing so other items can be checkpointed.\n  ${error.message}`);
        continue;
      }
    } else {
      console.log(`${label}: ${entry.action === "metadata" ? "files unchanged; refreshing metadata" : "unchanged"}.`);
    }
    finalMirrored.push(buildMirroredItem(entry.source, entry.steam, record));
  }

  if (failures.length > 0) {
    const failurePath = join(CACHE_ROOT, "main-workshop-failures.json");
    await writeJsonAtomic(failurePath, {
      GeneratedAt: new Date().toISOString(),
      Failures: failures,
    });
    throw new Error(`${failures.length} item(s) failed. Successful uploads were checkpointed. Run the mirror again to retry; details are in ${failurePath}.`);
  }

  const mergedItems = mergeCatalog(existingItems, finalMirrored);
  const finalManifest = {
    SchemaVersion: 1,
    SourceApi: SOURCE_API,
    GeneratedAt: new Date().toISOString(),
    ItemCount: finalMirrored.length,
    Items: finalMirrored.map((item) => ({
      Id: item.Id,
      Name: item.Name,
      SourceTimeStamp: item.MirrorSourceTimestamp,
      SourcePayloadUri: item.SourcePayloadUri,
      SourcePreviewUri: item.SourcePreviewUri,
      PayloadUri: item.PayloadUri,
      PreviewUri: item.PreviewUri,
      PayloadLength: item.PayloadLength,
      PayloadSha256: item.PayloadSha256,
      PreviewSha256: item.PreviewSha256,
      SteamWorkshopId: item.SteamWorkshopId,
      SteamAuthorId: item.SteamAuthorId,
      SteamTimeUpdated: item.SteamTimeUpdated,
    })),
  };

  await updateRepositoryCatalog(mergedItems, finalManifest);
  const shouldPush = options.push || (!options.nonInteractive && await askYesNo("Commit and deploy the mirrored catalog now?", true));
  if (!shouldPush) {
    console.log("Mirror prepared and tested, but not committed. The uploaded R2 files are safe to reuse on the next run.");
    return;
  }

  runGit(["add", "--", "items.json", "cloudflare/catalog.mjs", "main-workshop-manifest.json"]);
  runGit(["commit", "-m", "Mirror official Marble Race workshop"]);
  runGit(["push", "origin", "HEAD"]);
  await waitForLive(finalMirrored);
  console.log(`\nMirror published successfully. ${finalMirrored.length} official item(s) are in the catalog.`);
}

async function fetchOfficialCatalog() {
  const items = [];
  for (let skip = 0; skip < 10000; skip += PAGE_SIZE) {
    const url = `${SOURCE_API}/Items?sort=old&type=0,1,2&skip=${skip}&limit=${PAGE_SIZE}`;
    const response = await fetchOfficialJsonWithInt64(url, `official catalog page at offset ${skip}`);
    if (!Array.isArray(response)) throw new Error("The official Items endpoint did not return an array.");
    items.push(...response);
    if (response.length < PAGE_SIZE) break;
  }
  const ids = new Set();
  for (const item of items) {
    if (!Number.isSafeInteger(Number(item.Id)) || ids.has(Number(item.Id))) {
      throw new Error(`The official catalog contains an invalid or duplicate ID: ${item.Id}`);
    }
    if (![0, 1, 2].includes(Number(item.ResourceType))) throw new Error(`Item ${item.Id} has an unknown resource type.`);
    if (!Number.isInteger(Number(item.PayloadLength)) || Number(item.PayloadLength) < 1 || Number(item.PayloadLength) > 2147483647) {
      throw new Error(`Item ${item.Id} has an invalid payload length.`);
    }
    ids.add(Number(item.Id));
  }
  return items.sort((left, right) => Number(left.Id) - Number(right.Id));
}

async function fetchSteamDetails(sourceItems) {
  const ids = [...new Set(sourceItems
    .map((item) => String(item.Description || ""))
    .filter((value) => /^\d+$/.test(value)))];
  const details = new Map();
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = ids.slice(offset, offset + 100);
    const body = new URLSearchParams({ itemcount: String(batch.length) });
    batch.forEach((id, index) => body.set(`publishedfileids[${index}]`, id));
    const response = await fetchJsonWithRetry(STEAM_DETAILS_API, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    }, `Steam metadata batch ${Math.floor(offset / 100) + 1}`);
    for (const detail of response?.response?.publishedfiledetails || []) {
      if (Number(detail.result) === 1 && Number(detail.consumer_app_id) === STEAM_APP_ID) {
        details.set(String(detail.publishedfileid), detail);
      }
    }
    if (offset + 100 < ids.length) await sleep(250);
  }
  return details;
}

async function mirrorItemFiles(source, steam) {
  const id = Number(source.Id);
  const timestamp = Number(source.TimeStamp);
  const itemCache = join(DOWNLOAD_ROOT, `${id}-${timestamp}`);
  await mkdir(itemCache, { recursive: true });
  const payloadPath = join(itemCache, "payload.zip");
  await ensureDownloaded(source.PayloadUri, payloadPath, Number(source.PayloadLength));
  await validatePayloadArchive(payloadPath, Number(source.ResourceType));
  const payloadSha256 = await hashFile(payloadPath);

  const previewPath = join(itemCache, "preview.bin");
  let previewInfo;
  const previewCandidates = [source.PreviewUri, steam?.preview_url].filter(Boolean);
  let lastPreviewError;
  for (const candidate of previewCandidates) {
    try {
      await ensureDownloaded(candidate, previewPath, null, true);
      previewInfo = await detectImage(previewPath);
      break;
    } catch (error) {
      lastPreviewError = error;
      await rm(previewPath, { force: true });
    }
  }
  if (!previewInfo) throw new Error(`No usable preview was available for item ${id}: ${lastPreviewError?.message || "unknown error"}`);
  const previewSha256 = await hashFile(previewPath);

  const payloadKey = `official/payloads/${id}-${timestamp}.zip`;
  const previewKey = `official/previews/${id}-${timestamp}.${previewInfo.extension}`;
  uploadR2Object(payloadKey, payloadPath, "application/zip");
  uploadR2Object(previewKey, previewPath, previewInfo.contentType);
  const previewStats = await stat(previewPath);
  const record = {
    Id: id,
    SourceTimeStamp: timestamp,
    SourcePayloadUri: String(source.PayloadUri),
    SourcePreviewUri: String(source.PreviewUri),
    PayloadUri: `${R2_PUBLIC_BASE}/${payloadKey}`,
    PreviewUri: `${R2_PUBLIC_BASE}/${previewKey}`,
    PayloadLength: Number(source.PayloadLength),
    PreviewLength: previewStats.size,
    PayloadSha256: payloadSha256,
    PreviewSha256: previewSha256,
    MirroredAt: new Date().toISOString(),
  };
  await rm(itemCache, { recursive: true, force: true });
  return record;
}

async function validateSelectedDownloads(plan) {
  const validationRoot = join(tmpdir(), `marble-mirror-validation-${randomUUID()}`);
  await mkdir(validationRoot, { recursive: true });
  try {
    let index = 0;
    for (const entry of plan) {
      index += 1;
      console.log(`[${index}/${plan.length}] Validating ${entry.source.Name} (ID ${entry.source.Id}) ...`);
      const itemRoot = join(validationRoot, String(entry.source.Id));
      await mkdir(itemRoot, { recursive: true });
      const payloadPath = join(itemRoot, "payload.zip");
      const previewPath = join(itemRoot, "preview.bin");
      await ensureDownloaded(entry.source.PayloadUri, payloadPath, Number(entry.source.PayloadLength));
      await validatePayloadArchive(payloadPath, Number(entry.source.ResourceType));
      const candidates = [entry.source.PreviewUri, entry.steam?.preview_url].filter(Boolean);
      let validPreview = false;
      for (const candidate of candidates) {
        try {
          await ensureDownloaded(candidate, previewPath, null, true);
          await detectImage(previewPath);
          validPreview = true;
          break;
        } catch {
          await rm(previewPath, { force: true });
        }
      }
      if (!validPreview) throw new Error(`No usable preview was available for item ${entry.source.Id}.`);
    }
  } finally {
    await rm(validationRoot, { recursive: true, force: true });
  }
}

async function ensureDownloaded(url, destination, expectedLength, replace = false) {
  if (!replace && existsSync(destination)) {
    const current = await stat(destination);
    if (expectedLength === null || current.size === expectedLength) return;
  }
  const partial = `${destination}.part`;
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await rm(partial, { force: true });
    try {
      const response = await fetchWithRetry(url, {}, `download ${url}`);
      if (!response.body) throw new Error(`Download returned no body: ${url}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
      const downloaded = await stat(partial);
      if (expectedLength !== null && downloaded.size !== expectedLength) {
        throw new Error(`Downloaded size mismatch: expected ${expectedLength}, received ${downloaded.size}.`);
      }
      await rm(destination, { force: true });
      await rename(partial, destination);
      return;
    } catch (error) {
      lastError = error;
      await rm(partial, { force: true });
      if (attempt < 4) await sleep(500 * (2 ** (attempt - 1)));
    }
  }
  throw new Error(`Download failed after four attempts for ${url}: ${lastError?.message || lastError}`);
}

async function validatePayloadArchive(filePath, resourceType) {
  const tested = runProcess("7z", ["t", "-y", "--", filePath], { capture: true, maxBuffer: 64 * 1024 * 1024 });
  if (tested.status !== 0) throw new Error(`7-Zip could not validate ${basename(filePath)}.\n${tested.output}`);
  const listed = runProcess("7z", ["l", "-slt", "--", filePath], { capture: true, maxBuffer: 64 * 1024 * 1024 });
  if (listed.status !== 0) throw new Error(`7-Zip could not list ${basename(filePath)}.\n${listed.output}`);
  const entriesText = listed.output.includes("----------") ? listed.output.split("----------").slice(1).join("----------") : listed.output;
  const paths = [...entriesText.matchAll(/^Path = (.+)$/gm)].map((match) => match[1].trim());
  const unsafe = paths.find((entry) => !isSafeArchivePath(entry));
  if (unsafe) throw new Error(`Unsafe ZIP entry found: ${unsafe}`);
  const rootJson = ["level.json", "block.json", "campaign.json"][resourceType];
  if (!paths.some((entry) => entry.replaceAll("\\", "/").toLowerCase() === rootJson)) {
    throw new Error(`The ZIP does not contain ${rootJson} at its root.`);
  }
}

async function detectImage(filePath) {
  const handle = await import("node:fs/promises").then(({ open }) => open(filePath, "r"));
  try {
    const buffer = Buffer.alloc(12);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return { extension: "png", contentType: "image/png" };
    }
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return { extension: "jpg", contentType: "image/jpeg" };
    }
    throw new Error("Preview is not a PNG or JPEG image.");
  } finally {
    await handle.close();
  }
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function uploadR2Object(key, filePath, contentType) {
  console.log(`Uploading ${key} ...`);
  const wranglerScript = join(REPO_ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
  if (!existsSync(wranglerScript)) throw new Error("Wrangler is not installed. Run npm install once.");
  const environment = { ...process.env };
  delete environment.CODEX_CI;
  const result = spawnSync(process.execPath, [
    wranglerScript,
    "r2", "object", "put", `${R2_BUCKET}/${key}`,
    "--file", filePath,
    "--content-type", contentType,
    "--cache-control", "public, max-age=31536000, immutable",
    "--remote",
  ], { cwd: REPO_ROOT, env: environment, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`R2 upload failed for ${key}.`);
}

async function updateRepositoryCatalog(items, manifest) {
  const originalItems = await readFile(ITEMS_PATH, "utf8");
  const originalCatalog = await readFile(CATALOG_PATH, "utf8");
  const originalManifest = existsSync(MANIFEST_PATH) ? await readFile(MANIFEST_PATH, "utf8") : null;
  const itemsJson = `${JSON.stringify(items, null, 2)}\n`;
  const updatedCatalog = replaceCatalogItems(originalCatalog, items);

  try {
    await writeFile(ITEMS_PATH, itemsJson, "utf8");
    await writeFile(CATALOG_PATH, updatedCatalog, "utf8");
    await writeJsonAtomic(MANIFEST_PATH, manifest);
    console.log("Running server tests ...");
    const tests = runProcess(process.execPath, ["--test"], { capture: false });
    if (tests.status !== 0) throw new Error("Server tests failed. Repository changes were rolled back.");
  } catch (error) {
    await writeFile(ITEMS_PATH, originalItems, "utf8");
    await writeFile(CATALOG_PATH, originalCatalog, "utf8");
    if (originalManifest === null) await rm(MANIFEST_PATH, { force: true });
    else await writeFile(MANIFEST_PATH, originalManifest, "utf8");
    throw error;
  }
}

function printPlan(plan, selectedCount, missingCount) {
  const counts = { copy: 0, metadata: 0, unchanged: 0 };
  let bytes = 0;
  let recovered = 0;
  for (const entry of plan) {
    counts[entry.action] += 1;
    if (entry.action === "copy") bytes += Number(entry.source.PayloadLength);
    if (cleanSteamDescription(entry.steam?.description)) recovered += 1;
  }
  console.log("\nMirror plan");
  console.log(`  Official items:       ${selectedCount}`);
  console.log(`  New/changed files:    ${counts.copy}`);
  console.log(`  Metadata-only:        ${counts.metadata}`);
  console.log(`  Unchanged:            ${counts.unchanged}`);
  console.log(`  Retained if removed:  ${missingCount}`);
  console.log(`  Payload download:     ${formatBytes(bytes)}`);
  console.log(`  Steam descriptions:   ${recovered}/${selectedCount}`);
}

function ensureCatalogFilesClean() {
  const result = runProcess("git", [
    "-c", `safe.directory=${REPO_ROOT.replaceAll("\\", "/")}`,
    "-C", REPO_ROOT,
    "status", "--porcelain", "--",
    "items.json", "cloudflare/catalog.mjs", "main-workshop-manifest.json",
  ], { capture: true });
  if (result.status !== 0) throw new Error(`Could not inspect the Git working tree.\n${result.output}`);
  if (result.output.trim()) {
    throw new Error("The catalog or mirror manifest has uncommitted changes. Finish or discard those changes before starting a full mirror.");
  }
}

function printHelp() {
  console.log(`Marble Race main workshop mirror

Double-click mirror-main-workshop.bat for the normal interactive mirror.

Options:
  --plan                    Read-only plan; no downloads, uploads, or file changes
  --validate-downloads      Download and validate selected items without uploading
  --item-id ID              Select one item in a read-only mode (repeatable)
  --max-items N             Limit a read-only mode to the first N items
  --force                   Re-copy every source item during a full mirror
  --non-interactive         Do not ask questions
  --push                    Commit and deploy after a successful full mirror
  --help                    Show this help`);
}

function samePublicAndMirrorMetadata(existing, desired) {
  if (!existing) return false;
  const keys = [
    "Id", "Name", "ResourceType", "TimeStamp", "AuthorId", "AuthorName",
    "PreviewUri", "PayloadUri", "Description", "PayloadLength", "Version",
    "MirrorSource", "MirrorStatus", "SourcePayloadUri", "SourcePreviewUri",
    "MirrorSourceTimestamp", "SteamWorkshopId", "SteamTimeUpdated",
    "SteamAuthorId", "PayloadSha256", "PreviewSha256",
  ];
  return keys.every((key) => JSON.stringify(existing[key] ?? null) === JSON.stringify(desired[key] ?? null))
    && JSON.stringify(existing.Tags || []) === JSON.stringify(desired.Tags || []);
}

async function fetchJsonWithRetry(url, options, label) {
  const response = await fetchWithRetry(url, options, label);
  return response.json();
}

async function fetchOfficialJsonWithInt64(url, label) {
  const response = await fetchWithRetry(url, {}, label);
  const text = await response.text();
  // JSON.parse would round 17-digit Steam author IDs. Quote only this known
  // integer field before parsing so the preservation manifest stays exact.
  return JSON.parse(text.replace(/("AuthorId"\s*:\s*)(-?\d+)/g, "$1\"$2\""));
}

async function fetchWithRetry(url, options, label) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        headers: { "user-agent": "MarbleRacePreservationMirror/1.0", ...(options.headers || {}) },
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < 4) await sleep(500 * (2 ** (attempt - 1)));
    }
  }
  throw new Error(`Failed to fetch ${label}: ${lastError?.message || lastError}`);
}

async function readJsonIfExists(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await rename(temporary, filePath);
  } catch (error) {
    if (!existsSync(filePath) || !["EEXIST", "EPERM"].includes(error.code)) throw error;
    await rm(filePath, { force: true });
    await rename(temporary, filePath);
  }
}

function runGit(arguments_) {
  const safeRoot = REPO_ROOT.replaceAll("\\", "/");
  const result = runProcess("git", ["-c", `safe.directory=${safeRoot}`, "-C", REPO_ROOT, ...arguments_], { capture: false });
  if (result.status !== 0) throw new Error(`git ${arguments_.join(" ")} failed.`);
}

function runProcess(command, arguments_, { capture = false, maxBuffer = 16 * 1024 * 1024 } = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: REPO_ROOT,
    encoding: capture ? "utf8" : undefined,
    maxBuffer,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  return { ...result, output: capture ? `${result.stdout || ""}${result.stderr || ""}` : "" };
}

async function waitForLive(mirroredItems) {
  const sample = [...mirroredItems].sort((a, b) => Number(b.TimeStamp) - Number(a.TimeStamp))[0];
  if (!sample) return;
  console.log(`Waiting for the live API to expose official item ID ${sample.Id} ...`);
  const deadline = Date.now() + 7 * 60 * 1000;
  while (Date.now() < deadline) {
    try {
      const live = await fetchJsonWithRetry(`${LIVE_API}/GetItem?id=${sample.Id}&cacheBust=${Date.now()}`, {
        headers: { "cache-control": "no-cache" },
      }, "live workshop API");
      if (Number(live.Id) === sample.Id && live.PayloadUri === sample.PayloadUri) return;
    } catch {
      // A Cloudflare deployment can briefly make the endpoint unavailable.
    }
    process.stdout.write(".");
    await sleep(10000);
  }
  throw new Error("Git push succeeded, but the mirrored catalog did not appear within seven minutes. Check Cloudflare Builds.");
}

async function askYesNo(question, defaultValue) {
  const prompt = defaultValue ? "[Y/n]" : "[y/N]";
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await reader.question(`${question} ${prompt}: `)).trim();
    if (!answer) return defaultValue;
    return /^y(?:es)?$/i.test(answer);
  } finally {
    reader.close();
  }
}

function resourceTypeName(value) {
  return ["level", "block", "campaign"][Number(value)] || "workshop";
}

function formatBytes(value) {
  if (value < 1024) return `${value} bytes`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1024 ** 3).toFixed(2)} GiB`;
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`\nMirror failed: ${error.message}`);
    process.exitCode = 1;
  });
}
