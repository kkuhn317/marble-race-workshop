"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");

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

test("Items returns the registered level", async () => {
  const response = await fetch(`http://127.0.0.1:${PORT}/api/Items`);
  assert.equal(response.status, 200);
  const items = await response.json();
  assert.equal(items.length, 1);
  assert.equal(items[0].Name, "Shuriken Race");
  assert.equal(items[0].ResourceType, 0);
  assert.equal(items[0].PayloadLength, 385028);
});

test("Items accepts custom-server URL path variants", async () => {
  for (const path of ["/Items", "/api/api/Items"]) {
    const response = await fetch(`http://127.0.0.1:${PORT}${path}`);
    assert.equal(response.status, 200);
    assert.equal((await response.json())[0].Name, "Shuriken Race");
  }
});

test("The registered level and preview are downloadable", async () => {
  const item = await fetch(`http://127.0.0.1:${PORT}/api/GetItem?id=1`).then((response) => response.json());
  const [preview, payload] = await Promise.all([fetch(item.PreviewUri), fetch(item.PayloadUri)]);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("content-type"), "image/jpeg");
  assert.equal(payload.status, 200);
  assert.equal(Number(payload.headers.get("content-length")), 385028);
});

test("GetItem returns 404 for an unknown item", async () => {
  const response = await fetch(`http://127.0.0.1:${PORT}/api/GetItem?id=999`);
  assert.equal(response.status, 404);
});

test("GetItem validates a missing id", async () => {
  const response = await fetch(`http://127.0.0.1:${PORT}/api/GetItem`);
  assert.equal(response.status, 400);
});
