# Loopa — working notes

Self-hosted catalog of funny clips. Read this before changing anything; the entries here
are the things that already bit, or that are load-bearing in a way the code does not
announce.

## Shape

- `server/` — Fastify + SQLite (better-sqlite3, WAL, FTS5). **No build step**: Node 22
  strips TypeScript at load, which is what makes `git pull` + restart a valid deploy.
- `web/` — React 19 + Vite, plain CSS with design tokens. Built to `web/dist`, served by
  the API.

## Rules that matter

**Imports need the `.ts` extension.** Native type stripping requires the full specifier —
`import { db } from '../db/index.ts'`, not `'../db/index'`.

**No enums, namespaces, or parameter properties** anywhere in `server/`. `tsconfig` sets
`erasableSyntaxOnly` because type stripping erases rather than compiles; those constructs
emit runtime code and will fail at load. Use `as const` objects and union types.

**Never mount host `node_modules` into the container.** It shadows the image's
Linux-native `better-sqlite3` with whatever the host built. Mount `server/src` and
`web/dist` only — see `docker-compose.override.yml`.

**`@fastify/static`: set `cacheControl: false` when using `setHeaders`.** Otherwise the
plugin's own `maxAge` overwrites whatever `setHeaders` sets, and `index.html` gets cached
for an hour — meaning a deploy does not reach browsers, and stale HTML requests asset
hashes that no longer exist. This already happened once.

**Boot takes ~25 seconds** (type-stripping ~200 modules; slower on a bind-mounted
filesystem). Health checks use a 90s start period. If a smoke test reports "not
listening", wait longer before concluding it is broken.

## Search index

`clips_fts` is a **standalone** FTS5 table, not external-content, because its text is
stitched together from `clips` *plus* their tags — SQLite triggers can only mirror one
source table. Every write path that touches searchable text must call `reindexClipById()`.
`updateClip()` does this automatically for title/description/transcript.

Never interpolate user input into a `MATCH` expression. `buildMatchExpression()` quotes
every token; `"`, `*`, `:`, `^`, `-`, `AND`, `OR` and `NEAR` are all FTS5 syntax.

## Ingest

**Instagram and TikTok are the main path, and they break often.** Site extractors change
every few weeks. `Settings → Ingest → Update` runs `yt-dlp -U` in place — try that before
debugging anything else when an import that used to work stops.

**Instagram needs cookies** for most Reels. `data/cookies/<site>.txt`, Netscape format,
picked up automatically. `interpretYtDlpFailure()` maps the recurring failure modes onto
messages that say what to do — extend it rather than letting a raw stderr reach the UI.

**Captions are signal, not noise.** On a Reel or TikTok the caption is often the entire
joke and is invisible in the frames. It is passed to the tagger as context and hashtags
become tags immediately. Do not drop it.

**URL ingest is SSRF-guarded** (`assertPublicHost`). Any signed-in member can paste a link,
so without it the server is a proxy into the LAN. Keep the guard on any new fetch path.

## Clip studio

`/studio` — paste a YouTube link, trim a range, send it to the library. The player is a
YouTube embed, not a local file: downloading before anything can be shown would turn a
two-second interaction into a two-minute wait for a video that may never get clipped.

**Only the selected range is downloaded.** `fetchSection()` uses `yt-dlp
--download-sections` with `--force-keyframes-at-cuts`, so grabbing 20 seconds out of a
three-hour stream costs 20 seconds of bandwidth. Verified against Big Buck Bunny: 8.500s
requested → 8.500s delivered, H.264/AAC/yuv420p, which means `needsTranscode()` skips it
and derive streams the original untouched.

**Never pass `--max-filesize` on a section fetch.** It is compared against the *whole*
video's size, so a long source is refused even when only a few seconds of it are wanted.
The produced file is size-checked after the fact instead, and `MAX_CLIP_HEIGHT` (1080)
caps the format so a 4K master isn't pulled for a 20-second cut.

**The cut is verified, not trusted.** Some extractors quietly ignore the section and
return the whole video; shipping that into the library as "your 12-second clip" would be
a silent, baffling failure. `fetchSection()` ffprobes the result and falls back to an
exact `trimSegment()` when the duration drifts more than 900ms.

