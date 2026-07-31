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

**Run the audit after any UI change:**

```bash
node scripts/ui-audit.mjs http://127.0.0.1:8080 /tmp/loopa-shots
```

Five viewports, seventeen views, and it fails on real defects. Note its hard-won
correctness rules — if you extend it, keep them: visibility must be checked up the
ancestor chain (a card's actions are opacity:1 inside an opacity:0 container),
`elementFromPoint` is only meaningful for elements actually on screen, and console errors
are filtered to our own frames (the studio embeds the YouTube player, which logs its own
noise into the page).

It only catches what it can measure. It reports nothing about elements it does not query —
the trim handles are `role="slider"` divs, so the clipped-handle bug above was invisible to
it and only turned up by looking at the screenshots. Look at them.

## Deploying

Target is `super_server` (Windows 11, Docker, RTX 5060 Ti, ~10 TB free on `H:` and `X:`),
behind a Cloudflare tunnel. Code-only change: push, `git pull` on the box, restart the
`loopa` container. Dependency or Dockerfile change: real rebuild.

Point `LOOPA_MEDIA_HOST_DIR` at a big disk. The database is small; the media is not.

The GPU on that box is shared with Sunshine game-streaming, which is why the local tagger
is optional and off by default — do not make the ingest pipeline depend on it.
