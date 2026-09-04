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
  assert.ok(items.length > 0);
  assert.ok(items.some((item) => item.ResourceType === 0));
  assert.ok(items.some((item) => item.ResourceType === 2));
  assert.ok(items.every((item) => Number.isSafeInteger(item.PayloadLength) && item.PayloadLength > 0));
});

test("Local server serves the workshop browser and its assets", async () => {
  const homepage = await fetch(`http://127.0.0.1:${PORT}/`);
  const stylesheet = await fetch(`http://127.0.0.1:${PORT}/styles.css`);
  const script = await fetch(`http://127.0.0.1:${PORT}/app.js`);
  assert.equal(homepage.status, 200);
  assert.match(homepage.headers.get("content-type"), /^text\/html/);
  assert.match(await homepage.text(), /id="item-grid"/);
  assert.match(stylesheet.headers.get("content-type"), /^text\/css/);
  assert.match(script.headers.get("content-type"), /^text\/javascript/);
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
  const visible = await fetch(`http://127.0.0.1:${PORT}/api/Items?limit=1000`).then((response) => response.json());
  const target = visible[0];
  const missingId = Math.max(...visible.map((item) => item.Id)) + 100000;
  const hashItems = await fetch(`http://127.0.0.1:${PORT}/api/Items?search=%23${target.Id}&limit=1000`).then((response) => response.json());
  const namedItems = await fetch(`http://127.0.0.1:${PORT}/api/Items?search=id%3A${target.Id}&limit=1000`).then((response) => response.json());
  const missing = await fetch(`http://127.0.0.1:${PORT}/api/Items?search=id%3A${missingId}&limit=1000`).then((response) => response.json());
  assert.ok(hashItems.some((item) => item.Id === target.Id));
  assert.ok(namedItems.some((item) => item.Id === target.Id));
  assert.deepEqual(missing, []);
});

test("Items searches author usernames case-insensitively", async () => {
  const visible = await fetch(`http://127.0.0.1:${PORT}/api/Items?limit=1000`).then((response) => response.json());
  const target = visible.find((item) => item.AuthorName);
  const mixedCaseAuthor = [...target.AuthorName]
    .map((character, index) => index % 2 ? character.toUpperCase() : character.toLowerCase())
    .join("");
  const items = await fetch(`http://127.0.0.1:${PORT}/api/Items?search=${encodeURIComponent(mixedCaseAuthor)}&limit=1000`).then((response) => response.json());
  assert.ok(items.some((item) => item.Id === target.Id && item.AuthorName === target.AuthorName));
});

test("The registered level has a local preview and an R2 payload", async () => {
  const visible = await fetch(`http://127.0.0.1:${PORT}/api/Items?type=0&limit=1000`).then((response) => response.json());
  const target = visible.find((item) => new URL(item.PreviewUri).origin === `http://127.0.0.1:${PORT}`);
  assert.ok(target);
  const item = await fetch(`http://127.0.0.1:${PORT}/api/GetItem?id=${target.Id}`).then((response) => response.json());
  const preview = await fetch(item.PreviewUri);
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get("content-type"), /^image\/(?:jpeg|png)$/);
  assert.match(item.PayloadUri, /^https:\/\/content\.marble\.kevin-kuhn\.dev\/payloads\//);
  assert.ok(item.PayloadLength > 0);
});

test("GetItem returns 404 for an unknown item", async () => {
  const visible = await fetch(`http://127.0.0.1:${PORT}/api/Items?limit=1000`).then((response) => response.json());
  const missingId = Math.max(...visible.map((item) => item.Id)) + 100000;
  const response = await fetch(`http://127.0.0.1:${PORT}/api/GetItem?id=${missingId}`);
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
