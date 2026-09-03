"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("custom workshop items use the reserved short ID range", () => {
  const items = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../items.json"), "utf8"));
  const customItems = items.filter((item) => !["official-main", "steam-recovery"].includes(item.MirrorSource));
  const customIds = customItems.map((item) => item.Id);

  assert.ok(customIds.includes(1), "the original Shuriken Race item keeps ID 1");
  assert.ok(
    customIds.filter((id) => id !== 1).every((id) => Number.isSafeInteger(id) && id >= 10001),
    "new custom items use IDs beginning at 10001",
  );
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
