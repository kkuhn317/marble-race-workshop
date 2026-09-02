"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("mirror cleans common Steam markup while preserving description text", async () => {
  const { cleanSteamDescription } = await import("../mirror-main-workshop.mjs");
  assert.equal(
    cleanSteamDescription("[b]Fast[/b]\r\n[url=https://example.com]Details[/url]\n[img]ignored[/img]"),
    "Fast\nDetails",
  );
});

test("mirror prevents accidental partial publication", async () => {
  const { parseArguments } = await import("../mirror-main-workshop.mjs");
  assert.equal(parseArguments(["--plan", "--max-items", "2"]).maxItems, 2);
  assert.throws(() => parseArguments(["--max-items", "2"]), /partial mirror/);
  assert.throws(() => parseArguments(["--plan", "--push"]), /cannot be combined/);
});

test("mirror rejects unsafe archive paths", async () => {
  const { isSafeArchivePath } = await import("../mirror-main-workshop.mjs");
  assert.equal(isSafeArchivePath("campaign.json"), true);
  assert.equal(isSafeArchivePath("Levels/Race/level.json"), true);
  assert.equal(isSafeArchivePath("../outside.txt"), false);
  assert.equal(isSafeArchivePath("C:\\outside.txt"), false);
  assert.equal(isSafeArchivePath("/outside.txt"), false);
});

test("mirror reuses only an exact source file checkpoint", async () => {
  const { isReusableMirrorRecord } = await import("../mirror-main-workshop.mjs");
  const source = {
    Id: 715,
    TimeStamp: 1740647152,
    PayloadLength: 49323837,
    PayloadUri: "https://source/payload/715",
    PreviewUri: "https://source/preview/715",
  };
  const record = {
    Id: 715,
    SourceTimeStamp: 1740647152,
    PayloadLength: 49323837,
    SourcePayloadUri: source.PayloadUri,
    SourcePreviewUri: source.PreviewUri,
    PayloadUri: "https://mirror/payload/715.zip",
    PreviewUri: "https://mirror/preview/715.jpg",
    PayloadSha256: "a".repeat(64),
    PreviewSha256: "b".repeat(64),
  };
  assert.equal(isReusableMirrorRecord(record, source), true);
  assert.equal(isReusableMirrorRecord({ ...record, PayloadLength: 1 }, source), false);
});

test("mirror replaces numeric descriptions with Steam descriptions", async () => {
  const { buildMirroredItem } = await import("../mirror-main-workshop.mjs");
  const item = buildMirroredItem({
    Id: 715,
    Name: "Soft World Pt 2",
    ResourceType: 2,
    TimeStamp: 1740647152,
    AuthorId: "76561199387555910",
    AuthorName: "Rammy Junior",
    Description: "3435030530",
    PayloadLength: 49323837,
    PayloadUri: "https://source/payload/715",
    PreviewUri: "https://source/preview/715",
    Version: "1.4.17",
  }, {
    creator: "76561199387555910",
    description: "Made By RCube",
    time_updated: 1740647152,
    subscriptions: 79,
    favorited: 4,
    tags: [{ tag: "campaign" }],
  }, {
    PayloadUri: "https://mirror/payload/715.zip",
    PreviewUri: "https://mirror/preview/715.jpg",
    PayloadSha256: "a".repeat(64),
    PreviewSha256: "b".repeat(64),
  });
  assert.equal(item.Description, "Made By RCube");
  assert.equal(item.SteamWorkshopId, "3435030530");
  assert.equal(item.AuthorId, "76561199387555910");
  assert.deepEqual(item.Tags, ["campaign"]);
});

test("mirror preserves removed official items and rejects custom ID collisions", async () => {
  const { mergeCatalog } = await import("../mirror-main-workshop.mjs");
  const oldMirror = { Id: 700, Name: "Old", MirrorSource: "official-main" };
  const merged = mergeCatalog([oldMirror, { Id: 1, Name: "Custom" }], [
    { Id: 701, Name: "Current", MirrorSource: "official-main" },
  ]);
  assert.equal(merged.find((item) => item.Id === 700).MirrorStatus, "missing-from-source");
  assert.throws(
    () => mergeCatalog([{ Id: 701, Name: "Collision" }], [{ Id: 701, MirrorSource: "official-main" }]),
    /collides/,
  );
});

test("mirror replaces generated catalogs with either Windows or Unix line endings", async () => {
  const { replaceCatalogItems } = await import("../mirror-main-workshop.mjs");
  for (const newline of ["\n", "\r\n"]) {
    const source = `export const items = [${newline}];${newline}${newline}export function json() {}`;
    const updated = replaceCatalogItems(source, [{ Id: 715 }]);
    assert.match(updated, /"Id": 715/);
    assert.match(updated, /export function json/);
  }
});
