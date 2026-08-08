# DoneX — production image
# Multi-stage build on node:22-slim (Debian, not alpine) so better-sqlite3's
# native binding is glibc-based and stays ABI-compatible between the build
# and runtime stages.

########################################
# deps — install dependencies once, cached separately from source changes
########################################
FROM node:22-slim AS deps
WORKDIR /app

# python3/make/g++ are fallback tooling only: better-sqlite3 first tries to
# download a prebuilt binary for this platform and compiles from source with
# these only if no prebuilt binary matches.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      make \
      g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

########################################
# build — compile the Next.js app (standalone output)
########################################
FROM node:22-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

########################################
# runtime — minimal image, same base as build for ABI compatibility
########################################
FROM node:22-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Next's standalone output already contains a pruned node_modules with
# better-sqlite3's native binding traced in — no separate copy needed.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public

# Volume mount point for the SQLite database (see DATA_DIR).
RUN mkdir -p /data && chown -R node:node /data

USER node
EXPOSE 3000

CMD ["node", "server.js"]
