import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const UI_ROOT = resolve(ROOT, "manager-ui");
const PREVIEW_ROOT = resolve(ROOT, "public", "previews");
const DUPLICATE_REPORT_PATH = resolve(ROOT, "duplicate-review.html");
const ITEMS_PATH = resolve(ROOT, "items.json");
const HIDDEN_PATH = resolve(ROOT, "hidden-workshop-items.json");
const MODERATION_MODULE_PATH = resolve(ROOT, "cloudflare", "moderation.mjs");
const OVERRIDES_PATH = resolve(ROOT, "metadata-overrides.json");
const OVERRIDES_MODULE_PATH = resolve(ROOT, "cloudflare", "metadata-overrides.mjs");
const MANAGED_FILES = [
  "hidden-workshop-items.json",
  "cloudflare/moderation.mjs",
  "metadata-overrides.json",
  "cloudflare/metadata-overrides.mjs",
];
const EDITABLE_FIELDS = ["Name", "AuthorName", "Description", "Version", "Tags", "TimeStamp"];
const BULK_FIELDS = new Map([
  ["name", "Name"], ["author", "AuthorName"], ["description", "Description"], ["version", "Version"],
]);
const UI_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/manager.css", ["manager.css", "text/css; charset=utf-8"]],
  ["/manager.js", ["manager.js", "text/javascript; charset=utf-8"]],
]);

export function buildModerationModule(ids) {
  const normalized = [...new Set(ids.map(Number).filter(Number.isSafeInteger))].sort((a, b) => a - b);
  const lines = [];
  for (let index = 0; index < normalized.length; index += 12) {
    lines.push(`  ${normalized.slice(index, index + 12).join(", ")},`);
  }
  return `export const hiddenItemIds = new Set([\n${lines.join("\n")}\n]);\n\n`
    + "export function isHiddenItemId(id) {\n"
    + "  return hiddenItemIds.has(Number(id));\n"
    + "}\n";
}

export function buildOverridesModule(overrides) {
  const entries = Object.entries(overrides)
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([id, value]) => [Number(id), value]);
  return `export const metadataOverrides = new Map(${JSON.stringify(entries, null, 2)});\n\n`
    + "export function applyMetadataOverrides(item) {\n"
    + "  const override = metadataOverrides.get(Number(item.Id));\n"
    + "  return override ? { ...item, ...override } : item;\n"
    + "}\n";
}

export function applyItemEdit(baseItem, existingOverride, values) {
  const next = { ...(existingOverride || {}) };
  for (const field of EDITABLE_FIELDS) {
    if (!(field in values)) continue;
    let value = values[field];
    if (field === "TimeStamp") {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Upload date must be a valid date and time.");
      if (value === Number(baseItem.TimeStamp)) delete next[field];
      else next[field] = value;
      continue;
    }
    if (field === "Tags") {
      if (!Array.isArray(value) || value.some((tag) => typeof tag !== "string")) throw new Error("Tags must be a list of text values.");
      value = value.map((tag) => tag.trim()).filter(Boolean);
      if (JSON.stringify(value) === JSON.stringify(baseItem.Tags || [])) delete next[field];
      else next[field] = value;
      continue;
    }
    if (typeof value !== "string") throw new Error(`${field} must be text.`);
    if (field !== "Description" && !value.trim()) throw new Error(`${field} cannot be empty.`);
    if (value === String(baseItem[field] ?? "")) delete next[field];
    else next[field] = value;
  }
  return next;
}

export function mergeReviewedHiddenItemIds(existingValues, requestedValues, catalogValues) {
  if (!Array.isArray(requestedValues)) throw new Error("The duplicate review did not provide a hidden-item list.");
  const existing = new Set((Array.isArray(existingValues) ? existingValues : []).map(Number).filter(Number.isSafeInteger));
  const catalog = new Set((Array.isArray(catalogValues) ? catalogValues : []).map(Number).filter(Number.isSafeInteger));
  for (const value of requestedValues) {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id < 0) throw new Error("The duplicate review contains an invalid workshop item ID.");
    if (!existing.has(id) && !catalog.has(id)) throw new Error(`Workshop item #${id} does not exist.`);
    existing.add(id);
  }
  return [...existing].sort((left, right) => left - right);
}

