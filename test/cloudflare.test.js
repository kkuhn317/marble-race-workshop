"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

async function visibleCatalogItems(predicate = () => true) {
  const { items } = await import("../cloudflare/catalog.mjs");
  const { isHiddenItemId } = await import("../cloudflare/moderation.mjs");
  const { applyMetadataOverrides } = await import("../cloudflare/metadata-overrides.mjs");
  return items
    .filter((item) => !isHiddenItemId(item.Id))
    .map(applyMetadataOverrides)
    .filter(predicate);
}

async function visibleCatalogItem(predicate = () => true) {
  const [item] = await visibleCatalogItems(predicate);
  assert.ok(item, "The test requires at least one matching visible catalog item");
  return item;
}

test("Cloudflare moderation matches the saved reversible decision list", async () => {
  const { hiddenItemIds } = await import("../cloudflare/moderation.mjs");
  const saved = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../hidden-workshop-items.json"), "utf8"));
  assert.deepEqual([...hiddenItemIds].sort((a, b) => a - b), [...saved.HiddenItemIds].sort((a, b) => a - b));
});

test("Cloudflare metadata overrides match the persistent override file", async () => {
  const { metadataOverrides } = await import("../cloudflare/metadata-overrides.mjs");
  const saved = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../metadata-overrides.json"), "utf8"));
  assert.deepEqual(
    Object.fromEntries([...metadataOverrides].map(([id, value]) => [String(id), value])),
    saved.Items,
  );
});

test("Cloudflare repairs every known corrupted workshop title", async () => {
  const { applyMetadataOverrides } = await import("../cloudflare/metadata-overrides.mjs");
  const { items } = await import("../cloudflare/catalog.mjs");
  const expectedTitles = new Map([
    [789, "dark dunkel sombre karanlık"],
    [1272, "551121ｸﾐﾐﾐﾐﾐﾐﾐﾐﾐﾐﾐﾐﾐﾐﾐ"],
    [2034, "粉色 Pink"],
  ]);

  for (const [id, expectedTitle] of expectedTitles) {
    const rawItem = items.find((item) => item.Id === id);
    assert.ok(rawItem, `Expected workshop item ${id} to exist`);
    assert.equal(applyMetadataOverrides(rawItem).Name, expectedTitle);
  }
});

test("Cloudflare repairs every known corrupted workshop username", async () => {
  const items = await visibleCatalogItems((item) => [773, 1003, 1004, 1316, 1317].includes(item.Id));
  assert.equal(items.length, 5);
  assert.ok(items.every((item) => item.AuthorName === "✪ a1um"));
});

