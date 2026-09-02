"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const HOST = process.env.MARBLE_HOST || "0.0.0.0";
const PORT = parseInteger(process.env.MARBLE_PORT, 3000, 1, 65535);
const ROOT = __dirname;
const ITEMS_FILE = path.join(ROOT, "items.json");
const HIDDEN_ITEMS_FILE = path.join(ROOT, "hidden-workshop-items.json");
const METADATA_OVERRIDES_FILE = path.join(ROOT, "metadata-overrides.json");
const PUBLIC_DIR = path.join(ROOT, "public");

const MIME_TYPES = {
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".webp": "image/webp",
  ".zip": "application/zip",
};

const server = http.createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url, "http://localhost");
    const apiPath = normalizeApiPath(requestUrl.pathname);
    console.log(`${new Date().toISOString()} ${request.method} ${requestUrl.pathname}${requestUrl.search}`);

    if (request.method === "OPTIONS") {
      response.writeHead(204, corsHeaders());
      response.end();
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      sendJson(response, 405, { error: "Method not allowed" }, request.method === "HEAD");
      return;
    }

    if (requestUrl.pathname === "/" || requestUrl.pathname === "/api") {
      sendJson(response, 200, {
        name: "Marble Race Items API",
        status: "ok",
        endpoints: ["/api/Items", "/api/GetItem?id=1"],
      }, request.method === "HEAD");
      return;
    }

    if (apiPath === "/api/Items") {
      const items = loadVisibleItems();
      const result = queryItems(items, requestUrl.searchParams)
        .map((item) => publicItem(item, request));
      sendJson(response, 200, result, request.method === "HEAD");
      return;
    }

    if (apiPath === "/api/GetItem") {
      const idText = requestUrl.searchParams.get("id");
      if (idText === null || !/^-?\d+$/.test(idText)) {
        sendJson(response, 400, { error: "The id query parameter is required." }, request.method === "HEAD");
        return;
      }

      const item = loadVisibleItems().find((candidate) => Number(candidate.Id) === Number(idText));
      if (!item) {
        sendJson(response, 200, emptyItem(request), request.method === "HEAD");
        return;
      }

      sendJson(response, 200, publicItem(item, request), request.method === "HEAD");
      return;
    }

    if (requestUrl.pathname.startsWith("/previews/") || requestUrl.pathname.startsWith("/payloads/")) {
      servePublicFile(requestUrl.pathname, request, response);
      return;
    }

    sendJson(response, 404, { error: "Not found" }, request.method === "HEAD");
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: "Server error" }, request.method === "HEAD");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Marble Race server is running on port ${PORT}.`);
  console.log(`On this PC: http://localhost:${PORT}/api/Items`);
  console.log(`On Android: http://YOUR-PC-IP:${PORT}/api/Items`);
});

