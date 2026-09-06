# syntax=docker/dockerfile:1
# Multi-stage build — deps + build + runtime. Alpine base for minimal attack surface.

FROM node:20-alpine AS deps
WORKDIR /app
# --- Install prod dependencies in an isolated layer so rebuilds are fast ---
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund --ignore-scripts --legacy-peer-deps

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund --ignore-scripts --legacy-peer-deps
COPY tsconfig.json ./
COPY src ./src
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ARG GIT_SHA=dev
# dumb-init for proper signal forwarding inside the container
RUN apk add --no-cache dumb-init curl && \
    addgroup -S workers && adduser -S workers -G workers -u 10001

COPY --from=deps    --chown=workers:workers /app/node_modules ./node_modules
COPY --from=build   --chown=workers:workers /app/dist         ./dist
COPY                --chown=workers:workers package.json     ./package.json

USER workers
ENV NODE_ENV=production
ENV GIT_SHA=$GIT_SHA
ENV PORT=8081
EXPOSE 8081

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8081/health > /dev/null || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.mjs"]
