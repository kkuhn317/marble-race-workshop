"use strict";

function normalizeApiPath(path) {
  const normalized = path.replace(/\/+/g, "/").replace(/\/+$/, "");
  const match = /^\/(?:api\/){0,2}(Items|GetItem|Download)$/.exec(normalized);
  // Normalize only recognized API routes; leave asset paths untouched.
  return match ? `/api/${match[1]}` : path;
}

module.exports = { normalizeApiPath };
