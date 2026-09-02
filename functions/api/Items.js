import { items, json, publicItem } from "../../cloudflare/catalog.mjs";
import { isHiddenItemId } from "../../cloudflare/moderation.mjs";
import { applyMetadataOverrides } from "../../cloudflare/metadata-overrides.mjs";

export function onRequestGet(context) {
  const url = new URL(context.request.url);
  const search = (url.searchParams.get("search") || "").trim().toLowerCase();
  const searchedId = parseSearchedId(search);
  const types = new Set(
    (url.searchParams.get("type") || "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => /^\d+$/.test(value))
      .map(Number),
  );
  const skip = boundedInteger(url.searchParams.get("skip"), 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = boundedInteger(url.searchParams.get("limit"), 10, 0, 1000);
  const timeFrom = optionalInteger(url.searchParams.get("timeFrom"));
  const timeTo = optionalInteger(url.searchParams.get("timeTo"));
  const sort = (url.searchParams.get("sort") || "new").toLowerCase();

  const result = items
    .map(applyMetadataOverrides)
    .filter((item) => {
      const searchable = [item.Name, item.AuthorName, item.Description, ...(item.Tags || [])]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return !isHiddenItemId(item.Id)
        && (!search || searchable.includes(search) || item.Id === searchedId)
        && (types.size === 0 || types.has(item.ResourceType))
        && (timeFrom === null || item.TimeStamp >= timeFrom)
        && (timeTo === null || item.TimeStamp <= timeTo);
    })
    .sort((a, b) => {
      if (sort === "new") return b.TimeStamp - a.TimeStamp;
      if (sort === "top") return (b.Rating || 0) - (a.Rating || 0) || a.Id - b.Id;
      return a.Id - b.Id;
    })
    .slice(skip, skip + limit)
    .map((item) => publicItem(item, context.request.url));

  // itemVersion is intentionally accepted but not used. An item's Version
  // tells the client whether it is compatible; it is not a server-side filter.
  return json(result);
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

function boundedInteger(value, fallback, minimum, maximum) {
  if (value === null || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}

function optionalInteger(value) {
  if (value === null || value === "") return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseSearchedId(search) {
  const match = /^(?:(?:#|id:)\s*)?(\d+)$/i.exec(search);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : null;
}