export function buildSteamRecoveryBookmarklet(mirroredIds) {
  const ids = [...new Set(mirroredIds.map(String).filter((id) => /^\d+$/.test(id)))].sort((left, right) => Number(left) - Number(right));
  const script = `(async()=>{const APP="851640",known=new Set(${JSON.stringify(ids)});if(location.hostname!=="steamcommunity.com"){alert("Open a Steam Community workshop page first, then click this bookmark again.");return}if(window.__marbleRecoveryRunning){alert("The Marble Race recovery downloader is already running on this page.");return}window.__marbleRecoveryRunning=true;let cancelled=false,paused=false;const wait=ms=>new Promise(r=>setTimeout(r,ms));const box=document.createElement("div");box.style="position:fixed;z-index:2147483647;right:16px;top:16px;width:min(390px,calc(100vw - 32px));padding:16px;color:#fff;background:#172259;border:3px solid #63bdf4;border-radius:12px;box-shadow:0 12px 40px #0008;font:14px/1.4 system-ui,sans-serif";const title=document.createElement("strong"),status=document.createElement("div"),controls=document.createElement("div"),pause=document.createElement("button"),cancel=document.createElement("button");title.textContent="Marble Race recovery";status.style="margin:10px 0;white-space:pre-wrap";controls.style="display:flex;gap:8px";for(const b of [pause,cancel])b.style="padding:7px 10px;border:0;border-radius:7px;font-weight:700;cursor:pointer";pause.textContent="Pause";cancel.textContent="Cancel";pause.onclick=()=>{paused=!paused;pause.textContent=paused?"Resume":"Pause"};cancel.onclick=()=>{cancelled=true;status.textContent="Stopping after the current request..."};controls.append(pause,cancel);box.append(title,status,controls);document.body.append(box);try{status.textContent="Scanning the Marble Race Steam Workshop...";const found=new Set;let stale=0;for(let page=1;page<=100&&!cancelled&&stale<2;page++){const url="/workshop/browse/?appid="+APP+"&browsesort=mostrecent&section=readytouseitems&actualsort=mostrecent&p="+page+"&numperpage=30";const html=await(await fetch(url,{credentials:"include"})).text();const before=found.size;for(const match of html.matchAll(/sharedfiles\\/filedetails\\/\\?id=(\\d+)/g))found.add(match[1]);stale=found.size===before?stale+1:0;status.textContent="Scanning Steam... "+found.size+" items found"}const missing=[...found].filter(id=>!known.has(id));if(cancelled)return;status.textContent=missing.length+" Steam item(s) are absent from your mirror.\\nStarting downloads; allow multiple downloads if the browser asks.";const results=[];for(let i=0;i<missing.length&&!cancelled;i++){while(paused&&!cancelled)await wait(300);const id=missing[i];status.textContent="Downloading "+(i+1)+" of "+missing.length+"\\nSteam item "+id;try{const response=await fetch("/sharedfiles/downloadfile/?id="+id+"&revision=1&manifestid=0",{method:"POST",credentials:"include"});const data=await response.json();if(Number(data.success)!==1||!data.url)throw new Error(data.message||"Steam refused the download");const link=document.createElement("a");link.href=data.url;link.download=data.filename||("steam-workshop-"+id+".zip");link.style.display="none";document.body.append(link);link.click();link.remove();results.push({id,filename:data.filename||"",ok:true})}catch(error){results.push({id,ok:false,error:String(error.message||error)})}await wait(1250)}const failed=results.filter(x=>!x.ok);status.textContent=cancelled?"Stopped. "+results.length+" item(s) attempted.":"Finished: "+(results.length-failed.length)+" downloaded, "+failed.length+" failed.";const report=document.createElement("a");report.textContent="Save recovery report";report.style="display:block;margin-top:9px;color:#ffd15a;text-decoration:underline;cursor:pointer";report.href=URL.createObjectURL(new Blob([JSON.stringify({createdAt:new Date().toISOString(),found:[...found],missing,results},null,2)],{type:"application/json"}));report.download="marble-race-steam-recovery-report.json";box.append(report)}catch(error){status.textContent="Recovery stopped: "+String(error.message||error)}finally{window.__marbleRecoveryRunning=false}})()`;
  return `javascript:${encodeURIComponent(script)}`;
}

