"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("custom workshop items use the reserved short ID range", () => {
  const items = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../items.json"), "utf8"));
  const customItems = items.filter((item) => !["official-main", "steam-recovery"].includes(item.MirrorSource));
  assert.deepEqual(customItems.map((item) => item.Id).sort((a, b) => a - b), [
    1, 10001, 10002, 10003, 10004, 10005, 10006, 10007,
  ]);
  assert.equal(new Set(items.map((item) => item.Id)).size, items.length);
  const recoveredItems = items.filter((item) => item.MirrorSource === "steam-recovery");
  assert.ok(recoveredItems.every((item) => item.Id >= 2000 && item.Id < 10000));
});

test("future custom publications begin after the reserved official range", () => {
  const publisher = fs.readFileSync(path.resolve(__dirname, "../publish-workshop-item.ps1"), "utf8");
  assert.match(publisher, /\$customIdFloor = \[int64\]10001/);
  assert.match(publisher, /while \(\$allUsedIds -contains \$itemId\)/);
  assert.doesNotMatch(publisher, /990000000001/);
});
