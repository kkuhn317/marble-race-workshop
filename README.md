# Marble Race custom workshop

The production workshop is designed for Cloudflare Workers and the custom API
base URL `https://marble.kevin-kuhn.dev/api`. Cloudflare serves the HTTPS API,
previews, and downloadable ZIPs. A dependency-free Node server is also retained
for local development.

## Deploy to Cloudflare Workers

Connect this GitHub repository to Cloudflare Workers Builds. The repository's
`wrangler.jsonc` is the deployment source of truth and configures both the API
entry point and the `public` static assets directory.

The generated hostname is:

```text
https://marble-race-workshop.kevin-9dc.workers.dev
```

After deployment, verify:

```text
https://marble-race-workshop.kevin-9dc.workers.dev/api/Items
https://marble-race-workshop.kevin-9dc.workers.dev/api/GetItem?id=1
https://marble-race-workshop.kevin-9dc.workers.dev/previews/shuriken-race.jpg
https://marble-race-workshop.kevin-9dc.workers.dev/payloads/shuriken-race.zip
```

To use `marble.kevin-kuhn.dev` directly as a Worker Custom Domain, the domain
must be an active Cloudflare zone. Since the current domain uses external DNS,
keep using the `workers.dev` URL until the DNS hosting is intentionally moved or
use a hosting configuration that supports an external CNAME.

```text
https://marble-race-workshop.kevin-9dc.workers.dev/api
```

## Test

Run all local and Cloudflare handler tests with:

```powershell
node --test
```

## Local development server

This is a dependency-free local implementation of the API described in
`ITEMS_API.md`. It serves an item catalog plus preview images and downloadable
level payloads.

## Start the server

Double-click `start-server.bat`, or run:

```powershell
node server.js
```

Leave that window open while playing. The server listens on every network
interface at port `3000`.

## Connect from Android

1. Make sure the PC and phone are connected to the same Wi-Fi network.
2. Run `ipconfig` in PowerShell or Command Prompt.
3. Find the PC's `IPv4 Address` under its Wi-Fi adapter, for example
   `192.168.1.50`.
4. On the phone, open `http://192.168.1.50:3000/api/Items` in a browser.
   It should initially display `[]`.
5. In Marble Race, add a server with any name and this URL:
   `http://192.168.1.50:3000/api`

The server logs each request in its console. When diagnosing the Android game,
leave the server window visible and open the custom workshop. A line containing
`GET /api/Items` (or `GET /Items`) confirms that the game reached the server.

Never use `localhost` in the game: on Android, that points back to the phone.
If the browser cannot connect, allow Node.js through Windows Firewall for
private networks and confirm both devices are on the same network.

## Add a level

1. Put its preview image in `public/previews`.
2. Put its level ZIP/package in `public/payloads`.
3. Copy the object in `item.example.json` into the array in `items.json`.
4. Change its fields and filenames. Each item needs a unique numeric `Id`.

For example, `items.json` must be an array:

```json
[
  {
    "Id": 1,
    "Name": "My First Track",
    "ResourceType": 0,
    "TimeStamp": 1787356800,
    "AuthorId": 1,
    "AuthorName": "Matt",
    "PreviewUri": "/previews/my-first-track.png",
    "PayloadUri": "/payloads/my-first-track.zip",
    "Description": "My custom Marble Race track.",
    "PayloadLength": 0,
    "Version": "1.0.0"
  }
]
```

The server calculates `PayloadLength` from a local payload file, so leaving it
at `0` is fine. Relative preview and payload paths are converted into URLs using
the address through which the phone contacted the server.

Resource types are `0` for a level, `1` for a block, and `2` for a campaign.
Changes to `items.json` are picked up on the next request; restarting is not
necessary.

## API

- `GET /api/Items`
- `GET /api/GetItem?id=1`
- `GET /previews/<filename>`
- `GET /payloads/<filename>`

`/api/Items` supports `search`, `skip`, `limit`, `type`, `itemVersion`, `sort`,
`timeFrom`, and `timeTo` as documented in `ITEMS_API.md`.

This implements the catalog API, but a real level still has to use the payload
format expected by Marble Race. The supplied API document does not define that
file format.
