# syntax=docker/dockerfile:1
# Multi-stage build — deps + build + runtime. Alpine base for minimal attack surface.

FROM node:20-alpine AS deps
WORKDIR /app
# --- Install prod dependencies in an isolated layer so rebuilds are fast ---
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts --legacy-peer-deps

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund --ignore-scripts --legacy-peer-deps
COPY tsconfig.json ./
COPY src ./src
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA
RUN npm run build

# The horse Reel verifier uses the same pinned yt-dlp release as the World Hub
# publisher. Install its pure-Python wheel from a hash-locked requirement in a
# build stage; production never installs dependencies at request time.
FROM python:3.12-alpine AS youtube-verifier
WORKDIR /verifier
COPY scripts/youtube-verifier/yt-dlp.requirements.txt ./yt-dlp.requirements.txt
COPY scripts/youtube-verifier/yt-dlp.version ./yt-dlp.version
RUN python3 -m pip install \
      --disable-pip-version-check \
      --no-compile \
      --no-deps \
      --require-hashes \
      --target /verifier/vendor \
      --requirement /verifier/yt-dlp.requirements.txt && \
    test "$(PYTHONPATH=/verifier/vendor python3 -s -m yt_dlp --version)" = "$(cat /verifier/yt-dlp.version)"

FROM node:20-alpine AS runtime
WORKDIR /app
ARG GIT_SHA=dev
# dumb-init for proper signal forwarding inside the container
RUN apk add --no-cache dumb-init curl python3 && \
    addgroup -S workers && adduser -S workers -G workers -u 10001

COPY --from=deps    --chown=workers:workers /app/node_modules ./node_modules
COPY --from=build   --chown=workers:workers /app/dist         ./dist
COPY --from=youtube-verifier --chown=workers:workers /verifier/vendor /opt/ytdlp/vendor
COPY --from=youtube-verifier --chown=workers:workers /verifier/yt-dlp.version /opt/ytdlp/yt-dlp.version
COPY                --chown=workers:workers package.json     ./package.json
RUN test "$(PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=/opt/ytdlp/vendor /usr/bin/python3 -s -m yt_dlp --version)" = "$(cat /opt/ytdlp/yt-dlp.version)"

USER workers
ENV NODE_ENV=production
ENV GIT_SHA=$GIT_SHA
ENV PORT=8081
ENV YT_DLP_PYTHON=/usr/bin/python3
ENV YT_DLP_VENDOR_ROOT=/opt/ytdlp/vendor
EXPOSE 8081

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8081/health > /dev/null || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.mjs"]
