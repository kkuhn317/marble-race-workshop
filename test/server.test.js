"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const PORT = 31847;
let child;

test.before(async () => {
  child = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, MARBLE_PORT: String(PORT), MARBLE_HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Server did not start")), 5000);
    child.once("error", reject);
    child.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("server is running")) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
});

test.after(() => {
  if (child) child.kill();
});

test("Items returns all registered workshop items", async () => {
  const response = await fetch(`http://127.0.0.1:${PORT}/api/Items?limit=1000`);
  assert.equal(response.status, 200);
  const items = await response.json();
  assert.ok(items.length >= 5);
  const shuriken = items.find((item) => item.Name === "Shuriken Race");
  assert.equal(shuriken.ResourceType, 0);
  assert.equal(shuriken.PayloadLength, 385028);
  assert.ok(items.filter((item) => item.ResourceType === 2).length >= 2);
});

test("Items accepts custom-server URL path variants", async () => {
  const expectedCount = await fetch(`http://127.0.0.1:${PORT}/api/Items`).then((response) => response.json()).then((items) => items.length);
  for (const path of ["/Items", "/api/api/Items"]) {
    const response = await fetch(`http://127.0.0.1:${PORT}${path}`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).length, expectedCount);
  }
});

test("Items finds a visible item by prefixed numeric ID", async () => {
  const hashItems = await fetch(`http://127.0.0.1:${PORT}/api/Items?search=%2310001&limit=1000`).then((response) => response.json());
  const namedItems = await fetch(`http://127.0.0.1:${PORT}/api/Items?search=id%3A10001&limit=1000`).then((response) => response.json());
  const missing = await fetch(`http://127.0.0.1:${PORT}/api/Items?search=id%3A999999&limit=1000`).then((response) => response.json());
  assert.deepEqual(hashItems.map((item) => item.Id), [10001]);
  assert.deepEqual(namedItems.map((item) => item.Id), [10001]);
  assert.deepEqual(missing, []);
});

test("Items searches author usernames case-insensitively", async () => {
  const items = await fetch(`http://127.0.0.1:${PORT}/api/Items?search=bOoKwOrMkEvIn&limit=1000`).then((response) => response.json());
  assert.ok(items.some((item) => item.Id === 10001 && item.AuthorName === "BookwormKevin"));
});

test("The registered level has a local preview and an R2 payload", async () => {
  const item = await fetch(`http://127.0.0.1:${PORT}/api/GetItem?id=1`).then((response) => response.json());
  const preview = await fetch(item.PreviewUri);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("content-type"), "image/jpeg");
  assert.equal(item.PayloadUri, "https://content.marble.kevin-kuhn.dev/payloads/shuriken-race.zip");
  assert.equal(item.PayloadLength, 385028);
});

test("GetItem returns 404 for an unknown item", async () => {
  const response = await fetch(`http://127.0.0.1:${PORT}/api/GetItem?id=42424242`);
  assert.equal(response.status, 404);
});

test("Hidden items are absent from listings and direct lookups", async () => {
  const moderation = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../hidden-workshop-items.json"), "utf8"));
  const hiddenIds = new Set(moderation.HiddenItemIds);
  const items = await fetch(`http://127.0.0.1:${PORT}/api/Items?limit=1000`).then((response) => response.json());
  const hiddenId = moderation.HiddenItemIds[0];

  assert.ok(hiddenIds.size > 0);
  assert.ok(!items.some((item) => hiddenIds.has(item.Id)));
  const hiddenResponse = await fetch(`http://127.0.0.1:${PORT}/api/GetItem?id=${hiddenId}`);
  assert.equal(hiddenResponse.status, 404);
  const searched = await fetch(`http://127.0.0.1:${PORT}/api/Items?search=${hiddenId}&limit=1000`).then((response) => response.json());
  assert.ok(!searched.some((item) => item.Id === hiddenId));
});

test("GetItem validates a missing id", async () => {
  const response = await fetch(`http://127.0.0.1:${PORT}/api/GetItem`);
  assert.equal(response.status, 400);
});
