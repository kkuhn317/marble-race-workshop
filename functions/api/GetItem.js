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
  return item
    ? json(publicItem(item, context.request.url))
    : json({ error: "Item not found" }, 404);
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
