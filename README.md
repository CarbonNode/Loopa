# Loopa

A self-hosted catalog for the funny clips your group actually shares. Plex-shaped:
drop files in or paste a link, and every clip gets a poster, a hover preview, AI-written
tags, and instant search.

Built for a private group — invite-only, no public signup, everything on your own disk.

---

## What it does

- **Drag and drop anywhere** on the page to upload. Videos, GIFs, images, as many at once
  as you like, with per-upload progress.
- **Paste an Instagram Reel or TikTok link** (or YouTube, Reddit, X, Imgur, or a direct
  video URL) and Loopa downloads it server-side. Paste ten at once, one per line.
- **AI tagging** on every clip: a title, a description, six to twelve search keywords, the
  on-screen text, and a suggested category. Roughly **$0.0035 per clip** on Claude Haiku 4.5.
- **Search that finds things**, across titles, tags, captions, on-screen text and
  transcripts — as you type, with prefix matching from the second keystroke.
- **Categories by drag and drop.** Drag a clip (or a Ctrl-selected pile of them) onto a
  category in the sidebar.
- **Deduplication by content hash**, so the same clip shared twice resolves to one entry.
- **Send a line to the soundboard.** An admin can trim any clip's audio, listen to the
  selection on a loop, and push it to [CarbonBoard](#sending-a-soundbite-to-carbonboard) as
  an MP3 — where it becomes a button anyone can fire into Discord voice.

## Requirements

- Docker, or Node 22+ with `ffmpeg` and `yt-dlp` on `PATH`
- An `ANTHROPIC_API_KEY` for AI tagging (optional — without it, clips still ingest untagged)

---

## Running it

```bash
cp .env.example .env
# Set SESSION_SECRET (openssl rand -hex 32) and ANTHROPIC_API_KEY.
# Point LOOPA_MEDIA_HOST_DIR at a disk with room.

docker compose up -d
docker compose logs -f loopa
```

The first boot prints a one-time setup URL to the log:

```
┌─ Loopa is not set up yet ──────────────────────────────
│  Open this once to create the first (admin) account:
│  https://loopa.example.com/setup?token=…
└────────────────────────────────────────────────────────
```

Open it, create the admin account, then invite everyone else from **Settings → People**.

### Without Docker

```bash
npm install
npm run build:web
npm start
```

For development, `npm run dev` runs the API on `:8080` and Vite on `:5173` with a proxy.

---

## Importing Reels and TikToks

This is the path most clips arrive through, so it is worth setting up properly.

**Instagram almost always requires cookies.** Anonymous Reel downloads are refused most of
the time. Export a `cookies.txt` from a browser signed in to Instagram (any Netscape-format
cookie extension does this) and upload it under **Settings → Ingest → Site cookies**. Loopa
warns you *before* queueing links if the cookies for a site are missing.

**When imports suddenly break, update yt-dlp first.** Instagram and TikTok change their
internals often enough that a working extractor can stop working within weeks. There is an
**Update** button under Settings → Ingest that does this in place — no image rebuild.

Captions are used, not discarded: on a Reel or TikTok the caption is frequently the joke
itself, and the frames alone would never recover it. It is fed to the tagger alongside the
keyframes, and hashtags become tags immediately.

---

## What the AI tagging costs

Per clip: six keyframes downscaled to 512px, plus the caption and any transcript.

| Model | $/MTok in / out | ~per clip | 10,000 clips |
|---|---|---|---|
| **`claude-haiku-4-5`** (default) | $1 / $5 | **$0.0035** | $35 |
| `claude-sonnet-5` | $3 / $15 | $0.0105 | $105 |

Image tokens are `(width × height) / 750`, so **frame size is the real cost lever** — not
the model. `TAGGER_FRAME_WIDTH` and `TAGGER_KEYFRAMES` control it directly.

Running spend is shown under Settings → Library.

`TAGGER_PROVIDER=local` points the same pipeline at an OpenAI-compatible vision endpoint
you host yourself (Ollama, vLLM), which is free per clip.

---

## How it works

```
upload / paste link
        │
        ▼
  fetch_url ──► yt-dlp downloads, captures caption + uploader + hashtags
        │
        ▼
  content hash ──► already have it? stop, no duplicate
        │
        ▼
  derive ──► ffprobe · transcode only if the browser can't play it
        │      · poster (seeked 25% in, past the fade)
        │      · muted hover-preview loop
        ▼
  tag ──► keyframes ──► Claude ──► title, description, tags, categories
        │
        ▼
  FTS5 index ──► searchable
```

Everything after upload runs through a SQLite-backed job queue, so an in-flight transcode
survives a restart and a rate-limited download retries with backoff.

**Storage** is content-addressed: `media/originals/ab/cd/<sha256>.mp4`, with derivatives
under `media/derived/<sha256>/`. Deleting a clip is a soft delete — the file stays until an
admin purges, so an accidental removal is recoverable.

**Transcoding is skipped when it can be.** A TikTok or Reel is already H.264/AAC in MP4 and
streams as-is. GIFs are always converted, which is a large win: a 98 KB GIF became a 21 KB
MP4 in testing, and it seeks and loops properly afterwards.

## Layout

```
server/src/
  config.ts          environment parsing, one place
  db/                schema.sql + connection (WAL, FTS5)
  auth/              scrypt passwords, cookie sessions, invite codes
  media/             ffmpeg wrappers, yt-dlp ingest, content-addressed storage
  ai/                pluggable tagger — claude.ts, local.ts
  jobs/              durable queue + the three job handlers
  clips/             the repository every route reads through
  http/routes/       the API
web/src/
  components/        grid, card, sidebar, lightbox, dialogs
  screens/           auth, settings
  styles/tokens.css  every colour, radius and duration in the app
scripts/ui-audit.mjs multi-viewport screenshots + layout-defect detection
```

The server runs TypeScript directly — Node 22 strips the types at load. There is no build
step, which is what lets a deploy be `git pull` + restart.

## Sending a soundbite to CarbonBoard

Right-click a clip → **Send to CarbonBoard…**, or open it and press **To CarbonBoard**. Both
are admin-only, and only appear on a ready clip that has an audio track.

The dialog plays the clip, gives you the same two-tier timeline the clip studio uses, and
loops the selected range so you can hear the cut before committing it. On send, the range is
encoded to a 192 kbps MP3, loudness-matched to the same target as every other button, and
uploaded — along with the clip's poster frame as button art, since CarbonBoard draws its
buttons as cards.

| Variable | Default | What it does |
|---|---|---|
| `CARBONBOARD_URL` | `http://192.168.0.35:9601` | The CarbonBoard clip server. |
| `ENABLE_CARBONBOARD` | `true` | `false` hides the action entirely. |
| `CARBONBOARD_MAX_SECONDS` | `60` | Longest soundbite Loopa will cut. |
| `CARBONBOARD_BITRATE` | `192k` | MP3 bitrate. |

A clip server that is down does not break anything: the dialog still opens, says so, and the
send reports which address it tried.

## Testing the UI

```bash
node scripts/ui-audit.mjs http://127.0.0.1:8080 /tmp/loopa-shots
```

Drives a real browser at five viewports from 360px to 1920px through twenty-odd views, writes
screenshots, and fails on horizontal overflow, unreachable controls, clipped text and
sub-24px tap targets.

## Notes

- Media is behind the same auth as the API — a clip URL is not publicly shareable.
- URL imports are guarded against pointing at your LAN (private and link-local addresses
  are refused), since any member can paste a link.
- Sessions are stored hashed, so a database leak does not hand out live sessions.
- Boot takes ~25s: Node type-strips ~200 modules at startup. The healthcheck allows for it.
