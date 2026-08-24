import {
  onRequestGet as listItems,
  onRequestOptions as optionsItems,
} from "./functions/api/Items.js";
import {
  onRequestGet as getItem,
  onRequestOptions as optionsGetItem,
} from "./functions/api/GetItem.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = normalizeApiPath(url.pathname);

    if (path === "/api/Items") {
      if (request.method === "OPTIONS") return optionsItems();
      if (request.method === "GET" || request.method === "HEAD") {
        const response = listItems({ request });
        return request.method === "HEAD" ? headResponse(response) : response;
      }
      return methodNotAllowed();
    }

    if (path === "/api/GetItem") {
      if (request.method === "OPTIONS") return optionsGetItem();
      if (request.method === "GET" || request.method === "HEAD") {
        const response = getItem({ request });
        return request.method === "HEAD" ? headResponse(response) : response;
      }
      return methodNotAllowed();
    }

    return env.ASSETS.fetch(request);
  },
};

function normalizeApiPath(path) {
  if (["/Items", "/api/Items", "/api/api/Items"].includes(path)) return "/api/Items";
  if (["/GetItem", "/api/GetItem", "/api/api/GetItem"].includes(path)) return "/api/GetItem";
  return path;
}

function methodNotAllowed() {
  return new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: {
      "content-type": "application/json; charset=utf-8",
      allow: "GET, HEAD, OPTIONS",
    },
  });
}

function headResponse(response) {
  return new Response(null, {
    status: response.status,
    headers: response.headers,
  });
}
