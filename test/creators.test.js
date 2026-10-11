const test = require("node:test");
const assert = require("node:assert/strict");
const { creatorNames, matchesCreator, creatorSearch } = require("../creators.cjs");

test("creator credits split lists without splitting ampersands within a username", () => {
  assert.deepEqual(creatorNames({ AuthorName: "BookwormKevin, SAGYT; CTMFF & RodentRacer, sagyt" }), ["BookwormKevin", "sagyt", "CTMFF", "RodentRacer"]);
  assert.deepEqual(creatorNames({ AuthorName: "BookwormKevin&Ryan" }), ["BookwormKevin"]);
  assert.deepEqual(creatorNames({ AuthorName: "Other&Name" }), ["Other&Name"]);
  assert.equal(matchesCreator({ AuthorName: "BookwormKevin, SAGYT" }, " sAgYt "), true);
  assert.equal(matchesCreator({ AuthorName: "SAGYT2" }, "SAGYT"), false);
  assert.deepEqual(creatorNames({ Creators: ["Name, with comma", "Other"], AuthorName: "Legacy" }), ["Name, with comma", "Other"]);
  assert.equal(creatorSearch('creator:"BookwormKevin"'), "BookwormKevin");
  assert.equal(creatorSearch("author:SAGYT"), "SAGYT");
  assert.equal(creatorSearch("ordinary search"), null);
});

test("Cloudflare creator searches match individual credits, not mentions or name fragments", async () => {
  const { onRequestGet } = await import("../functions/api/Items.js");
  const { items } = await import("../cloudflare/catalog.mjs");
  const { hiddenItemIds } = await import("../cloudflare/moderation.mjs");
  const { metadataOverrides } = await import("../cloudflare/metadata-overrides.mjs");
  const targets = items.filter((item) => !hiddenItemIds.has(item.Id)).slice(0, 2);
  const saved = targets.map((item) => metadataOverrides.get(item.Id));
  try {
    metadataOverrides.set(targets[0].Id, { AuthorName: "Creator Test Alpha, Creator Test Beta", Description: "" });
    metadataOverrides.set(targets[1].Id, { AuthorName: "Creator Test Beta2", Description: "Creator Test Beta" });
    for (const query of ["creator=creator%20test%20beta", "search=creator:Creator%20Test%20Beta", "search=author:Creator%20Test%20Beta"]) {
      const response = await onRequestGet({ request: new Request(`https://example.test/api/Items?limit=1000&${query}`) }).json();
      assert.deepEqual(response.map((item) => item.Id), [targets[0].Id]);
      assert.deepEqual(response[0].CreatorNames, ["Creator Test Alpha", "Creator Test Beta"]);
    }
    const empty = await onRequestGet({ request: new Request("https://example.test/api/Items?search=creator:No%20such%20creator") }).json();
    assert.deepEqual(empty, []);
    const { onRequestGet: getItem } = await import("../functions/api/GetItem.js");
    const item = await getItem({ request: new Request(`https://example.test/api/GetItem?id=${targets[0].Id}`) }).json();
    assert.deepEqual(item.CreatorNames, ["Creator Test Alpha", "Creator Test Beta"]);
  } finally {
    targets.forEach((item, index) => saved[index] ? metadataOverrides.set(item.Id, saved[index]) : metadataOverrides.delete(item.Id));
  }
});