**`clip_url` is a download job**, so it belongs in `DOWNLOAD_TYPES` (grid placeholders,
cancellation) *and* in the network pool's types in `index.ts`. Miss either and clips queue
forever with no card to show for it.

**The timeline is two-tier on purpose.** A 20-second selection inside a three-hour video
is 0.2% of the width — under a pixel of travel per second, which is not a control anyone
can use. The overview strip plus a zoomable detail track is what makes long videos
workable; the numeric timecode fields are the exact path when dragging is not.

**Trim handles sit outside their edge, and flip inward at the track's ends.** The track
clips its overflow, and the default selection starts at 0:00 — without the flip the start
handle is drawn outside the track and cannot be grabbed at all.

**The YouTube IFrame API replaces the element it is given.** It is handed a node created
imperatively, never a React-managed child, or unmount throws trying to remove a node that
is no longer there.

Typing a timecode and pressing `[` go through the same `setStart`/`setEnd` rules, so a
start past the current end carries the window along instead of snapping back. They drifted
apart once and the typed value silently appeared to be ignored.

## AI tagging

Cost is `(width × height) / 750` image tokens per frame — **frame size dominates, not the
model**. Six 512px frames ≈ 1,200 tokens ≈ $0.0035/clip on Haiku 4.5. Before "optimising"
by switching models, check `TAGGER_FRAME_WIDTH` first.

The tagger is behind an interface (`ai/types.ts`) with `claude` and `local` providers.
A missing API key **degrades to untagged ingest** rather than failing uploads — keep it
that way; an unusable tagger must not stop people watching clips they already have.

Haiku 4.5 does **not** support `output_config.effort` — passing it errors. Structured
output via `output_config.format` is fine and is what keeps responses parseable.

## Media

Transcode only when the browser genuinely cannot play the file. The common case — a Reel
or TikTok, already H.264/AAC in MP4 — must stream its original untouched. GIFs always
convert (98 KB → 21 KB in testing, and they gain real seeking).

Posters seek to 25% rather than frame 0: the first frame of a Reel is very often black.

## UI

`web/src/styles/tokens.css` is the single source of colour, spacing, radius, shadow and
duration. Never hardcode a hex or introduce a near-duplicate grey.

**Clip tiles are a uniform square with a blurred backdrop.** This is deliberate and was
arrived at by trying the alternatives: sizing each card to its own aspect ratio leaves
ragged dead space (the library mixes 9:16 and 16:9), and cropping to 16:9 mangles vertical
clips, which are the majority here. A square gives 16:9 and 9:16 an identical 56% fill and
crops nothing.

**⌘V/Ctrl+V adds whatever is on the clipboard**, handled in `DropZone` next to the drop
handler since that already owns uploading and the progress tray. Files upload; plain text
that parses as http(s) URLs is queued as an import. Two rules keep it from hijacking normal
pasting: files are taken regardless of focus (an image pasted into a search box has no text
meaning), but *text* is ignored whenever the caret is in an input, textarea or
contenteditable — otherwise pasting a link into the search field would import it.

Pasted files get a generated `pasted-<timestamp>.<ext>` name. Browsers hand over
`image.png` for every screenshot, and the grid falls back to the filename when a clip has
no title yet, so without this a run of pasted screenshots is a wall of identical cards.

**Right-click a clip for the action menu.** `ContextMenu` is generic (items in,
positioned menu out) and anchored to the cursor; it measures itself after mount and clamps
into the viewport, because a menu opened near the bottom of the grid has to flip up and
there is no way to know whether it fits without measuring.

Focus the first item with `focus({ preventScroll: true })`. A plain `focus()` — or React's
`autoFocus` — lets the browser scroll an ancestor to reveal the item, which fires the
scroll listener that closes the menu, so it shuts the instant it opens. The scroll listener
is also attached a frame late and ignores scrolls originating inside the menu.

**`ClipCard`'s memo comparator must list every field the card renders.** It was comparing
`updatedAt` as a catch-all, which is fine for server round-trips but not for an optimistic
local edit — renaming from the context menu changes `title` without touching the server's
timestamp, so the card kept showing the old text until something else forced a render. The
rename looked broken while actually having saved.

