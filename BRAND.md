# Loopa — concept & brand

A self-hosted, web-based media library for the funny stuff — think Plex, but instead of
films and TV it catalogs **videos, gifs and clips**, tags them with AI, and makes them
findable in a couple of keystrokes. Built to be shared with a handful of friends.

The problem it solves: everyone has a folder (or six) of reaction gifs and clips scattered
across Discord saves, phone downloads and a NAS. None of it is searchable, so none of it
ever gets used. Loopa indexes the pile and gives it a front door.

## Core idea

| | |
|---|---|
| **Drop it in** | Drag and drop anywhere on the page — files, folders, or a pasted URL. Uploads queue, thumbnail, and start indexing without a page change. |
| **AI tags it** | Every clip gets auto-tagged on ingest: what's happening, who's in it, the vibe, spoken words (transcript), and on-screen text (OCR). Tags are editable — the AI seeds the library, it doesn't own it. |
| **Smart search** | One search box over tags, transcripts, OCR text, filenames and captions. Search-as-you-type, results narrowing per keystroke. "dog", "wait for it", "someone falls over" should all land. |
| **Categories** | Create a category in one click, then drag clips into it. A clip can live in many. Smart categories can also fill themselves from a saved search. |
| **Polished** | It should feel like a product, not a homelab tool: fast grid, hover-to-preview, keyboard navigation, real empty states, light and dark. |

## Design constraints worth stating up front

- **Built for scale.** The library grows forever. Everything paginates or virtualizes,
  the grid stays smooth at thousands of clips, and any list past ~10 items gets a
  type-to-filter box rather than a plain dropdown.
- **Friends, not the public.** Small trusted user set, simple auth, per-user
  favorites. Not a public upload site — that changes the moderation story entirely.
- **The originals are sacred.** Loopa indexes and derives (thumbnails, transcripts,
  tags); it never rewrites or moves the source files.

## Colour

| Token | Value | Use |
|---|---|---|
| Coral | `#ED7659` | The mark, primary actions, focus rings |
| Shell | `#0c0d12` | App background, icon tiles |
| Paper | `#f7f7fa` | Light-theme background |

Coral was sampled from the winning Gemini concept render; shell and paper match the
values already set in `web/index.html`.

## Icon

A loop arrow closing around a play triangle — gifs loop, videos play. No text, so it
survives being shrunk to a favicon.

Concept direction was generated with Forge/Gemini — `assets/concepts/` holds the six
explorations and the source grid. The winning concept was then redrawn as clean vector
geometry in `assets/icon/build_icon.py`, because the diffusion render was off-centre,
clipped at the right edge, and went soft at small sizes.

Two optical sizes ship, because one geometry can't serve both ends:

- **regular** (`loopa-mark.svg`) — used at 32px and up.
- **small** (`loopa-mark-small.svg`) — used at 16px. Heavier stroke and a tighter play
  triangle, preserving ~2px of clear space that would otherwise antialias into a blob.

`favicon.ico` carries genuinely different artwork per size (16 small / 32 / 48 regular),
not one bitmap rescaled three times.

### Rebuilding

```bash
pip install cairosvg pillow
python3 assets/icon/build_icon.py
```

The script is the single source of truth: it writes the SVG masters, every PNG raster,
the multi-resolution `.ico`, the contact sheet at `assets/icon/preview.png`, and mirrors
the served set into `web/public/` for Vite. Change colour or geometry there and re-run —
don't hand-edit the generated files.

### Markup

`web/index.html` currently links only `favicon.svg`. The full set wants:

```html
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
```

## Layout

```
assets/
  concepts/      six Forge/Gemini icon explorations + the source grid
  icon/          vector masters, build script, preview contact sheet
public/          generated icon set (canonical output)
web/public/      mirror of the above, served at / by Vite
```

## Status

Concept and brand are settled. Application scaffolding (`server/`, `web/`, Docker) is
being built in a parallel session — this document covers the idea and the icon only.