export async function createWorkshopManager({ port = 31940, host = "127.0.0.1", openBrowser = true } = {}) {
  const token = randomBytes(24).toString("hex");
  let operationInProgress = false;

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", `http://${host}:${port}`);
      if (request.method === "GET" && UI_FILES.has(url.pathname)) {
        await serveUiFile(url.pathname, response);
        return;
      }
      const previewMatch = /^\/previews\/([a-z0-9._-]+\.(?:png|jpe?g))$/i.exec(url.pathname);
      if (request.method === "GET" && previewMatch) {
        await servePreviewFile(previewMatch[1], response);
        return;
      }
      if (request.method === "GET" && url.pathname === "/duplicate-review") {
        if (url.searchParams.get("token") !== token) return sendJson(response, 403, { error: "This manager session is not authorized." });
        await serveDuplicateReport(response);
        return;
      }
      if (!url.pathname.startsWith("/api/")) return sendJson(response, 404, { error: "Not found" });
      if (request.headers["x-manager-token"] !== token) return sendJson(response, 403, { error: "This manager session is not authorized." });

      if (request.method === "GET" && url.pathname === "/api/catalog") {
        return sendJson(response, 200, await readCatalog());
      }
      if (request.method === "GET" && url.pathname === "/api/steam-recovery") {
        const manifest = await readJson(resolve(ROOT, "main-workshop-manifest.json"));
        const mirroredIds = (manifest.Items || []).map((item) => item.SteamWorkshopId).filter(Boolean);
        return sendJson(response, 200, { mirroredCount: mirroredIds.length, bookmarklet: buildSteamRecoveryBookmarklet(mirroredIds) });
      }
      if (request.method === "POST" && url.pathname === "/api/visibility") {
        const body = await readJsonBody(request);
        const result = await setVisibility(body.id, body.hidden);
        return sendJson(response, 200, { ...result, dirty: getDirtyState() });
      }
      if (request.method === "POST" && url.pathname === "/api/metadata") {
        const body = await readJsonBody(request);
        const result = await setMetadata(body.id, body.values);
        return sendJson(response, 200, { ...result, dirty: getDirtyState() });
      }
      if (request.method === "POST" && url.pathname === "/api/bulk-metadata") {
        const body = await readJsonBody(request);
        const result = await bulkEditMetadata(body.field, body.find, body.replace, Boolean(body.preview));
        return sendJson(response, 200, { ...result, dirty: getDirtyState() });
      }
      if (request.method === "POST" && url.pathname === "/api/duplicate-hidden") {
        const body = await readJsonBody(request);
        const result = await applyReviewedHiddenItems(body.hiddenItemIds);
        return sendJson(response, 200, { ...result, dirty: getDirtyState() });
      }
      if (request.method === "POST" && url.pathname === "/api/deploy") {
        if (operationInProgress) return sendJson(response, 409, { error: "Another manager operation is already running." });
        operationInProgress = true;
        try {
          return sendJson(response, 200, deployChanges());
        } finally {
          operationInProgress = false;
        }
      }
      if (request.method === "POST" && url.pathname === "/api/launch") {
        const body = await readJsonBody(request);
        return sendJson(response, 200, launchTool(body.tool, { managerOrigin: url.origin, token }));
      }
      if (request.method === "POST" && url.pathname === "/api/update-item") {
        const body = await readJsonBody(request);
        return sendJson(response, 200, await launchItemUpdate(body.id));
      }
      return sendJson(response, 404, { error: "Manager action not found." });
    } catch (error) {
      console.error(error);
      return sendJson(response, 400, { error: error.message || "Manager operation failed." });
    }
  });

  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolvePromise);
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const url = `http://${host}:${actualPort}/?token=${token}`;
  if (openBrowser) openUrl(url);
  return { server, token, url };
}