function loadItems() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(ITEMS_FILE, "utf8"));
  } catch (error) {
    throw new Error(`Could not read items.json: ${error.message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error("items.json must contain a JSON array.");
  }
  return parsed;
}

function loadVisibleItems() {
  const hiddenItemIds = loadHiddenItemIds();
  const overrides = loadMetadataOverrides();
  return loadItems()
    .filter((item) => !hiddenItemIds.has(Number(item.Id)))
    .map((item) => ({ ...item, ...(overrides[String(item.Id)] || {}) }));
}

function loadHiddenItemIds() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(HIDDEN_ITEMS_FILE, "utf8"));
  } catch (error) {
    throw new Error(`Could not read hidden-workshop-items.json: ${error.message}`);
  }

  if (!parsed || !Array.isArray(parsed.HiddenItemIds)) {
    throw new Error("hidden-workshop-items.json must contain a HiddenItemIds array.");
  }
  return new Set(parsed.HiddenItemIds.map(Number));
}

function loadMetadataOverrides() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(METADATA_OVERRIDES_FILE, "utf8"));
  } catch (error) {
    throw new Error(`Could not read metadata-overrides.json: ${error.message}`);
  }

  if (!parsed || !parsed.Items || typeof parsed.Items !== "object" || Array.isArray(parsed.Items)) {
    throw new Error("metadata-overrides.json must contain an Items object.");
  }
  return parsed.Items;
}

// Different game builds/custom-server screens may expect either a host URL or
// an API base URL. Accept the common combinations so both entries work.
function normalizeApiPath(urlPath) {
  if (["/Items", "/api/Items", "/api/api/Items"].includes(urlPath)) {
    return "/api/Items";
  }
  if (["/GetItem", "/api/GetItem", "/api/api/GetItem"].includes(urlPath)) {
    return "/api/GetItem";
  }
  return urlPath;
}

function queryItems(items, params) {
  const search = (params.get("search") || "").trim().toLocaleLowerCase();
  const searchedId = /^\d+$/.test(search) ? Number(search) : null;
  const types = new Set(
    (params.get("type") || "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => /^\d+$/.test(value))
      .map(Number),
  );
  const itemVersion = params.get("itemVersion");
  const timeFrom = optionalInteger(params.get("timeFrom"));
  const timeTo = optionalInteger(params.get("timeTo"));
  const skip = parseInteger(params.get("skip"), 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = parseInteger(params.get("limit"), 10, 0, 1000);
  const sort = (params.get("sort") || "popular").toLocaleLowerCase();

  const filtered = items.filter((item) => {
    const searchable = [item.Name, item.Description, ...(Array.isArray(item.Tags) ? item.Tags : [])]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase();
    return (!search || searchable.includes(search) || Number(item.Id) === searchedId)
      && (types.size === 0 || types.has(Number(item.ResourceType)))
      && (!itemVersion || String(item.Version) === itemVersion)
      && (timeFrom === null || Number(item.TimeStamp) >= timeFrom)
      && (timeTo === null || Number(item.TimeStamp) <= timeTo);
  });

  if (sort === "new") {
    filtered.sort((a, b) => Number(b.TimeStamp) - Number(a.TimeStamp));
  } else if (sort === "old") {
    filtered.sort((a, b) => Number(a.TimeStamp) - Number(b.TimeStamp));
  } else if (sort === "top") {
    filtered.sort((a, b) => Number(b.Rating || 0) - Number(a.Rating || 0));
  } else {
    filtered.sort((a, b) => Number(b.Downloads || 0) - Number(a.Downloads || 0));
  }

  return filtered.slice(skip, skip + limit);
}

function publicItem(item, request) {
  const previewUri = absoluteUri(item.PreviewUri, request);
  const payloadUri = absoluteUri(item.PayloadUri, request);
  let payloadLength = Number(item.PayloadLength) || 0;

  if (typeof item.PayloadUri === "string" && item.PayloadUri.startsWith("/payloads/")) {
    const localPath = safePublicPath(item.PayloadUri);
    if (localPath && fs.existsSync(localPath)) {
      payloadLength = fs.statSync(localPath).size;
    }
  }

  return {
    Id: Number(item.Id),
    Name: String(item.Name || ""),
    ResourceType: Number(item.ResourceType),
    TimeStamp: Number(item.TimeStamp),
    AuthorId: rawInteger(item.AuthorId),
    AuthorName: String(item.AuthorName || ""),
    PreviewUri: previewUri,
    PayloadUri: payloadUri,
    Description: String(item.Description || ""),
    PayloadLength: payloadLength,
    Version: String(item.Version || ""),
  };
}

function emptyItem(request) {
  const forwardedProto = request.headers["x-forwarded-proto"];
  const protocol = forwardedProto ? String(forwardedProto).split(",")[0].trim() : "http";
  const host = request.headers.host || `localhost:${PORT}`;
  const origin = `${protocol}://${host}/`;
  return {
    Id: 0,
    Name: "",
    ResourceType: 0,
    TimeStamp: 0,
    AuthorId: 0,
    AuthorName: "",
    PreviewUri: origin,
    PayloadUri: origin,
    Description: "",
    PayloadLength: 0,
    Version: "0.0",
  };
}

function absoluteUri(uri, request) {
  if (!uri) return "";
  if (/^https?:\/\//i.test(uri)) return uri;
  const forwardedProto = request.headers["x-forwarded-proto"];
  const protocol = forwardedProto ? String(forwardedProto).split(",")[0].trim() : "http";
  const host = request.headers.host || `localhost:${PORT}`;
  return new URL(uri, `${protocol}://${host}`).toString();
}

function servePublicFile(urlPath, request, response) {
  const filePath = safePublicPath(urlPath);
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendJson(response, 404, { error: "File not found" }, request.method === "HEAD");
    return;
  }

  const stats = fs.statSync(filePath);
  const headers = {
    ...corsHeaders(),
    "Content-Type": MIME_TYPES[path.extname(filePath).toLocaleLowerCase()] || "application/octet-stream",
    "Content-Length": stats.size,
    "Cache-Control": "public, max-age=300",
  };
  response.writeHead(200, headers);
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  fs.createReadStream(filePath).pipe(response);
}

function safePublicPath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const relative = decoded.replace(/^\/+/, "");
  const resolved = path.resolve(PUBLIC_DIR, relative);
  const rootWithSeparator = `${path.resolve(PUBLIC_DIR)}${path.sep}`;
  return resolved.startsWith(rootWithSeparator) ? resolved : null;
}

function sendJson(response, status, value, headOnly = false) {
  const body = Buffer.from(stringifyApiJson(value, 2));
  response.writeHead(status, {
    ...corsHeaders(),
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  response.end(headOnly ? undefined : body);
}

function stringifyApiJson(value, spacing) {
  const integers = [];
  const markerPrefix = `__MARBLE_INT64_${randomUUID()}_`;
  let body = JSON.stringify(value, (_key, candidate) => {
    if (candidate && typeof candidate === "object" && typeof candidate.__rawInteger === "string") {
      const marker = `${markerPrefix}${integers.length}__`;
      integers.push(candidate.__rawInteger);
      return marker;
    }
    return candidate;
  }, spacing);
  integers.forEach((integer, index) => {
    body = body.replace(`"${markerPrefix}${index}__"`, integer);
  });
  return body;
}

function rawInteger(value) {
  const text = String(value ?? 0);
  if (!/^-?\d+$/.test(text)) return 0;
  if (Number.isSafeInteger(Number(text))) return Number(text);
  return { __rawInteger: text };
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function parseInteger(value, fallback, minimum, maximum) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}

function optionalInteger(value) {
  if (value === null || value === "") return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}
