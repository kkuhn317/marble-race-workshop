const test = require("node:test");
const assert = require("node:assert/strict");
const { buildCampaignMemberships, campaignsForLevel } = require("../campaign-membership.cjs");

const level = { Id: 1, ResourceType: 0, PayloadUri: "https://example.test/level.zip", PayloadLength: 100 };
const campaign = { Id: 2, ResourceType: 2, PayloadUri: "https://example.test/campaign.zip", PayloadLength: 200 };
const component = (path, canonical = "same-content", layout = "same-layout") => ({
  Kind: "level", Path: path, CanonicalHash: canonical, LayoutHash: layout, TokenCount: 10,
});
const record = (item, components) => ({
  FingerprintVersion: 2, ItemId: item.Id, PayloadUri: item.PayloadUri,
  PayloadLength: item.PayloadLength, Components: components,
});

test("campaign matching recognizes contents or layouts, deduplicates and ignores backups and empty scenes", () => {
  const records = [record(level, [component("level.json")]), record(campaign, [
    component("Other/level.json", "different", "different"),
    component("Track/level.json", "different-content"),
    component("Track copy/level.json"),
  ])];
  const links = buildCampaignMemberships([level, campaign], records);
  assert.equal(links.length, 1);
  assert.equal(links[0].Match, "content");
  delete records[1].FingerprintVersion;
  assert.equal(buildCampaignMemberships([level, campaign], records).length, 1, "Older records with complete geometry remain usable");
  records[1].Components.pop();
  assert.equal(buildCampaignMemberships([level, campaign], records)[0].Match, "layout");
  records[1].Components = [component("Track/backup/level.json"), component("Blocks/Template/level.json"), { ...component("Empty/level.json"), TokenCount: 0 }];
  assert.deepEqual(buildCampaignMemberships([level, campaign], records), []);
});

test("changed uploads and hidden or removed campaigns cannot produce public links", () => {
  const items = [level, campaign];
  const records = [record(level, [component("level.json")]), record(campaign, [component("Track/level.json")])];
  const document = { Links: buildCampaignMemberships(items, records) };
  assert.deepEqual(campaignsForLevel(level, items, () => false, document), [{ Id: 2, Match: "content" }]);
  assert.deepEqual(campaignsForLevel(level, items, (id) => id === 2, document), []);
  assert.deepEqual(campaignsForLevel(level, [level], () => false, document), []);
  const updatedLevel = { ...level, PayloadUri: "https://example.test/new-level.zip" };
  const updatedCampaign = { ...campaign, PayloadLength: 201 };
  assert.deepEqual(campaignsForLevel(updatedLevel, [updatedLevel, campaign], () => false, document), []);
  assert.deepEqual(campaignsForLevel(level, [level, updatedCampaign], () => false, document), []);
  assert.deepEqual(buildCampaignMemberships([level, updatedCampaign], records), []);
});

test("both public API endpoints expose campaign matches and respect moderation", async () => {
  const { items } = await import("../cloudflare/catalog.mjs");
  const { hiddenItemIds } = await import("../cloudflare/moderation.mjs");
  const { onRequestGet: list } = await import("../functions/api/Items.js");
  const { onRequestGet: get } = await import("../functions/api/GetItem.js");
  const document = require("../campaign-level-links.json");
  const selected = items.find((item) => item.ResourceType === 0 && !hiddenItemIds.has(item.Id));
  const selectedCampaign = items.find((item) => item.ResourceType === 2 && !hiddenItemIds.has(item.Id));
  const links = buildCampaignMemberships([selected, selectedCampaign], [record(selected, [component("level.json")]), record(selectedCampaign, [component("Track/level.json")])]);
  const original = document.Links;
  document.Links = links;
  try {
    const single = await get({ request: new Request(`https://example.test/api/GetItem?id=${selected.Id}`) }).json();
    assert.deepEqual(single.CampaignMemberships, [{ Id: selectedCampaign.Id, Match: "content" }]);
    const listed = await list({ request: new Request(`https://example.test/api/Items?search=%23${selected.Id}&limit=1000`) }).json();
    assert.deepEqual(listed.find((item) => item.Id === selected.Id).CampaignMemberships, single.CampaignMemberships);
    hiddenItemIds.add(selectedCampaign.Id);
    const moderated = await get({ request: new Request(`https://example.test/api/GetItem?id=${selected.Id}`) }).json();
    assert.deepEqual(moderated.CampaignMemberships, []);
  } finally {
    hiddenItemIds.delete(selectedCampaign.Id);
    document.Links = original;
  }
});
