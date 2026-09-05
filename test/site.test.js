"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const publicDir = path.resolve(__dirname, "../public");

test("workshop homepage includes the searchable catalog interface", () => {
  const html = fs.readFileSync(path.join(publicDir, "index.html"), "utf8");
  assert.match(html, /id="item-grid"/);
  assert.match(html, /id="search"/);
  assert.match(html, /id="type-filter"/);
  assert.match(html, /id="sort-filter"/);
  assert.match(html, /value="votes">Vote score/);
  assert.match(html, /id="item-dialog"/);
  assert.match(html, /\/styles\.css/);
  assert.match(html, /\/app\.js/);
});

test("workshop browser exposes IDs, creators, filtering, and item links", () => {
  const script = fs.readFileSync(path.join(publicDir, "app.js"), "utf8");
  assert.match(script, /item\.Id/);
  assert.match(script, /item\.AuthorName/);
  assert.match(script, /item\.ResourceType/);
  assert.match(script, /Rating: Number\(item\.Rating\)/);
  assert.match(script, /votes: \(a, b\) => b\.Rating - a\.Rating \|\| a\.Id - b\.Id/);
  assert.match(script, /Vote score/);
  assert.match(script, /steamcommunity\.com\/sharedfiles\/filedetails/);
  assert.match(script, /View on Steam Workshop/);
  assert.match(script, /api\/GetItem\?id=/);
  assert.match(script, /navigator\.clipboard/);
});
