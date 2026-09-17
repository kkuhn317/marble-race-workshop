import { items } from "../../cloudflare/catalog.mjs";
import { isHiddenItemId } from "../../cloudflare/moderation.mjs";
import { applyMetadataOverrides } from "../../cloudflare/metadata-overrides.mjs";

const FORWARDED_REQUEST_HEADERS = ["range", "if-range", "if-none-match", "if-modified-since"];

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const idText = url.searchParams.get("id");
  if (idText === null || !/^\d+$/.test(idText)) return errorResponse("The id query parameter is required.", 400);

  const id = Number(idText);
  const item = isHiddenItemId(id)
    ? undefined
    : items.map(applyMetadataOverrides).find((candidate) => candidate.Id === id);
  if (!item || !item.PayloadUri) return errorResponse("Item not found", 404);

  return proxyItemDownload(item, context.request, context.fetch || fetch);
}

export async function proxyItemDownload(item, request, fetchPayload = fetch) {
  const payloadUrl = new URL(item.PayloadUri);
  if (payloadUrl.protocol !== "https:") return errorResponse("The item payload URL is invalid.", 502);

  const requestHeaders = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) requestHeaders.set(name, value);
  }

  let upstream;
  try {
    upstream = await fetchPayload(payloadUrl, {
      method: request.method === "HEAD" ? "HEAD" : "GET",
      headers: requestHeaders,
      redirect: "follow",
    });
  } catch {
    return errorResponse("The item payload could not be downloaded.", 502);
  }

  if (!upstream.ok && upstream.status !== 206 && upstream.status !== 304) {
    return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
  }

  const filename = buildDownloadFilename(item.Name, item.Id);
  const headers = new Headers(upstream.headers);
  headers.set("content-disposition", contentDisposition(filename));
  headers.set("content-type", "application/zip");
  headers.set("x-content-type-options", "nosniff");
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

export function buildDownloadFilename(name, id) {
  let base = String(name || "")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  if (/\.zip$/i.test(base)) base = base.slice(0, -4).replace(/[. ]+$/g, "");
  base = [...base].slice(0, 150).join("").replace(/[. ]+$/g, "");
  if (!base || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)) base = `workshop-item-${id}`;
  return `${base}.zip`;
}

function contentDisposition(filename) {
  const fallback = filename
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function errorResponse(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