**Right-clicking a card inside a multi-selection acts on the whole selection**, the same
rule drag-and-drop follows. The handler passed to `ClipCard` must therefore close over
nothing but the setter: `ClipCard` is memoised on its data fields and ignores callback
identity, so a handler capturing `selection` goes stale on every card that did not
re-render. Store the click, build the items in `ClipGrid`'s render where the selection is
current.

**Comments are soft-deleted and keep their place.** A thread with holes punched in it reads
as broken, so a removed comment renders as a tombstone rather than vanishing — but the body
is cleared in the same statement, because a "deleted" comment still sitting in the database
in full is not what anyone means by deleting it. `author_id` is `ON DELETE SET NULL` for the
same reason: losing the row would silently rewrite a conversation. Editing is the author's
alone and expires after 15 minutes; an admin can delete but never edit, so nobody can put
different words in someone else's mouth. Edit and delete return the whole refreshed thread,
so the client never reconciles against a stale list.

**`max_uses = 0` on an invite means unlimited.** The column had `CHECK (max_uses > 0)`, and
SQLite cannot alter a CHECK — migration 2 rebuilds the table, guarded so it is a no-op when
the schema already has the relaxed form. Three places read the sentinel: the clamp in
`createInvite`, the `findUsableInvite` guard, and the conditional `UPDATE ... WHERE uses <
max_uses` that settles the race on the last use. A nullable column was the alternative and
is worse — `uses < NULL` is neither true nor false, so the same three places would need
special-casing anyway, silently.

**Getting clips back out** — four paths, each with its own constraint:

- *Copy* puts a **PNG** on the clipboard, because that is the only image type the API
  accepts across browsers. A video has no frame to copy but its poster, so the menu item
  says "Copy poster frame" rather than implying the video went to the clipboard. It needs a
  secure context — over plain http on a LAN address `navigator.clipboard.write` simply is
  not there, so check for it and say why rather than failing silently.
- *Drag out* sets `DownloadURL` (`mime:filename:absolute-url`), which is what makes a drag
  into a file manager or chat app fetch the real file. Chromium-only, so `text/uri-list`
  rides along for everything else. Single clip only — the format carries one file.
- *Save* on one clip hits the existing download route; on several it hits
  `/api/clips/bulk/download.zip`, because browsers block a burst of separate downloads.
- The ZIP is **written by hand** (`media/zip.ts`), store-only and streamed. Deflate would
  cost CPU to make an H.264/JPEG archive *larger*, and pulling in `archiver` would mean a
  Docker rebuild for ~100 lines of well-specified header layout. It uses data descriptors
  (general-purpose bit 3) so each file is read exactly once — the CRC is not known until
  after the bytes have gone out. 32-bit size fields cap it at 4 GB; the route refuses past
  that rather than half-implementing ZIP64.

**That route lives under `bulk/`.** `/api/clips/download.zip` collides with
`/api/clips/:id` — the parametric route wins and every request comes back "That clip does
not exist."

**Deleting is undoable, and the undo has to reindex.** `softDeleteClip()` removes the clip
from `clips_fts`, so `undeleteClip()` calls `reindexClipById()` — without it a restored
clip comes back invisible to search, which is a silent failure nobody would notice until
they went looking for it. `getClip()` filters deleted rows out, so restore looks the row up
with `getDeletedClip()`. Do not reuse `reviveClip()`: that one re-runs processing because
it exists for re-adding a file whose derivatives may have been purged, and an undo seconds
after a delete would pointlessly re-transcode.

**A floating listbox has to be `position: fixed`, not absolute.** The category combobox in
`SoundbiteDialog` started out absolute inside its field, and lost its last options to
`.modal__panel { overflow: hidden }` while burying the dialog's own Send button — so picking
a category and sending took two clicks, the first of which only dismissed the list. Fixed
positioning with a measured placement (prefer down, flip up only under ~120px of room, clamp
the height to the *panel* so it never hangs out of the dialog) fixes both, and it also puts
the list in its own stacking layer, which is what stops the UI audit reporting every
dropdown as an unreachable-control collision. That last part is not a workaround: an open
dropdown covering what is behind it is deliberate, and the audit distinguishes layers
precisely so it can tell the two apart.

