"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

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
  assert.match(html, /id="steam-recovery-open"/);
  assert.match(html, /data-tool="steamImport"/);
  assert.match(script, /\/api\/visibility/);
  assert.match(script, /\/api\/metadata/);
  assert.match(script, /\/api\/update-item/);
  assert.match(script, /Update file/);
  assert.match(script, /\/api\/deploy/);
  assert.match(script, /\/api\/steam-recovery/);
  const server = fs.readFileSync(path.resolve(__dirname, "../workshop-manager.mjs"), "utf8");
  assert.match(server, /\["\/d", "\/k", "call", selected\.path\]/);
  assert.match(server, /select-and-publish-workshop-item\.bat/);
});

test("recovered Steam importer assigns stable short IDs and preserves dates", async () => {
  const { assignRecoveredIds, buildRecoveredItem } = await import("../import-recovered-steam-workshop.mjs");
  const candidates = [{ steamId: "100", archivePath: "C:\\Downloads\\old-level.zip", embeddedAuthor: "Builder", embeddedDescription: "", embeddedVersion: "1.0", embeddedTimestamp: 0 }];
  const assigned = assignRecoveredIds([{ Id: 2000, SteamWorkshopId: "99" }], [], candidates);
  assert.equal(assigned.get("100"), 2001);
  const record = { Id: 2001, PreviewUri: "https://example/preview.png", PayloadUri: "https://example/payload.zip", PayloadLength: 123, PayloadSha256: "a", PreviewSha256: "b" };
  const item = buildRecoveredItem(candidates[0], { title: "Old Level", creator: "7656119", author_name: "Steam Name", description: "Original", time_created: 1540000000, time_updated: 1540000010, tags: [{ tag: "race" }] }, { ResourceType: 0, Version: "1.0.15" }, record);
  assert.equal(item.Id, 2001);
  assert.equal(item.TimeStamp, 1540000000);
  assert.equal(item.AuthorName, "Builder");
  assert.equal(item.SteamWorkshopId, "100");
});

test("transitional converter handles levels deeper than PowerShell's JSON limit", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "marble-transition-test-"));
  try {
    const levelPath = path.join(temporary, "level.json");
    const steamPath = path.join(temporary, "steam.json");
    const blockPath = path.join(temporary, "block.json");
    const summaryPath = path.join(temporary, "summary.json");
    const root = { Item: { Attributes: { MIXED_Key: "value" } } };
    let cursor = root;
    for (let index = 0; index < 130; index += 1) {
      const child = { Item: { Attributes: { Another_Key: String(index) } } };
      cursor.Children = [child];
      cursor = child;
    }
    fs.writeFileSync(levelPath, JSON.stringify({ BlockGroups: root, Materials: [], Version: "1.3.0" }));
    fs.writeFileSync(steamPath, JSON.stringify({ publishedfileid: "123", time_created: 456, author_name: "Builder", description: "Old level", tags: ["level"] }));
    execFileSync(process.execPath, [path.resolve(__dirname, "../convert-transitional-level.mjs"), levelPath, steamPath, blockPath, summaryPath]);
    const block = JSON.parse(fs.readFileSync(blockPath, "utf8"));
    const level = JSON.parse(fs.readFileSync(levelPath, "utf8"));
    assert.equal(block.Item.Attributes.mixed_key, "value");
    assert.equal(level.WorkshopId, 123);
    assert.equal(level.BlockGroups, undefined);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("legacy recovery keeps the game's integer migration version intact", () => {
  const preparer = fs.readFileSync(path.resolve(__dirname, "../prepare-recovered-steam-item.ps1"), "utf8");
  const importer = fs.readFileSync(path.resolve(__dirname, "../import-recovered-steam-workshop.mjs"), "utf8");
  assert.match(preparer, /\[IO\.File\]::Copy\(\$payloadPath, \(Join-Path \$contentRoot \$requiredJson\), \$true\)/);
  assert.doesNotMatch(preparer, /Version = \$version\s+Type = "Level"/);
  assert.match(importer, /LEGACY_PREPARATION_VERSION = 2/);
  assert.match(importer, /-legacy\$\{preparationVersion\}/);
});

test("Steam recovery bookmarklet uses only the download endpoint", async () => {
  const { buildSteamRecoveryBookmarklet } = await import("../workshop-manager.mjs");
  const bookmarklet = buildSteamRecoveryBookmarklet(["1577565384", "1577565384", "abc"]);
  const script = decodeURIComponent(bookmarklet.slice("javascript:".length));
  assert.match(script, /1577565384/);
  assert.match(script, /sharedfiles\/downloadfile/);
  assert.match(script, /readytouseitems/);
  assert.doesNotMatch(script, /ban|visibility|reportitem/i);
});

test("item updater keeps the selected ID and existing catalogue metadata", () => {
  const publisher = fs.readFileSync(path.resolve(__dirname, "../publish-workshop-item.ps1"), "utf8");
  const manager = fs.readFileSync(path.resolve(__dirname, "../workshop-manager.mjs"), "utf8");
  const updateLauncher = fs.readFileSync(path.resolve(__dirname, "../select-and-update-workshop-item.bat"), "utf8");
  assert.match(publisher, /\[Int64\]\$UpdateItemId = 0/);
  assert.match(publisher, /Updating selected workshop item ID/);
  assert.match(publisher, /foreach \(\$property in \$existingItem\.PSObject\.Properties\)/);
  assert.match(publisher, /\$newItem\["PayloadUri"\] = \$payloadUri/);
  assert.match(manager, /\["\/d", "\/k", "call", launcher, String\(id\)\]/);
  assert.match(updateLauncher, /-STA/);
  const publishLauncher = fs.readFileSync(path.resolve(__dirname, "../select-and-publish-workshop-item.bat"), "utf8");
  assert.match(publishLauncher, /-STA/);
  assert.match(publisher, /Tags, comma-separated/);
  assert.doesNotMatch(publisher, /\$isExactUpdate -or/);
  assert.match(publisher, /\$excludedBackupFiles\.Count -eq 0\) \{ \[int64\]0 \}/);
  assert.match(publisher, /\$defaultAuthor = if \(-not \[string\]::IsNullOrWhiteSpace\(\$embeddedAuthor\)/);
  assert.match(publisher, /\$defaultDescription = if \(-not \[string\]::IsNullOrWhiteSpace\(\$embeddedDescription\)/);
  assert.match(publisher, /\$defaultVersion = if \(-not \[string\]::IsNullOrWhiteSpace\(\$embeddedVersion\)/);
  assert.match(publisher, /\$defaultTags = @\(if \(\$archiveTags\.Count -gt 0\)/);
  const publishSelector = fs.readFileSync(path.resolve(__dirname, "../select-and-publish-workshop-item.ps1"), "utf8");
  assert.match(publishSelector, /publisher-error\.txt/);
  assert.match(publisher, /\[switch\]\$DeferCommit/);
  assert.match(publisher, /Prepared for batch deployment/);
  assert.match(publishSelector, /Commit and deploy all .* items now/);
  assert.match(publishSelector, /Publish .* workshop items/);
  assert.match(publishSelector, /Wait-ForBatchDeployment/);
});
