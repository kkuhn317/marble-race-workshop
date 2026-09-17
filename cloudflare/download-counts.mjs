export async function applyDownloadCounts(database, items) {
  if (!database || items.length === 0) return items;
  try {
    const itemIds = items
      .map((item) => Number(item.Id))
      .filter((id) => Number.isSafeInteger(id) && id >= 0);
    if (itemIds.length === 0) return items;
    const result = await database
      .prepare(`SELECT item_id, downloads FROM download_counts WHERE item_id IN (${itemIds.join(",")})`)
      .all();
    const counts = new Map((result.results || []).map((row) => [Number(row.item_id), normalizedCount(row.downloads)]));
    return items.map((item) => counts.has(Number(item.Id))
      ? { ...item, Downloads: counts.get(Number(item.Id)) }
      : item);
  } catch (error) {
    console.warn(JSON.stringify({ event: "download_counts_read_failed", message: errorMessage(error) }));
    return items;
  }
}

export async function applyDownloadCount(database, item) {
  if (!database || !item) return item;
  try {
    const row = await database
      .prepare("SELECT downloads FROM download_counts WHERE item_id = ?1")
      .bind(Number(item.Id))
      .first();
    return row ? { ...item, Downloads: normalizedCount(row.downloads) } : item;
  } catch (error) {
    console.warn(JSON.stringify({ event: "download_count_read_failed", itemId: Number(item.Id), message: errorMessage(error) }));
    return item;
  }
}

export async function incrementDownloadCount(database, item) {
  if (!database || !item) return;
  await database
    .prepare(`INSERT INTO download_counts (item_id, downloads, updated_at)
      VALUES (?1, ?2 + 1, unixepoch())
      ON CONFLICT(item_id) DO UPDATE SET
        downloads = download_counts.downloads + 1,
        updated_at = unixepoch()`)
    .bind(Number(item.Id), normalizedCount(item.Downloads))
    .run();
}

export function shouldCountDownload(request) {
  if (request.method !== "GET") return false;
  const range = request.headers.get("range");
  return range === null || /^bytes=0-/i.test(range.trim());
}

export function downloadPayloadUri(itemId, requestUrl) {
  const url = new URL("/api/Download", requestUrl);
  url.searchParams.set("id", String(itemId));
  return url.toString();
}

function normalizedCount(value) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
