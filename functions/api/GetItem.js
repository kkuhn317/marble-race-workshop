import { items, json, publicItem } from "../../cloudflare/catalog.mjs";
import { isHiddenItemId } from "../../cloudflare/moderation.mjs";
import { applyMetadataOverrides } from "../../cloudflare/metadata-overrides.mjs";

export function onRequestGet(context) {
  const url = new URL(context.request.url);
  const idText = url.searchParams.get("id");
  if (idText === null || !/^\d+$/.test(idText)) {
    return json({ error: "The id query parameter is required." }, 400);
  }

  const id = Number(idText);
  const item = isHiddenItemId(id)
    ? undefined
    : items.map(applyMetadataOverrides).find((candidate) => candidate.Id === id);
  // Marble Race uses GetItem for numeric searches and displays non-success
  // responses as popups. A JSON null is a successful empty result.
  return json(item ? publicItem(item, context.request.url) : null);
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