async function readCatalog() {
  const [items, hiddenDocument, overrideDocument] = await Promise.all([
    readJson(ITEMS_PATH), readJson(HIDDEN_PATH), readJson(OVERRIDES_PATH),
  ]);
  const hiddenIds = new Set((hiddenDocument.HiddenItemIds || []).map(Number));
  const overrides = overrideDocument.Items || {};
  const catalog = items.map((base) => ({
    ...base,
    ...(overrides[String(base.Id)] || {}),
    Hidden: hiddenIds.has(Number(base.Id)),
    HasOverride: Boolean(overrides[String(base.Id)]),
  }));
  return {
    items: catalog,
    stats: {
      total: catalog.length,
      visible: catalog.filter((item) => !item.Hidden).length,
      hidden: catalog.filter((item) => item.Hidden).length,
      edited: catalog.filter((item) => item.HasOverride).length,
    },
    dirty: getDirtyState(),
    duplicateReportAvailable: existsSync(resolve(ROOT, "duplicate-review.html")),
  };
}

async function setVisibility(idValue, hiddenValue) {
  const id = parseItemId(idValue);
  const items = await readJson(ITEMS_PATH);
  const item = items.find((candidate) => Number(candidate.Id) === id);
  if (!item) throw new Error(`Workshop item #${id} does not exist.`);
  if (typeof hiddenValue !== "boolean") throw new Error("Hidden must be true or false.");
  const document = await readJson(HIDDEN_PATH);
  const ids = new Set((document.HiddenItemIds || []).map(Number));
  if (hiddenValue) ids.add(id); else ids.delete(id);
  const sorted = [...ids].sort((a, b) => a - b);
  await Promise.all([
    writeAtomic(HIDDEN_PATH, `${JSON.stringify({ SchemaVersion: 1, HiddenItemIds: sorted }, null, 2)}\n`),
    writeAtomic(MODERATION_MODULE_PATH, buildModerationModule(sorted)),
  ]);
  return { id, hidden: hiddenValue, message: `${hiddenValue ? "Hidden" : "Unhidden"} #${id} locally.` };
}

async function applyReviewedHiddenItems(requestedIds) {
  const [items, document] = await Promise.all([readJson(ITEMS_PATH), readJson(HIDDEN_PATH)]);
  const previous = (document.HiddenItemIds || []).map(Number);
  const merged = mergeReviewedHiddenItemIds(previous, requestedIds, items.map((item) => item.Id));
  const added = merged.filter((id) => !previous.includes(id)).length;
  await Promise.all([
    writeAtomic(HIDDEN_PATH, `${JSON.stringify({ SchemaVersion: 1, HiddenItemIds: merged }, null, 2)}\n`),
    writeAtomic(MODERATION_MODULE_PATH, buildModerationModule(merged)),
  ]);
  return {
    added,
    totalHidden: merged.length,
    message: added ? `Applied ${added} newly hidden item${added === 1 ? "" : "s"} locally.` : "All checked items were already hidden locally.",
  };
}

async function setMetadata(idValue, values) {
  const id = parseItemId(idValue);
  if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("Metadata values are required.");
  const [items, document] = await Promise.all([readJson(ITEMS_PATH), readJson(OVERRIDES_PATH)]);
  const base = items.find((candidate) => Number(candidate.Id) === id);
  if (!base) throw new Error(`Workshop item #${id} does not exist.`);
  const overrides = { ...(document.Items || {}) };
  const next = applyItemEdit(base, overrides[String(id)], values);
  if (Object.keys(next).length) overrides[String(id)] = next; else delete overrides[String(id)];
  await writeOverrideFiles(overrides);
  return {
    id,
    item: { ...base, ...(overrides[String(id)] || {}) },
    hasOverride: Boolean(overrides[String(id)]),
    message: `Saved metadata for #${id} locally.`,
  };
}

