"use strict";

function creatorKey(value) {
  return String(value || "").normalize("NFC").trim().toLowerCase();
}

function creatorNames(item) {
  const credits = Array.isArray(item.Creators) ? item.Creators : String(item.AuthorName || "").split(/[,;]|\s+&\s+/);
  const unique = new Map();
  for (const credit of credits) {
    const original = String(credit).trim();
    const name = creatorKey(original) === "bookwormkevin&ryan" ? "BookwormKevin" : original;
    if (name) unique.set(creatorKey(name), name);
  }
  return [...unique.values()];
}

function matchesCreator(item, name) {
  return !name || creatorNames(item).some((creator) => creatorKey(creator) === creatorKey(name));
}

function creatorSearch(search) {
  const match = /^(?:creator|author):\s*(.*)$/i.exec(search);
  return match ? match[1].trim().replace(/^"(.*)"$/, "$1") : null;
}

module.exports = { creatorKey, creatorNames, matchesCreator, creatorSearch };
