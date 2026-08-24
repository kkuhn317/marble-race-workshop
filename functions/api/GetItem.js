import { items, json, publicItem } from "../../cloudflare/catalog.mjs";

export function onRequestGet(context) {
  const url = new URL(context.request.url);
  const idText = url.searchParams.get("id");
  if (idText === null || !/^\d+$/.test(idText)) {
    return json({ error: "The id query parameter is required." }, 400);
  }

  const item = items.find((candidate) => candidate.Id === Number(idText));
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
