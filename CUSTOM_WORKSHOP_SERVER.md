# Host a Custom Marble Race Workshop Server

Marble Race can browse and download community-hosted levels, blocks, and campaigns from a custom HTTP server. A server is read-only from the game's point of view: it publishes a catalogue and downloadable files. The game does not upload content to it.

The smallest server needs:

- two JSON endpoints;
- one preview image per item;
- one ZIP payload per item;
- HTTPS with a publicly reachable URL.

You can host this with a Cloudflare Worker, another serverless platform, or any conventional web server. Players add the API base URL in Marble Race's Workshop server settings.

## API base URL

Choose a base URL without a trailing slash, for example:

```text
https://my-marble-workshop.example.workers.dev/api
```

Marble Race appends `/Items` and `/GetItem` to this value.

## Required endpoints

### `GET /api/Items`

Return a raw JSON array of workshop items. Return `[]` when no items match. Do not wrap the array in an object such as `{ "items": [...] }`.

The game sends these query parameters:

| Parameter | Format | Meaning |
| --- | --- | --- |
| `search` | string | Search text. It may be empty. |
| `sort` | `new` or `top` | Requested order. |
| `type` | comma-separated integers | `0` = level, `1` = block, `2` = campaign. |
| `itemVersion` | string | Current Marble Race application version. |
| `limit` | integer | Maximum number of results. |
| `skip` | integer | Number of matching results to skip. |
| `timeFrom` | Unix seconds | Oldest requested timestamp. |
| `timeTo` | Unix seconds | Newest requested timestamp. |

A minimal server may ignore filters it does not support, but it should accept them without failing. At minimum, implement `type`, `limit`, and `skip`; implementing search and date filtering gives players the expected browsing behavior.

Example request:

```http
GET /api/Items?search=hell&sort=new&type=0,2&itemVersion=1.6&limit=10&skip=0&timeFrom=0&timeTo=1784572602
```

### `GET /api/GetItem?id=714`

Return one raw workshop item object. Return HTTP `404` when the ID does not exist.

## Workshop item JSON

Use this shape:

```json
{
  "Id": 714,
  "Name": "The Hell Zone",
  "ResourceType": 2,
  "TimeStamp": 1784572600,
  "AuthorId": 0,
  "AuthorName": "Community Creator",
  "PreviewUri": "https://my-marble-content.example.workers.dev/714.jpg",
  "PayloadUri": "https://my-marble-content.example.workers.dev/714.zip",
  "Description": "A community campaign.",
  "PayloadLength": 1306462,
  "Version": "0.0"
}
```

| Field | Requirement |
| --- | --- |
| `Id` | Unique integer. The game also uses it for the downloaded ZIP filename and update metadata. |
| `Name` | Non-empty, filesystem-safe display name. The game uses it as an installation directory name. |
| `ResourceType` | `0` = level, `1` = block, `2` = campaign. |
| `TimeStamp` | Unix timestamp in seconds. Increase it when publishing an update. |
| `AuthorId` | Use `0` when there is no Steam author ID. |
| `AuthorName` | Name displayed in the game and written into installed content metadata. |
| `PreviewUri` | Public HTTPS URL for a PNG or JPEG preview. |
| `PayloadUri` | Public HTTPS URL for the ZIP payload. |
| `Description` | Description displayed or written into installed content metadata. |
| `PayloadLength` | Exact ZIP size in bytes. It must fit in a signed 32-bit integer. |
| `Version` | Minimum compatible game version. Omit it or use a safely old value such as `"0.0"` unless the item truly requires a newer client. |

If `Version` is newer than the player's game version, Marble Race disables the item as incompatible.

## ZIP payloads

The ZIP must contain a valid Marble Race item at its root:

- level: `level.json` and its associated resources;
- block: `block.json` and its associated resources;
- campaign: `campaign.json`, its levels, and associated resources.

Do not add an extra enclosing folder unless that is already part of the valid item layout. Marble Race extracts the ZIP and then immediately tries to migrate and load the expected JSON file.

Use safe relative paths inside the ZIP. Never include absolute paths, drive letters, or `..` path segments.

