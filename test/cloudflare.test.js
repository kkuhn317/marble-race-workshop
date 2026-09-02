"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("Cloudflare moderation matches the saved reversible decision list", async () => {
  const { hiddenItemIds } = await import("../cloudflare/moderation.mjs");
  const saved = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../hidden-workshop-items.json"), "utf8"));
  assert.deepEqual([...hiddenItemIds].sort((a, b) => a - b), [...saved.HiddenItemIds].sort((a, b) => a - b));
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
  const shuriken = body.find((item) => item.Name === "Shuriken Race");
  assert.ok(shuriken);
  assert.equal(shuriken.Version, "0.0");
  assert.equal(shuriken.AuthorId, 0);
  assert.equal(shuriken.PayloadLength, 385028);
  assert.equal(shuriken.PayloadUri, "https://content.marble.kevin-kuhn.dev/payloads/shuriken-race.zip");
});

test("Cloudflare Items implements filtering and pagination", async () => {
  const { onRequestGet } = await import("../functions/api/Items.js");
  const excludedBySearch = await onRequestGet({
    request: new Request("https://marble.example.dev/api/Items?search=__no_such_workshop_item_9e672d59__"),
  }).json();
  const campaigns = await onRequestGet({
    request: new Request("https://marble.example.dev/api/Items?type=2"),
  }).json();
  const page = await onRequestGet({
    request: new Request("https://marble.example.dev/api/Items?skip=4&limit=1"),
  }).json();
  assert.deepEqual(excludedBySearch, []);
  assert.ok(campaigns.some((item) => item.Name === "Hamsterball V 2.4.2"));
  assert.ok(campaigns.some((item) => item.Name === "Kry Pack 2"));
  assert.ok(campaigns.every((item) => /^https:\/\/content\.marble\.kevin-kuhn\.dev\//.test(item.PayloadUri)));
  assert.equal(page.length, 1);
});

test("Cloudflare GetItem returns one item and 404 for an unknown id", async () => {
  const { onRequestGet } = await import("../functions/api/GetItem.js");
  const found = onRequestGet({ request: new Request("https://marble.example.dev/api/GetItem?id=1") });
  const missing = onRequestGet({ request: new Request("https://marble.example.dev/api/GetItem?id=42424242") });
  assert.equal(found.status, 200);
  assert.equal((await found.json()).Name, "Shuriken Race");
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
  assert.equal(getItem({ request: new Request(`https://marble.example.dev/api/GetItem?id=${hiddenId}`) }).status, 404);
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
  const levelNames = (await apiResponse.json()).map((item) => item.Name);
  assert.ok(levelNames.includes("Interlude"));
  assert.ok(levelNames.includes("Shuriken Race"));
  assert.ok(levelNames.includes("The Embered Racing"));
  assert.equal(await assetResponse.text(), "asset");
});
