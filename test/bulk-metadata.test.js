"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("bulk metadata arguments support safe unattended edits", async () => {
  const { parseArguments } = await import("../bulk-edit-workshop-metadata.mjs");
  assert.deepEqual(
    parseArguments(["--field", "author", "--find", "Old", "--replace", "New", "--non-interactive", "--push"]),
    {
      field: "author",
      find: "Old",
      replacement: "New",
      nonInteractive: true,
      push: true,
      validateOnly: false,
      help: false,
    },
  );
  assert.throws(() => parseArguments(["--non-interactive"]), /requires --field/);
});

test("bulk metadata overrides leave source catalog objects unchanged", async () => {
  const { applyOverride } = await import("../bulk-edit-workshop-metadata.mjs");
  const original = { Id: 42, AuthorName: "Old", TimeStamp: 1234 };
  const updated = applyOverride(original, { "42": { AuthorName: "New" } });
  assert.equal(updated.AuthorName, "New");
  assert.equal(updated.TimeStamp, 1234);
  assert.equal(original.AuthorName, "Old");
});

test("generated Cloudflare override modules are valid and keyed by numeric ID", async () => {
  const { buildOverridesModule } = await import("../bulk-edit-workshop-metadata.mjs");
  const source = buildOverridesModule({ "42": { AuthorName: "New" } });
  const module = await import(`data:text/javascript,${encodeURIComponent(source)}`);
  assert.equal(module.metadataOverrides.get(42).AuthorName, "New");
  assert.equal(module.applyMetadataOverrides({ Id: 42, AuthorName: "Old" }).AuthorName, "New");
});