async function bulkEditMetadata(fieldKey, findValue, replaceValue, preview) {
  const property = BULK_FIELDS.get(String(fieldKey || "").toLowerCase());
  if (!property) throw new Error("Choose author, name, description, or version.");
  if (typeof findValue !== "string" || !findValue.trim()) throw new Error("The current value cannot be empty.");
  if (typeof replaceValue !== "string") throw new Error("The replacement must be text.");
  if (property !== "Description" && !replaceValue.trim()) throw new Error("The replacement cannot be empty.");
  const [items, document] = await Promise.all([readJson(ITEMS_PATH), readJson(OVERRIDES_PATH)]);
  const overrides = { ...(document.Items || {}) };
  const matches = items.filter((base) => sameText(({ ...base, ...(overrides[String(base.Id)] || {}) })[property], findValue));
  if (preview) return { count: matches.length, items: matches.slice(0, 100).map(({ Id, Name }) => ({ Id, Name })) };
  if (!matches.length) throw new Error(`No items exactly match “${findValue}”.`);
  for (const base of matches) {
    const key = String(base.Id);
    const next = { ...(overrides[key] || {}) };
    if (replaceValue === String(base[property] ?? "")) delete next[property]; else next[property] = replaceValue;
    if (Object.keys(next).length) overrides[key] = next; else delete overrides[key];
  }
  await writeOverrideFiles(overrides);
  return { count: matches.length, message: `Updated ${matches.length} item${matches.length === 1 ? "" : "s"} locally.` };
}

async function writeOverrideFiles(overrides) {
  const sorted = Object.fromEntries(Object.entries(overrides).sort(([left], [right]) => Number(left) - Number(right)));
  await Promise.all([
    writeAtomic(OVERRIDES_PATH, `${JSON.stringify({ SchemaVersion: 1, Items: sorted }, null, 2)}\n`),
    writeAtomic(OVERRIDES_MODULE_PATH, buildOverridesModule(sorted)),
  ]);
}

function deployChanges() {
  const dirty = getDirtyState();
  if (!dirty.hasChanges) return { message: "There are no manager changes to publish.", dirty };
  const tests = run(process.execPath, ["--test"]);
  if (tests.status !== 0) throw new Error(`Tests failed. Your local changes were kept so you can review them.\n${tests.output}`);
  requireRun("git", gitArguments(["add", "--", ...MANAGED_FILES]));
  const staged = run("git", gitArguments(["diff", "--cached", "--quiet", "--", ...MANAGED_FILES]));
  if (staged.status === 0) return { message: "There are no new manager changes to publish.", dirty: getDirtyState() };
  requireRun("git", gitArguments(["commit", "--only", "-m", "Update workshop through manager", "--", ...MANAGED_FILES]));
  requireRun("git", gitArguments(["push", "origin", "HEAD"]));
  return { message: "Changes passed all tests and were sent to Cloudflare.", dirty: getDirtyState(), testsPassed: true };
}

function launchTool(toolValue, { managerOrigin = "", token = "" } = {}) {
  const tool = String(toolValue || "");
  const launchers = {
    publish: { path: resolve(ROOT, "select-and-publish-workshop-item.bat"), label: "publisher" },
    edit: { path: resolve(ROOT, "edit-workshop-item.bat"), label: "item editor" },
    bulk: { path: resolve(ROOT, "bulk-edit-workshop-metadata.bat"), label: "bulk metadata editor" },
    duplicates: { path: resolve(ROOT, "scan-workshop-duplicates.bat"), label: "duplicate scanner" },
    mirror: { path: resolve(ROOT, "mirror-main-workshop.bat"), label: "official workshop mirror" },
    steamImport: { path: resolve(ROOT, "import-recovered-steam-workshop.bat"), label: "recovered Steam importer" },
    review: { path: DUPLICATE_REPORT_PATH, managerPage: true, label: "duplicate review" },
  };
  const selected = launchers[tool];
  if (!selected) throw new Error("Unknown manager tool.");
  if (!existsSync(selected.path)) throw new Error(`${selected.label} is not available yet.`);
  if (selected.managerPage) {
    if (!managerOrigin || !token) throw new Error("The duplicate review requires an active manager session.");
    const reviewUrl = new URL("/duplicate-review", managerOrigin);
    reviewUrl.searchParams.set("token", token);
    openUrl(reviewUrl.toString());
  }
  else if (selected.powershell) {
    spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", selected.path], { cwd: ROOT, detached: true, stdio: "ignore", windowsHide: false }).unref();
  } else {
    spawn("cmd.exe", ["/d", "/k", "call", selected.path], { cwd: ROOT, detached: true, stdio: "ignore", windowsHide: false }).unref();
  }
  return { message: `Opened the ${selected.label}.` };
}

