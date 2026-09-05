const WINDOWS_1252_BYTES = new Map([
  ["€", 0x80], ["‚", 0x82], ["ƒ", 0x83], ["„", 0x84], ["…", 0x85], ["†", 0x86], ["‡", 0x87],
  ["ˆ", 0x88], ["‰", 0x89], ["Š", 0x8a], ["‹", 0x8b], ["Œ", 0x8c], ["Ž", 0x8e],
  ["‘", 0x91], ["’", 0x92], ["“", 0x93], ["”", 0x94], ["•", 0x95], ["–", 0x96], ["—", 0x97],
  ["˜", 0x98], ["™", 0x99], ["š", 0x9a], ["›", 0x9b], ["œ", 0x9c], ["ž", 0x9e], ["Ÿ", 0x9f],
]);

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const MOJIBAKE_MARKERS = /Ã|Â|â|Æ|ƒ|ð|ï¿½/g;

function mojibakeScore(value) {
  return (String(value).match(MOJIBAKE_MARKERS) || []).length;
}

function encodeWindows1252(value) {
  const bytes = [];
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0xff) bytes.push(codePoint);
    else if (WINDOWS_1252_BYTES.has(character)) bytes.push(WINDOWS_1252_BYTES.get(character));
    else return null;
  }
  return Uint8Array.from(bytes);
}

export function repairMojibakeText(value) {
  let current = String(value ?? "");
  for (let pass = 0; pass < 12 && mojibakeScore(current) > 0; pass += 1) {
    const bytes = encodeWindows1252(current);
    if (!bytes) break;
    let candidate;
    try { candidate = UTF8_DECODER.decode(bytes); }
    catch { break; }
    if (candidate === current || mojibakeScore(candidate) >= mojibakeScore(current)) break;
    current = candidate;
  }
  return current;
}
