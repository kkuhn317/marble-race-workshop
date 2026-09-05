"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("default duplicate scan includes official and recovered Steam items only", async () => {
  const { isDefaultScanItem } = await import("../scan-workshop-duplicates.mjs");
  assert.equal(isDefaultScanItem({ Id: 500, MirrorSource: "official-main" }), true);
  assert.equal(isDefaultScanItem({ Id: 2000, MirrorSource: "steam-recovery" }), true);
  assert.equal(isDefaultScanItem({ Id: 10001 }), false);
  assert.equal(isDefaultScanItem({ Id: 10002, MirrorSource: "custom" }), false);
});

test("duplicate scans use repaired catalog metadata", async () => {
  const { prepareScanItems } = await import("../scan-workshop-duplicates.mjs");
  const [item] = prepareScanItems([{ Id: 2034, Name: "corrupted source title" }]);
  assert.equal(item.Name, "粉色 Pink");
});

test("duplicate reports normalize the workshop's existing hidden IDs", async () => {
  const { normalizeHiddenItemIds } = await import("../scan-workshop-duplicates.mjs");
  assert.deepEqual(normalizeHiddenItemIds([12, "4", 12, "bad", -1]), [4, 12]);
  assert.deepEqual(normalizeHiddenItemIds(null), []);
});

test("duplicate scanner ignores ownership metadata and GUIDs", async () => {
  const { canonicalize } = await import("../scan-workshop-duplicates.mjs");
  const first = { Id: "one", Author: "Alice", WorkshopId: 1, BlockGroups: { Item: { GUID: "aaaaaaaa", ID: "Block" } } };
  const second = { Id: "two", Author: "Bob", WorkshopId: 2, BlockGroups: { Item: { GUID: "bbbbbbbb", ID: "Block" } } };
  assert.deepEqual(canonicalize(first), canonicalize(second));
});

test("duplicate scanner layout tokens ignore visuals but preserve gameplay", async () => {
  const { extractLayoutTokens } = await import("../scan-workshop-duplicates.mjs");
  const level = material => ({ BlockGroups: { Children: [{ Item: { ID: "Block", GUID: "12345678", Attributes: { transform_0_position: "1,2,3", renderer_0_materials: material, block_0_height: "2" } } }] } });
  assert.deepEqual(extractLayoutTokens(level("Red")), extractLayoutTokens(level("Blue")));
  assert.notDeepEqual(extractLayoutTokens(level("Red")), extractLayoutTokens({ BlockGroups: { Item: { ID: "Block", Attributes: { transform_0_position: "9,9,9", block_0_height: "2" } } } }));
  assert.equal(extractLayoutTokens({ Children: [{ Item: { ID: "Start", Attributes: {} } }] }).length, 1);
});

test("old fingerprints are reused only when level geometry was present", async () => {
  const { isReusableFingerprint } = await import("../scan-workshop-duplicates.mjs");
  const item = { PayloadUri: "https://example.test/1.zip", PayloadLength: 10 };
  assert.equal(isReusableFingerprint({ ...item, Components: [{ TokenCount: 5 }] }, item), true);
  assert.equal(isReusableFingerprint({ ...item, Components: [{ TokenCount: 0 }] }, item), false);
  assert.equal(isReusableFingerprint({ ...item, FingerprintVersion: 2, Components: [{ TokenCount: 0 }] }, item), true);
});

test("duplicate scanner finds exact payload and layout groups", async () => {
  const { buildMatches } = await import("../scan-workshop-duplicates.mjs");
  const items = [
    { Id: 1, Name: "Original", AuthorName: "A", TimeStamp: 10, ResourceType: 0 },
    { Id: 2, Name: "Copy", AuthorName: "B", TimeStamp: 20, ResourceType: 0 },
    { Id: 3, Name: "Visual edit", AuthorName: "C", TimeStamp: 30, ResourceType: 0 },
  ];
  const tokens = ["0", "1", "2", "3"].map(value => JSON.stringify({ ID:"Block", Attributes:{ transform_0_position:`${value},0,0` } }));
  const component = id => ({ ItemId:id, Kind:"level", Path:"level.json", CanonicalHash:id === 3 ? "different" : "canonical", LayoutHash:"layout", TokenCount:4, LayoutTokens:tokens, MinHash:Array(20).fill(1) });
  const records = [
    { ItemId:1, PayloadSha256:"same", Components:[component(1)] },
    { ItemId:2, PayloadSha256:"same", Components:[component(2)] },
    { ItemId:3, PayloadSha256:"other", Components:[component(3)] },
  ];
  const matches = buildMatches(items, records);
  assert.ok(matches.some(match => match.Kind === "exact-payload" && match.Items.length === 2));
  assert.ok(matches.some(match => match.Kind === "exact-layout" && match.Items.some(item => item.Id === 3)));
  assert.ok(matches.some(match => match.DifferentAuthors));
});

test("Jaccard similarity measures partial layout overlap", async () => {
  const { jaccard } = await import("../scan-workshop-duplicates.mjs");
  assert.equal(jaccard(["a", "b", "c"], ["a", "b", "d"]), 0.5);
});

test("geometry comparison tolerates version-specific attributes", async () => {
  const { geometryTokensFromLayout, jaccard } = await import("../scan-workshop-duplicates.mjs");
  const token = attributes => JSON.stringify({ ID:"Block", Attributes:{ transform_0_position:"1,2.0,3", transform_0_rotation:"0,0,0", transform_0_scale:"4,1,4", ...attributes } });
  const oldGeometry = geometryTokensFromLayout([token({ block_0_height:"1" })]);
  const newGeometry = geometryTokensFromLayout([token({ block_0_height:"1", block_0_subdivide:"0", block_0_skew:"0" })]);
  assert.deepEqual(oldGeometry, newGeometry);
  assert.equal(jaccard(oldGeometry, newGeometry), 1);
});

test("campaign comparison identifies changed, added, and missing levels", async () => {
  const { compareCampaignComponents } = await import("../scan-workshop-duplicates.mjs");
  const component = (path, hash, position = "0,0,0") => ({
    Kind:"level", Path:path, CanonicalHash:hash, LayoutHash:hash,
    LayoutTokens:[JSON.stringify({ ID:"Block", Attributes:{ transform_0_position:position } })],
  });
  const comparison = compareCampaignComponents(1, [
    component("same/level.json", "same"), component("changed/level.json", "old"), component("missing/level.json", "missing"),
  ], 2, [
    component("same/level.json", "same"), component("changed/level.json", "new", "1,0,0"), component("added/level.json", "added"),
  ]);
  assert.equal(comparison.CompleteMatch, false);
  assert.deepEqual(comparison.Same, ["same"]);
  assert.equal(comparison.Changed[0].Name, "changed");
  assert.deepEqual(comparison.Added, ["added"]);
  assert.deepEqual(comparison.Missing, ["missing"]);
});
