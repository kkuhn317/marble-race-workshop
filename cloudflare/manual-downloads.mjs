// Older in-game packages may depend on Marble Race's installation migration.
// Website downloads can use a separately verified, manually installable ZIP.
const manualPayloads = new Map([
  [804, "https://content.marble.kevin-kuhn.dev/manual/payloads/arctic-area-804-040e469f.zip"],
]);

export function manualPayloadUri(itemId) {
  return manualPayloads.get(Number(itemId));
}
