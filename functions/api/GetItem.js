import { items, json, publicItem } from "../../cloudflare/catalog.mjs";
import { isHiddenItemId } from "../../cloudflare/moderation.mjs";
import { applyMetadataOverrides } from "../../cloudflare/metadata-overrides.mjs";
import { applyFeaturedItem } from "../../cloudflare/featured.mjs";
import { applyDownloadCount, downloadPayloadUri } from "../../cloudflare/download-counts.mjs";

export function onRequestGet(context) {
  const url = new URL(context.request.url);
  const idText = url.searchParams.get("id");
  if (idText === null || !/^\d+$/.test(idText)) {
    return json({ error: "The id query parameter is required." }, 400);
  }

  const id = Number(idText);
  const item = isHiddenItemId(id)
    ? undefined
    : items.map(applyMetadataOverrides).map((candidate) => applyFeaturedItem(candidate)).find((candidate) => candidate.Id === id);
  if (!item) return json({ error: "Item not found" }, 404);
  if (!context.env?.DOWNLOADS_DB) return json(publicDownloadItem(item, context.request.url));
  return applyDownloadCount(context.env.DOWNLOADS_DB, item)
    .then((countedItem) => json(publicDownloadItem(countedItem, context.request.url)));
}

function publicDownloadItem(item, requestUrl) {
  return {
    ...publicItem(item, requestUrl),
    PayloadUri: downloadPayloadUri(item.Id, requestUrl),
  };
}

export function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
    },
  });
}