## Minimal Cloudflare Worker

This example keeps the catalogue in code. Host the previews and ZIPs as Worker static assets, in R2, or on any public HTTPS file host.

```js
const items = [
  {
    Id: 714,
    Name: "The Hell Zone",
    ResourceType: 2,
    TimeStamp: 1784572600,
    AuthorId: 0,
    AuthorName: "Community Creator",
    PreviewUri: "https://my-marble-content.example.workers.dev/714.jpg",
    PayloadUri: "https://my-marble-content.example.workers.dev/714.zip",
    Description: "A community campaign.",
    PayloadLength: 1306462,
    Version: "0.0",
  },
];

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
    },
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/api/Items" || path === "/Items") {
      const search = (url.searchParams.get("search") || "").toLowerCase();
      const types = (url.searchParams.get("type") || "")
        .split(",")
        .filter(Boolean)
        .map(Number);
      const skip = Math.max(0, Number(url.searchParams.get("skip")) || 0);
      const limit = Math.max(
        1,
        Math.min(100, Number(url.searchParams.get("limit")) || 10),
      );
      const timeFrom = Number(url.searchParams.get("timeFrom")) || 0;
      const timeTo = Number(url.searchParams.get("timeTo")) || Number.MAX_SAFE_INTEGER;
      const sort = url.searchParams.get("sort") || "new";

      const result = items
        .filter((item) =>
          !search ||
          item.Name.toLowerCase().includes(search) ||
          (item.Description || "").toLowerCase().includes(search),
        )
        .filter((item) => !types.length || types.includes(item.ResourceType))
        .filter((item) => item.TimeStamp >= timeFrom && item.TimeStamp <= timeTo)
        .sort((a, b) =>
          sort === "new" ? b.TimeStamp - a.TimeStamp : a.Id - b.Id,
        )
        .slice(skip, skip + limit);

      return json(result);
    }

    if (path === "/api/GetItem" || path === "/GetItem") {
      const id = Number(url.searchParams.get("id"));
      const item = items.find((candidate) => candidate.Id === id);
      return item ? json(item) : json({ error: "Item not found" }, 404);
    }

    return json({
      name: "Marble Race custom workshop",
      endpoints: ["/api/Items", "/api/GetItem?id=<id>"],
    });
  },
};
```

## Deployment checklist

1. Prepare and test a valid item ZIP locally.
2. Upload the ZIP and preview image to a public HTTPS host.
3. Record the ZIP's exact byte size for `PayloadLength`.
4. Add an item with a unique `Id` to the catalogue.
5. Deploy the API.
6. Open `/api/Items` in a browser and confirm it returns a raw array.
7. Open `/api/GetItem?id=<id>` and confirm it returns the matching raw object.
8. Verify that `PreviewUri` and `PayloadUri` download successfully without authentication.
9. In Marble Race, open **Workshop → Server Settings**, enter a name and the API base URL, and add the server.
10. Select the custom server, refresh the Workshop, download the item, and verify that it loads.

## Updating an item

Keep the same `Id`, replace the ZIP and preview as needed, update `PayloadLength`, and increase `TimeStamp`. If a CDN caches files aggressively, give the new payload a versioned filename or purge the cached object.

## Common failures

- **Search error:** the base URL is wrong, an endpoint returned non-success HTTP, or the JSON shape is invalid.
- **No results:** `/Items` returned a wrapped object instead of a raw array, or the server filtered out the requested type/date range.
- **Preview missing:** `PreviewUri` is not public HTTPS or returns a non-image response.
- **Download fails:** `PayloadUri` is not public, `PayloadLength` is wrong, or the file is not a valid ZIP.
- **Workshop Item Corrupted:** the ZIP has the wrong root layout or lacks `level.json`, `block.json`, or `campaign.json` for its declared type.
- **Item locked as incompatible:** its `Version` is newer than the installed Marble Race version.

## Security note

Only add servers you trust. A custom server controls metadata, filenames, download URLs, and ZIP contents. Server operators should validate names and archive paths before publishing and should never distribute archives containing traversal paths such as `../file`.