**Run the audit after any UI change:**

```bash
node scripts/ui-audit.mjs http://127.0.0.1:8080 /tmp/loopa-shots
```

Five viewports, twenty views, and it fails on real defects. Note its hard-won
correctness rules — if you extend it, keep them: visibility must be checked up the
ancestor chain (a card's actions are opacity:1 inside an opacity:0 container),
`elementFromPoint` is only meaningful for elements actually on screen, and console errors
are filtered to our own frames (the studio embeds the YouTube player, which logs its own
noise into the page).

It only catches what it can measure. It reports nothing about elements it does not query —
the trim handles are `role="slider"` divs, so the clipped-handle bug above was invisible to
it and only turned up by looking at the screenshots. Look at them.

## CarbonBoard

`Send to CarbonBoard` (admin only) trims a clip's audio and pushes it to the **CarbonBoard
clip server** — `http://192.168.0.35:9601` on carbonserver, which is what Cortex's
`Discord → Sounds` tab and the `tunebox__play_clip` action read. Its API is three calls:
`GET /api/clips`, multipart `POST /api/clips`, `POST /api/clips/:id/image`. No auth, open
CORS; it is a LAN utility service. Verified reachable from inside the deployed `loopa`
container on super_server, so the default needs no configuration.

**Categories over there are free text with no registry.** The only way to answer "what
categories exist" is to read them off the existing clips, which is why the dialog's combobox
accepts a new one as readily as it picks an existing one, and why a clip server that is
unreachable still lets the dialog open — a category typed by hand is valid either way.

**Cut to MP3, and fade the ends.** A hard cut lands mid-waveform on a non-zero sample, which
clicks audibly through speakers; 20ms of `afade` at each end removes it. `loudnorm` to -16
LUFS is on by default because clips come from sources 20dB apart, and a soundboard where
every button needs its volume nudged by hand is not one anyone uses. Single-pass on purpose
— two-pass measures the whole file first, and this is a ten-second cut.

**The send is synchronous, unlike every other media job here.** The source is already on
local disk, so it is one ffmpeg pass and one LAN POST — a couple of seconds. A job id the
caller then has to poll would be more machinery for a worse interaction, and the person who
pressed the button wants to know it landed.

**Button art is best-effort and must stay that way.** `pushSoundbiteImage()` returns null
rather than throwing: losing the audio because a thumbnail failed is the wrong trade.

**The range refers to the *playable* derivative**, which is what the dialog's player streams
— so the extract reads `playable_path` before `original_path`. Cutting from the original
when a transcode exists would silently offset the result on any clip whose derivative was
re-timed.

## Deploying

Target is `super_server` (Windows 11, Docker, RTX 5060 Ti, ~10 TB free on `H:` and `X:`),
behind a Cloudflare tunnel. Code-only change: push, `git pull` on the box, restart the
`loopa` container. Dependency or Dockerfile change: real rebuild.

Point `LOOPA_MEDIA_HOST_DIR` at a big disk. The database is small; the media is not.

The GPU on that box is shared with Sunshine game-streaming, which is why the local tagger
is optional and off by default — do not make the ingest pipeline depend on it.

### The Conduit demo, and why chat embeds need it public

`loopa.conduit.carboncortex.dev` is a Conduit **service** demo. Two properties of it break
link unfurling in ways that look like an app bug and are not:

**It must be `public: true`.** A private demo's proxy answers every anonymous request with
a 401 "Sign in required" page — served by *Express*, before Fastify ever sees it. Discord's
crawler is anonymous, so it gets that page, finds no `og:` tags, and renders a bare blue
link. Diagnose this by curling the share URL with a `Discordbot` user-agent and looking at
`x-powered-by`: Express means the proxy answered, Fastify means the app did. Making it
public does **not** expose the library — `/api/*` and `/media/*` still return 401 without a
Loopa session; only `/s/<token>` is deliberately anonymous.

**It sleeps when idle**, and Loopa's ~25s boot makes the cold start long enough that a
crawler hitting it mid-wake caches a no-embed result. A `LoopaKeepWarm` scheduled task on
carbonserver curls `/api/health` every 4 minutes to prevent that. It is registered
"interactive only", so it stops running if nobody is logged in to that box.