async function launchItemUpdate(idValue) {
  const id = parseItemId(idValue);
  const items = await readJson(ITEMS_PATH);
  const item = items.find((candidate) => Number(candidate.Id) === id);
  if (!item) throw new Error(`Workshop item #${id} does not exist.`);
  const launcher = resolve(ROOT, "select-and-update-workshop-item.bat");
  if (!existsSync(launcher)) throw new Error("The item updater is not available yet.");
  spawn("cmd.exe", ["/d", "/k", "call", launcher, String(id)], {
    cwd: ROOT, detached: true, stdio: "ignore", windowsHide: false,
  }).unref();
  return { message: `Choose the new archive for #${id} in the file window.` };
}

function getDirtyState() {
  const result = run("git", gitArguments(["status", "--porcelain", "--", ...MANAGED_FILES]));
  if (result.status !== 0) return { hasChanges: false, files: [], error: result.output.trim() };
  const files = result.output.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3));
  return { hasChanges: files.length > 0, files };
}

function gitArguments(arguments_) {
  return ["-c", `safe.directory=${ROOT.replaceAll("\\", "/")}`, "-C", ROOT, ...arguments_];
}

function run(command, arguments_) {
  const result = spawnSync(command, arguments_, { cwd: ROOT, encoding: "utf8", windowsHide: true });
  return { status: result.status ?? 1, output: `${result.stdout || ""}${result.stderr || ""}` };
}

function requireRun(command, arguments_) {
  const result = run(command, arguments_);
  if (result.status !== 0) throw new Error(`${command} failed.\n${result.output.trim()}`);
  return result;
}

function openUrl(url) {
  const child = spawn("explorer.exe", [String(url)], { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", (error) => console.error(`Could not open the browser automatically: ${error.message}`));
  child.unref();
}

async function serveUiFile(pathname, response) {
  const [filename, contentType] = UI_FILES.get(pathname);
  const body = await readFile(resolve(UI_ROOT, filename));
  response.writeHead(200, securityHeaders({ "content-type": contentType, "content-length": body.length, "cache-control": "no-store" }));
  response.end(body);
}

async function servePreviewFile(filename, response) {
  const filePath = resolve(PREVIEW_ROOT, filename);
  if (!existsSync(filePath)) return sendJson(response, 404, { error: "Preview not found" });
  const body = await readFile(filePath);
  const contentType = extname(filename).toLowerCase() === ".png" ? "image/png" : "image/jpeg";
  response.writeHead(200, securityHeaders({ "content-type": contentType, "content-length": body.length, "cache-control": "no-store" }));
  response.end(body);
}

async function serveDuplicateReport(response) {
  if (!existsSync(DUPLICATE_REPORT_PATH)) return sendJson(response, 404, { error: "Run the duplicate scanner before opening the report." });
  const body = await readFile(DUPLICATE_REPORT_PATH);
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, securityHeaders({ "content-type": "application/json; charset=utf-8", "content-length": body.length, "cache-control": "no-store" }));
  response.end(body);
}

function securityHeaders(headers) {
  return {
    ...headers,
    "content-security-policy": "default-src 'self'; img-src 'self' https://marble.kevin-kuhn.dev https://content.marble.kevin-kuhn.dev data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("Request is too large.");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("The manager received invalid data."); }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeAtomic(path, contents) {
  const temporary = `${path}.manager-${process.pid}.tmp`;
  await writeFile(temporary, contents, "utf8");
  await rename(temporary, path);
}

function parseItemId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 0) throw new Error("Choose a valid workshop item ID.");
  return id;
}

function sameText(left, right) {
  return String(left ?? "").localeCompare(String(right), undefined, { sensitivity: "accent" }) === 0;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  createWorkshopManager().then(({ url }) => {
    console.log("Marble Race Workshop Manager is running.");
    console.log("If the browser did not open, copy this complete address:");
    console.log(url);
    console.log("Keep this window open while using the manager. Press Ctrl+C to stop it.");
  }).catch((error) => {
    console.error(`Workshop Manager could not start: ${error.message}`);
    process.exitCode = 1;
  });
}
