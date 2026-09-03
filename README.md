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

The production custom-server URL entered in Marble Race is:

```text
https://marble.kevin-kuhn.dev/api
```

## Workshop Manager

Double-click `workshop-manager.bat` to open the local Workshop Manager in your
browser. Keep its small console window open while using it. The manager binds
only to this PC and uses a new private session token each time it starts; it is
not part of the public workshop website.

The **Items** screen searches the complete catalogue, including hidden items.
Use **Hide** or **Unhide** on any row, or **Edit** to change that item's name,
author, description, version, or tags. Use **Update file** to select a replacement
ZIP or RAR while keeping the same workshop ID and metadata. The updater rebuilds
the archive for Android, removes backup folders, uploads it to R2, and guides you
through publishing it. Metadata and visibility edits are prepared locally. Press
**Publish changes** to run all tests, commit only the manager-owned moderation
and override files, push them to GitHub, and start the Cloudflare deployment.

The **Tools** screen opens the archive publisher, guided item editor, duplicate
scanner/review, bulk metadata editor, and official-workshop mirror. It also has
a GUI bulk-metadata form for exact replacements across many items.

For older files that exist only on Steam, choose **Recover older Steam items**.
Drag the generated button to the browser's bookmarks bar, open any Marble Race
Steam Workshop page while signed in as a moderator, and click the bookmark. It
scans the live workshop, skips Steam IDs already recorded in the mirror, and
uses Steam's moderator Download action for the remainder. The progress panel
can be paused or cancelled and provides a JSON report when it finishes. If the
browser prompts about multiple downloads, allow them for `steamcommunity.com`.
After the downloads finish, choose **Import downloads** on the same card. The
importer converts legacy `payload.json` levels and blocks, normalizes modern
levels and campaigns for Android, preserves Steam creation dates and metadata,
uploads to R2 with per-item checkpoints, runs all tests, and then offers to
commit and deploy the complete batch. Rerun it after an interruption to resume.

## Publish a ZIP or RAR automatically

Drag a Marble Race ZIP or RAR archive onto `publish-workshop-item.bat`. The
publisher will:

1. detect whether it is a level, block, or campaign;
2. strip a single enclosing folder when necessary;
3. recursively omit every directory named `backup` and everything inside it;
4. rebuild the ZIP without directory-only entries that break Android extraction;
5. read its embedded author, description, version, tags, and thumbnail; campaigns
   without a root thumbnail automatically receive a four-panel preview made from
   up to four level thumbnails;
6. assign a stable custom ID (or update an existing item with the same name);
7. upload every normalized payload to the `marble-race-workshop-content`
   Cloudflare R2 bucket;
8. update `items.json` and `cloudflare/catalog.mjs`;
9. run `node --test` before offering to commit and deploy; and
10. wait until the new timestamp appears on the live API.

Press Enter to accept each detected metadata value. At the final prompt, answer
`Y` to commit, push to GitHub, and trigger the Cloudflare build.

For command-line or unattended use:

```powershell
.\publish-workshop-item.ps1 `
  -ArchivePath "C:\path\to\My Level.zip" `
  -Name "My Level" `
  -NonInteractive `
  -Push
```

To inspect and normalize an archive without changing the repository:

```powershell
.\publish-workshop-item.ps1 -ArchivePath "C:\path\to\Campaign.rar" -ValidateOnly -NonInteractive
```

## Edit an existing workshop item

Double-click `edit-workshop-item.bat`, choose an item from the numbered list,
and press Enter to keep any existing value. The editor can change the name,
author, description, minimum game version, tags, and preview image. Item IDs,
resource types, payload URLs, and payload sizes are protected. Use the regular
publisher when replacing the actual level or campaign archive.

The editor updates both catalog files, runs the complete test suite, and offers
to commit and deploy the changes. If validation fails, it restores the previous
catalog automatically.

## Bulk-edit workshop metadata

Double-click `bulk-edit-workshop-metadata.bat` to change the same author name,
item name, description, or minimum game version everywhere it exactly matches.
For example, choose **Author name**, enter the old username, and then enter the
corrected username. Before changing anything, the tool lists every affected
item and marks items that are currently hidden.

Bulk changes are stored in `metadata-overrides.json` instead of rewriting the
preserved source metadata. This keeps the corrections in place after future
official-workshop mirror updates. Upload dates, IDs, previews, payloads, and
download sizes are left unchanged. The tool runs all tests and asks before it
commits and deploys the changes.

For unattended use:

```powershell
node bulk-edit-workshop-metadata.mjs `
  --field author `
  --find "Old Username" `
  --replace "Correct Username" `
  --non-interactive `
  --push
