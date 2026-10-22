import {
  onRequestGet as listItems,
  onRequestOptions as optionsItems,
} from "./functions/api/Items.js";
import {
  onRequestGet as getItem,
  onRequestOptions as optionsGetItem,
} from "./functions/api/GetItem.js";
import { onRequestGet as downloadItem } from "./functions/api/Download.js";
import apiPaths from "./api-path.cjs";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = apiPaths.normalizeApiPath(url.pathname);

    if (path === "/api/Items") {
      if (request.method === "OPTIONS") return optionsItems();
      if (request.method === "GET" || request.method === "HEAD") {
        const response = await listItems({ request, env });
        return request.method === "HEAD" ? headResponse(response) : response;
      }
      return methodNotAllowed();
    }

    if (path === "/api/GetItem") {
      if (request.method === "OPTIONS") return optionsGetItem();
      if (request.method === "GET" || request.method === "HEAD") {
        const response = await getItem({ request, env });
        return request.method === "HEAD" ? headResponse(response) : response;
      }
      return methodNotAllowed();
    }

    if (path === "/api/Download") {
      if (request.method === "GET" || request.method === "HEAD") {
        const response = await downloadItem({
          request,
          env,
          waitUntil: ctx ? (promise) => ctx.waitUntil(promise) : undefined,
        });
        return request.method === "HEAD" ? headResponse(response) : response;
      }
      return methodNotAllowed();
    }

    return env.ASSETS.fetch(request);
  },
};

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
