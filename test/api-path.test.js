const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeApiPath } = require("../api-path.cjs");

test("API routes tolerate repeated and trailing slashes without changing asset paths", () => {
  for (const endpoint of ["Items", "GetItem", "Download"]) {
    for (const prefix of ["/", "//", "/api/", "/api//", "//api//", "/api/api//"]) {
      for (const suffix of ["", "/", "//"]) {
        assert.equal(normalizeApiPath(`${prefix}${endpoint}${suffix}`), `/api/${endpoint}`);
      }
    }
  }
  for (const path of ["/", "/api/ItemsExtra", "/other/Items", "/previews//image.jpg", "/api/Unknown/"]) {
    assert.equal(normalizeApiPath(path), path);
  }
});

test("Worker dispatches slash variants directly and keeps query filters intact", async () => {
  const worker = (await import("../worker.mjs")).default;
  const env = { ASSETS: { fetch: () => { throw new Error("API request reached the asset server"); } } };
  const reference = await (await worker.fetch(new Request("https://example.test/api/Items?type=0&limit=2&skip=1"), env)).json();
  for (const path of ["//Items", "//api/Items", "/api//Items", "/Items/", "/api/Items/", "/api/api//Items/"]) {
    const response = await worker.fetch(new Request(`https://example.test${path}?type=0&limit=2&skip=1`), env);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), reference);
    assert.equal(response.headers.get("location"), null);
  }
  const head = await worker.fetch(new Request("https://example.test//Items", { method: "HEAD" }), env);
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  const options = await worker.fetch(new Request("https://example.test//api/Items/", { method: "OPTIONS" }), env);
  assert.equal(options.status, 204);
  const invalidLookup = await worker.fetch(new Request("https://example.test//GetItem/?id=invalid"), env);
  assert.equal(invalidLookup.status, 400);
  const invalidDownload = await worker.fetch(new Request("https://example.test/api//Download/?id=invalid"), env);
  assert.equal(invalidDownload.status, 400);
});

test("Cloudflare forwards slash-variant API paths while ordinary website assets stay asset-first", () => {
  const config = JSON.parse(require("node:fs").readFileSync(require.resolve("../wrangler.jsonc"), "utf8"));
  const patterns = config.assets.run_worker_first.map((pattern) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`));
  for (const path of ["//Items", "//api/Items", "/Items/", "/api//Items", "//GetItem", "/GetItem/", "/Download/"]) {
    assert.ok(patterns.some((pattern) => pattern.test(path)), `${path} must invoke the Worker`);
  }
  for (const path of ["/", "/styles.css", "/previews/image.jpg"]) {
    assert.equal(patterns.some((pattern) => pattern.test(path)), false);
  }
});
