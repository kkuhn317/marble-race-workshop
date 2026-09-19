// Browser downloads can use a normalized archive when an older in-game
// workshop package relies on the game's migration step during installation.
// Keep the original PayloadUri in the API for game clients.
const manualPayloads = new Map([
  [804, "https://content.marble.kevin-kuhn.dev/manual/payloads/arctic-area-804-9f284485.zip"],
]);

export function manualPayloadUri(itemId) {
  return manualPayloads.get(Number(itemId));
}