```

## Mirror the official workshop

Double-click `mirror-main-workshop.bat` to create or update a preservation
mirror of the official Marble Race workshop. The mirror is added directly to
this server's existing catalogue. Official IDs are preserved, while locally
published items use IDs starting at `10001`. The publisher skips any ID that is
already occupied, so future official items cannot silently collide with them.

Before making changes, the tool displays a plan and asks for confirmation. It:

1. reads every page from the official Marble Race Items API;
2. treats the numeric official `Description` value as its Steam Workshop ID;
3. requests the real description and tags from Steam in batches;
4. downloads each payload and preview as a stream and verifies the exact payload
   size, ZIP integrity, safe archive paths, root JSON, and preview format;
5. uploads the original files without repacking them under the `official/`
   prefix in the existing R2 bucket;
6. saves a local checkpoint after every completed item, so rerunning after an
   interruption skips completed uploads;
7. writes `main-workshop-manifest.json` with source URLs, Steam IDs, timestamps,
   public mirror URLs, and SHA-256 hashes;
8. retains previously mirrored items if they later disappear from the source;
9. merges the mirror with the custom catalogue and runs the full test suite; and
10. optionally commits, pushes, and waits for the mirrored catalogue to appear
    on the live API.

The checkpoint and temporary downloads are stored in `.mirror-cache`, which is
not committed. Payloads and mirrored previews are stored only in R2; Git stores
the catalogue and preservation manifest.

To inspect the complete plan without downloading or changing anything:

```powershell
node mirror-main-workshop.mjs --plan
```

To download and validate one official item without uploading it:

```powershell
node mirror-main-workshop.mjs --validate-downloads --item-id 1066
```

For a future unattended incremental update:

```powershell
node mirror-main-workshop.mjs --non-interactive --push
```

`--max-items` and `--item-id` are deliberately restricted to the read-only plan
and validation modes. This prevents a test run from accidentally deploying an
incomplete official catalogue. Use `--force` on a full run only when every
mirrored file needs to be copied again.

The publisher and mirror require `7z` and `git` on `PATH`, plus Node.js for the
test suite. Run `npm install` once to install Wrangler, then run
`npx wrangler login` once so the publisher can upload to R2. Payloads are
served from `https://content.marble.kevin-kuhn.dev` and are no longer committed
to Git, so archives larger than GitHub's 100 MiB file limit are supported.

## Review possible stolen or duplicated levels

Double-click `scan-workshop-duplicates.bat`. The scanner downloads each
official archive one at a time, extracts only JSON metadata, and stores compact
fingerprints in `.duplicate-scan-cache`. It is resumable: if it is interrupted,
run it again and completed items will be reused. The downloaded ZIPs are
deleted immediately after fingerprinting.

When the scan finishes it opens `duplicate-review.html`. The review page shows
the confidence, previews, authors, original dates, Steam links, and the exact
campaign level paths that matched. Decisions are kept in the browser and can
be exported as `marble-duplicate-decisions.json`. Available decisions are:

For campaign matches, the page separately compares every contained level with
the oldest upload. It lists matching, changed, added, missing, and renamed
levels. A campaign is labelled a complete match only when every contained
level matches; a single shared level is labelled a partial match.

The page initially shows only matches credited to different authors, since
those are the strongest stolen-content candidates. Use the filter to inspect
same-author revisions and every other duplicate group.

- **Needs review** — make no decision yet.
- **Keep all** — record that the match is legitimate.
- **Hide selected** — mark one or more IDs for a later moderation step.

Hide selections are global. Marking an item once checks it everywhere it
appears. Every duplicate group containing that hidden item is treated as
resolved and disappears from the default unresolved views, even when the group
also contains multiple good items. It remains visible under **All matches**, and
unchecking it anywhere restores it globally. Existing per-group choices from
older review pages are migrated automatically.

The scanner never edits `items.json`, hides content, deletes R2 objects, or
publishes anything. Upload age is evidence only; it does not prove authorship.
Exact archive matches receive the highest confidence. The scanner also finds
identical layouts after authorship/GUID metadata or visual materials change,
layouts with at least 90% detailed-object overlap, and cross-version geometry
with at least 85% matching object types and transforms. Empty/template levels
are ignored to limit false positives.

By default only the 621 mirrored official items are scanned. To also compare
your custom uploads, run:

```powershell
node scan-workshop-duplicates.mjs --include-custom
```

To rebuild the page without downloading anything, run:

```powershell
node scan-workshop-duplicates.mjs --report-only
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
The `search` value matches names, author usernames, descriptions, tags, or an exact item ID. In
Marble Race, enter IDs as `#10001` or `id:10001`. A digits-only search uses the
game's single-item lookup, which cannot represent an empty result; the prefixes
keep it on the normal list search so an unknown ID quietly returns no results.
Hidden items remain excluded from ID searches.

The server homepage is a mobile-friendly workshop browser. It loads visible
items directly from `/api/Items`, displays their numeric IDs, and supports
client-side searching, type filters, sorting, item details, and downloads.

This implements the catalog API, but a real level still has to use the payload
format expected by Marble Race. The supplied API document does not define that
file format.
