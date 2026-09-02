"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("manager generates deterministic moderation modules", async () => {
  const { buildModerationModule } = await import("../workshop-manager.mjs");
  const moduleText = buildModerationModule([9, 2, 9, 5]);
  assert.match(moduleText, /new Set\(\[\s+2, 5, 9,/);
  assert.match(moduleText, /hiddenItemIds\.has\(Number\(id\)\)/);
});

test("manager metadata edits use overrides and remove redundant values", async () => {
  const { applyItemEdit } = await import("../workshop-manager.mjs");
  const base = { Name: "Level", AuthorName: "Matt", Description: "Original", Version: "1.0", Tags: ["race"] };
  const changed = applyItemEdit(base, {}, { AuthorName: "BookwormKevin", Description: "Original", Tags: ["race", "hard"] });
  assert.deepEqual(changed, { AuthorName: "BookwormKevin", Tags: ["race", "hard"] });
  const restored = applyItemEdit(base, changed, { AuthorName: "Matt", Tags: ["race"] });
  assert.deepEqual(restored, {});
});

test("manager API is local and requires its session token", async (context) => {
  const { createWorkshopManager } = await import("../workshop-manager.mjs");
  const manager = await createWorkshopManager({ port: 0, openBrowser: false });
  context.after(() => new Promise((resolve) => manager.server.close(resolve)));
  const base = new URL(manager.url);
  const unauthorized = await fetch(new URL("/api/catalog", base));
  const authorized = await fetch(new URL("/api/catalog", base), { headers: { "x-manager-token": manager.token } });
  assert.equal(unauthorized.status, 403);
  assert.equal(authorized.status, 200);
  const body = await authorized.json();
  assert.ok(body.items.length > 500);
  assert.ok(body.items.some((item) => item.Hidden));
  assert.equal(authorized.headers.get("access-control-allow-origin"), null);
});

test("manager UI exposes visibility, metadata, deployment, and tools", () => {
  const root = path.resolve(__dirname, "../manager-ui");
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const script = fs.readFileSync(path.join(root, "manager.js"), "utf8");
  assert.match(html, /id="publish"/);
  assert.match(html, /data-tool="publish"/);
  assert.match(html, /data-tool="duplicates"/);
  assert.match(html, /id="bulk-form"/);
  assert.match(script, /\/api\/visibility/);
  assert.match(script, /\/api\/metadata/);
  assert.match(script, /\/api\/update-item/);
  assert.match(script, /Update file/);
  assert.match(script, /\/api\/deploy/);
});

test("item updater keeps the selected ID and existing catalogue metadata", () => {
  const publisher = fs.readFileSync(path.resolve(__dirname, "../publish-workshop-item.ps1"), "utf8");
  assert.match(publisher, /\[Int64\]\$UpdateItemId = 0/);
  assert.match(publisher, /Updating selected workshop item ID/);
  assert.match(publisher, /foreach \(\$property in \$existingItem\.PSObject\.Properties\)/);
  assert.match(publisher, /\$newItem\["PayloadUri"\] = \$payloadUri/);
});
