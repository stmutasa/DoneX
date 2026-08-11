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
# One id for the whole build (next.config is evaluated once per compilation,
# so it has to be fixed here rather than generated in the config). The running
# app compares it against the server's to detect a deploy it hasn't picked up.
RUN NEXT_PUBLIC_BUILD_ID="b$(date +%Y%m%d%H%M%S)" npm run build

########################################
# runtime — minimal image, same base as build for ABI compatibility
########################################
FROM node:22-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# gosu: start as root so the entrypoint can claim the volume mount for the
# app user, then drop privileges with correct signal handling.
RUN apt-get update && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/*

# Next's standalone output already contains a pruned node_modules with
# better-sqlite3's native binding traced in — no separate copy needed.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /data && chown -R node:node /data

EXPOSE 3000

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
