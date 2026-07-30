# ── Stage 1: build the web front-end ─────────────────────────────────────────
FROM node:22-bookworm-slim AS web-build
WORKDIR /build

# Install with the full workspace manifest set so the lockfile resolves.
COPY package.json package-lock.json* ./
COPY web/package.json ./web/
COPY server/package.json ./server/
# The web build needs no native modules; skip server's better-sqlite3 compile.
RUN npm install --workspace web --include-workspace-root --no-audit --no-fund

COPY web/ ./web/
RUN npm --workspace web run build

# ── Stage 2: install server dependencies (compiles better-sqlite3) ───────────
FROM node:22-bookworm-slim AS server-deps
WORKDIR /build

# better-sqlite3 has no prebuilt binary for every Node ABI, so keep a toolchain
# available for the fallback source build. Discarded with this stage.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm install --workspace server --include-workspace-root \
      --omit=dev --no-audit --no-fund

# ── Stage 3: runtime ─────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# ffmpeg/ffprobe drive every derivative (poster, hover preview, keyframes).
# yt-dlp handles URL ingest. ca-certificates is needed for HTTPS to the API.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg \
      python3 \
      python3-pip \
      ca-certificates \
      tini \
 && pip3 install --no-cache-dir --break-system-packages "yt-dlp>=2025.1.1" \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    MEDIA_DIR=/app/media

# node_modules comes from the image, never from a host bind mount — a host
# mount would shadow the Linux-native better-sqlite3 build with the host's.
COPY --from=server-deps /build/node_modules ./node_modules
COPY --from=server-deps /build/server/node_modules ./server/node_modules

COPY package.json ./
COPY server/package.json ./server/
COPY server/tsconfig.json ./server/
COPY server/src ./server/src
COPY --from=web-build /build/web/dist ./web/dist

RUN mkdir -p /app/data /app/media \
 && chown -R node:node /app/data /app/media

USER node
EXPOSE 8080

# start-period is generous on purpose: Node strips types for ~200 source
# modules at boot, which measured ~25s on a slow bind-mounted filesystem.
# Too short a window and Docker restart-loops a server that was merely starting.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini reaps the ffmpeg/yt-dlp children this server spawns.
# Node 22 strips TypeScript types natively, so there is no server build step —
# which is what lets a code change deploy as `git pull` + restart.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/src/index.ts"]
