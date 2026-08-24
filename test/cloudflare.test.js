"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("Cloudflare Items returns the level with deployment-origin URLs", async () => {
  const { onRequestGet } = await import("../functions/api/Items.js");
  const response = onRequestGet({
    request: new Request("https://marble.example.dev/api/Items?type=0&itemVersion=1.6&limit=10&skip=0"),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.length, 1);
  assert.equal(body[0].Name, "Shuriken Race");
  assert.equal(body[0].Version, "0.0");
  assert.equal(body[0].AuthorId, 0);
  assert.equal(body[0].PayloadLength, 385028);
  assert.equal(body[0].PayloadUri, "https://marble.example.dev/payloads/shuriken-race.zip");
});

test("Cloudflare Items implements filtering and pagination", async () => {
  const { onRequestGet } = await import("../functions/api/Items.js");
  const excludedBySearch = await onRequestGet({
    request: new Request("https://marble.example.dev/api/Items?search=missing"),
  }).json();
  const excludedByType = await onRequestGet({
    request: new Request("https://marble.example.dev/api/Items?type=2"),
  }).json();
  const excludedBySkip = await onRequestGet({
    request: new Request("https://marble.example.dev/api/Items?skip=1"),
  }).json();
  assert.deepEqual(excludedBySearch, []);
  assert.deepEqual(excludedByType, []);
  assert.deepEqual(excludedBySkip, []);
});

test("Cloudflare GetItem returns one item and 404 for an unknown id", async () => {
  const { onRequestGet } = await import("../functions/api/GetItem.js");
  const found = onRequestGet({ request: new Request("https://marble.example.dev/api/GetItem?id=1") });
  const missing = onRequestGet({ request: new Request("https://marble.example.dev/api/GetItem?id=99") });
  assert.equal(found.status, 200);
  assert.equal((await found.json()).Name, "Shuriken Race");
  assert.equal(missing.status, 404);
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
  assert.equal((await apiResponse.json())[0].Name, "Shuriken Race");
  assert.equal(await assetResponse.text(), "asset");
});