test("Cloudflare Items returns levels with deployment-origin URLs", async () => {
  const { onRequestGet } = await import("../functions/api/Items.js");
  const response = onRequestGet({
    request: new Request("https://marble.example.dev/api/Items?type=0&itemVersion=1.6&limit=10&skip=0"),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.length > 0 && body.length <= 10);
  assert.ok(body.every((item) => item.ResourceType === 0));
  assert.ok(body.every((item) => new URL(item.PreviewUri).protocol === "https:"));
  assert.ok(body.every((item) => new URL(item.PayloadUri).protocol === "https:"));
  assert.ok(body.every((item) => Number.isSafeInteger(item.PayloadLength) && item.PayloadLength > 0));
});

test("Cloudflare Items implements filtering and pagination", async () => {
  const { onRequestGet } = await import("../functions/api/Items.js");
  const excludedBySearch = await onRequestGet({
    request: new Request("https://marble.example.dev/api/Items?search=__no_such_workshop_item_9e672d59__"),
  }).json();
  const campaigns = await onRequestGet({
    request: new Request("https://marble.example.dev/api/Items?type=2&limit=1000"),
  }).json();
  const allItems = await onRequestGet({
    request: new Request("https://marble.example.dev/api/Items?limit=1000"),
  }).json();
  const page = await onRequestGet({
    request: new Request("https://marble.example.dev/api/Items?skip=4&limit=1"),
  }).json();
  assert.deepEqual(excludedBySearch, []);
  assert.ok(campaigns.length > 0);
  assert.ok(campaigns.every((item) => item.ResourceType === 2));
  assert.ok(campaigns.every((item) => /^https:\/\/marble\.example\.dev\/api\/Download\?id=\d+$/.test(item.PayloadUri)));
  assert.equal(page.length, 1);
  assert.equal(page[0].Id, allItems[4].Id);
});

test("Cloudflare Items exposes scores and Steam metadata in vote order", async () => {
  const { onRequestGet } = await import("../functions/api/Items.js");
  const { applyFeaturedItem, compareFeaturedItems } = await import("../cloudflare/featured.mjs");
  const expected = (await visibleCatalogItems())
    .map((item) => applyFeaturedItem(item))
    .sort((a, b) => compareFeaturedItems(a, b) || Number(b.Rating || 0) - Number(a.Rating || 0) || Number(a.Id) - Number(b.Id))
    .slice(0, 20);
  const result = await onRequestGet({
    request: new Request("https://marble.example.dev/api/Items?sort=top&limit=20"),
  }).json();

  assert.ok(expected.some((item) => Number(item.Rating) > 0), "The catalog should contain a rated item");
  assert.deepEqual(result.map((item) => item.Id), expected.map((item) => item.Id));
  assert.deepEqual(result.map((item) => item.Rating), expected.map((item) => Number(item.Rating) || 0));
  assert.ok(result.every((item) => Number.isSafeInteger(item.Downloads)));
  assert.ok(result.every((item) => typeof item.SteamWorkshopId === "string"));
  assert.ok(result.every((item) => typeof item.Featured === "boolean"));
});

test("featured items precede vote score without modifying their payload", async () => {
  const { applyFeaturedItem, compareFeaturedItems } = await import("../cloudflare/featured.mjs");
  const ordinary = applyFeaturedItem({ Id: 1, Rating: 100, PreviewUri: "/original-one.png", PayloadUri: "/one.zip" }, 2);
  const featured = applyFeaturedItem({ Id: 2, Rating: 1, PreviewUri: "/original-two.png", PayloadUri: "/two.zip" }, 2);
  const sorted = [ordinary, featured].sort((a, b) => compareFeaturedItems(a, b) || b.Rating - a.Rating);
  assert.equal(sorted[0].Id, 2);
  assert.equal(featured.PreviewUri, "/featured/item-2.png");
  assert.equal(featured.PayloadUri, "/two.zip");
});

test("Items applies the configured feature instead of the Array.map index", async () => {
  const { onRequestGet } = await import("../functions/api/Items.js");
  const { featuredItemId } = await import("../cloudflare/featured.mjs");
  const response = onRequestGet({
    request: new Request("https://marble.example.dev/api/Items?sort=top&limit=1"),
  });
  const [item] = await response.json();

  assert.equal(item.Id, featuredItemId);
  assert.equal(item.Featured, true);
  assert.match(item.PreviewUri, new RegExp(`/featured/item-${featuredItemId}\\.png$`));
});

test("Cloudflare Items finds a visible item by prefixed numeric ID", async () => {
  const { onRequestGet } = await import("../functions/api/Items.js");
  const target = await visibleCatalogItem();
  const missingId = Math.max(...(await visibleCatalogItems()).map((item) => item.Id)) + 100000;
  const hashResult = await onRequestGet({
    request: new Request(`https://marble.example.dev/api/Items?search=%23${target.Id}&limit=1000`),
  }).json();
  const namedResult = await onRequestGet({
    request: new Request(`https://marble.example.dev/api/Items?search=id%3A${target.Id}&limit=1000`),
  }).json();
  const missing = await onRequestGet({
    request: new Request(`https://marble.example.dev/api/Items?search=id%3A${missingId}&limit=1000`),
  }).json();
  assert.ok(hashResult.some((item) => item.Id === target.Id));
  assert.ok(namedResult.some((item) => item.Id === target.Id));
  assert.deepEqual(missing, []);
});

test("Cloudflare Items searches author usernames case-insensitively", async () => {
  const { onRequestGet } = await import("../functions/api/Items.js");
  const target = await visibleCatalogItem((item) => Boolean(item.AuthorName));
  const mixedCaseAuthor = [...target.AuthorName]
    .map((character, index) => index % 2 ? character.toUpperCase() : character.toLowerCase())
    .join("");
  const result = await onRequestGet({
    request: new Request(`https://marble.example.dev/api/Items?search=${encodeURIComponent(mixedCaseAuthor)}&limit=1000`),
  }).json();
  assert.ok(result.some((item) => item.Id === target.Id && item.AuthorName === target.AuthorName));
});

test("Cloudflare GetItem returns one item and 404 for an unknown id", async () => {
  const { onRequestGet } = await import("../functions/api/GetItem.js");
  const target = await visibleCatalogItem();
  const missingId = Math.max(...(await visibleCatalogItems()).map((item) => item.Id)) + 100000;
  const found = onRequestGet({ request: new Request(`https://marble.example.dev/api/GetItem?id=${target.Id}`) });
  const missing = onRequestGet({ request: new Request(`https://marble.example.dev/api/GetItem?id=${missingId}`) });
  assert.equal(found.status, 200);
  assert.equal((await found.json()).Name, target.Name);
  assert.equal(missing.status, 404);
});

test("Cloudflare APIs replace seeded downloads with live D1 counts", async () => {
  const { onRequestGet: listItems } = await import("../functions/api/Items.js");
  const { onRequestGet: getItem } = await import("../functions/api/GetItem.js");
  const target = await visibleCatalogItem();
  const liveCount = Number(target.Downloads || 0) + 37;
  const database = {
    prepare(sql) {
      if (sql.includes(" WHERE item_id IN (")) {
        return { all: async () => ({ results: [{ item_id: target.Id, downloads: liveCount }] }) };
      }
      return {
        bind(id) {
          assert.equal(id, target.Id);
          return { first: async () => ({ downloads: liveCount }) };
        },
      };
    },
  };

  const listResponse = await listItems({
    request: new Request(`https://marble.example.dev/api/Items?search=id:${target.Id}&limit=1`),
    env: { DOWNLOADS_DB: database },
  });
  const [listed] = await listResponse.json();
  const itemResponse = await getItem({
    request: new Request(`https://marble.example.dev/api/GetItem?id=${target.Id}`),
    env: { DOWNLOADS_DB: database },
  });
  const fetched = await itemResponse.json();

  assert.equal(listed.Downloads, liveCount);
  assert.equal(fetched.Downloads, liveCount);
  assert.equal(listed.PayloadUri, `https://marble.example.dev/api/Download?id=${target.Id}`);
  assert.equal(fetched.PayloadUri, `https://marble.example.dev/api/Download?id=${target.Id}`);
});

test("Cloudflare Download streams a payload with the workshop item name", async () => {
  const { onRequestGet, buildDownloadFilename } = await import("../functions/api/Download.js");
  const target = await visibleCatalogItem((item) => Boolean(item.PayloadUri));
  let fetchedUrl = "";
  const response = await onRequestGet({
    request: new Request(`https://marble.example.dev/api/Download?id=${target.Id}`),
    fetch: async (url) => {
      fetchedUrl = String(url);
      return new Response("zip bytes", {
        headers: { "content-type": "application/octet-stream", "content-length": "9" },
      });
    },
  });

  const filename = buildDownloadFilename(target.Name, target.Id);
  assert.equal(fetchedUrl, target.PayloadUri);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/zip");
  assert.match(response.headers.get("content-disposition"), /^attachment; filename=/);
  assert.ok(response.headers.get("content-disposition").includes(encodeURIComponent(filename)));
  assert.equal(await response.text(), "zip bytes");
});

test("Cloudflare Download counts only successful initial GET requests", async () => {
  const { onRequestGet } = await import("../functions/api/Download.js");
  const { shouldCountDownload } = await import("../cloudflare/download-counts.mjs");
  const target = await visibleCatalogItem((item) => Boolean(item.PayloadUri));
  const writes = [];
  const pending = [];
  const database = {
    prepare(sql) {
      assert.match(sql, /INSERT INTO download_counts/);
      return {
        bind(...values) {
          return { run: async () => { writes.push(values); } };
        },
      };
    },
  };
  const response = await onRequestGet({
    request: new Request(`https://marble.example.dev/api/Download?id=${target.Id}`, {
      headers: { range: "bytes=0-" },
    }),
    env: { DOWNLOADS_DB: database },
    waitUntil: (promise) => pending.push(promise),
    fetch: async () => new Response("zip bytes", { status: 206 }),
  });
  await Promise.all(pending);

  assert.equal(response.status, 206);
  assert.deepEqual(writes, [[target.Id, Number(target.Downloads || 0)]]);
  assert.equal(shouldCountDownload(new Request("https://example.test/file.zip")), true);
  assert.equal(shouldCountDownload(new Request("https://example.test/file.zip", { method: "HEAD" })), false);
  assert.equal(shouldCountDownload(new Request("https://example.test/file.zip", { headers: { range: "bytes=10-" } })), false);
});

test("D1 migration retains a valid historical seed snapshot as the catalog grows", () => {
  const catalog = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../items.json"), "utf8"));
  const migration = fs.readFileSync(path.resolve(__dirname, "../migrations/0001_seed_download_counts.sql"), "utf8");
  const seedRows = [...migration.matchAll(/\((\d+), (\d+), unixepoch\(\)\)/g)];
  const seeded = new Map(
    seedRows.map((match) => [Number(match[1]), Number(match[2])]),
  );
  assert.ok(seedRows.length > 0);
  assert.equal(seeded.size, seedRows.length, "Seed item IDs must be unique");
  assert.match(migration, /ON CONFLICT\(item_id\) DO UPDATE SET downloads = MAX\(download_counts\.downloads, excluded\.downloads\)/);
  for (const [id, downloads] of seeded) {
    assert.ok(Number.isSafeInteger(id) && id >= 0);
    assert.ok(Number.isSafeInteger(downloads) && downloads >= 0);
  }
  for (const item of catalog) {
    assert.ok(Number.isSafeInteger(Number(item.Id)) && Number(item.Id) >= 0);
    assert.ok(Number.isSafeInteger(Number(item.Downloads || 0)) && Number(item.Downloads || 0) >= 0);
  }
});

test("Cloudflare Download sanitizes unsafe filenames and rejects missing items", async () => {
  const { onRequestGet, buildDownloadFilename } = await import("../functions/api/Download.js");
  assert.equal(buildDownloadFilename('Bad <name>: "test".zip', 42), "Bad _name__ _test_.zip");
  assert.equal(buildDownloadFilename("CON", 42), "workshop-item-42.zip");
  const response = await onRequestGet({
    request: new Request("https://marble.example.dev/api/Download?id=999999999"),
    fetch: async () => { throw new Error("A missing item must not fetch a payload"); },
  });
  assert.equal(response.status, 404);
});

test("Cloudflare hides moderated items from listings and direct lookups", async () => {
  const { onRequestGet: listItems } = await import("../functions/api/Items.js");
  const { onRequestGet: getItem } = await import("../functions/api/GetItem.js");
  const { hiddenItemIds } = await import("../cloudflare/moderation.mjs");
  const hiddenId = hiddenItemIds.values().next().value;
  const listed = await listItems({
    request: new Request("https://marble.example.dev/api/Items?limit=1000"),
  }).json();

  assert.ok(hiddenItemIds.size > 0);
  assert.ok(!listed.some((item) => hiddenItemIds.has(item.Id)));
  const hiddenResponse = getItem({ request: new Request(`https://marble.example.dev/api/GetItem?id=${hiddenId}`) });
  assert.equal(hiddenResponse.status, 404);
  const searched = await listItems({
    request: new Request(`https://marble.example.dev/api/Items?search=${hiddenId}&limit=1000`),
  }).json();
  assert.ok(!searched.some((item) => item.Id === hiddenId));
});

test("Cloudflare applies metadata overrides before searching and returning items", async () => {
  const { onRequestGet: listItems } = await import("../functions/api/Items.js");
  const { onRequestGet: getItem } = await import("../functions/api/GetItem.js");
  const { metadataOverrides } = await import("../cloudflare/metadata-overrides.mjs");
  const target = await visibleCatalogItem();
  const previousOverride = metadataOverrides.get(target.Id);
  metadataOverrides.set(target.Id, { Name: "Temporary Override Name", AuthorName: "Corrected Author" });
  try {
    const found = await getItem({ request: new Request(`https://marble.example.dev/api/GetItem?id=${target.Id}`) }).json();
    const searchedByName = await listItems({
      request: new Request("https://marble.example.dev/api/Items?search=temporary%20override%20name&limit=1000"),
    }).json();
    const searchedByAuthor = await listItems({
      request: new Request("https://marble.example.dev/api/Items?search=corrected%20author&limit=1000"),
    }).json();
    assert.equal(found.AuthorName, "Corrected Author");
    assert.ok(searchedByName.some((item) => item.Id === target.Id && item.Name === "Temporary Override Name"));
    assert.ok(searchedByAuthor.some((item) => item.Id === target.Id && item.AuthorName === "Corrected Author"));
  } finally {
    if (previousOverride) metadataOverrides.set(target.Id, previousOverride);
    else metadataOverrides.delete(target.Id);
  }
});

test("Cloudflare JSON preserves exact 64-bit Steam author IDs", async () => {
  const { stringifyApiJson } = await import("../cloudflare/catalog.mjs");
  const body = stringifyApiJson({ AuthorId: { __rawInteger: "76561199387555910" } });
  assert.equal(body, '{"AuthorId":76561199387555910}');
});

test("Worker entry point routes API requests and delegates assets", async () => {
  const worker = (await import("../worker.mjs")).default;
  const env = {
    ASSETS: {
      fetch: async () => new Response("asset"),
    },
  };
  const apiResponse = await worker.fetch(
    new Request("https://marble.example.dev/api/Items?type=0"),
    env,
  );
  const assetResponse = await worker.fetch(
    new Request("https://marble.example.dev/previews/shuriken-race.jpg"),
    env,
  );
  assert.equal(apiResponse.status, 200);
  const levels = await apiResponse.json();
  assert.ok(levels.length > 0);
  assert.ok(levels.every((item) => item.ResourceType === 0));
  assert.equal(await assetResponse.text(), "asset");
});
