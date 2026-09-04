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
  assert.ok(campaigns.every((item) => /^https:\/\/content\.marble\.kevin-kuhn\.dev\//.test(item.PayloadUri)));
  assert.equal(page.length, 1);
  assert.equal(page[0].Id, allItems[4].Id);
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
