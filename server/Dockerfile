# EarthWalk world server. Build from the server/ directory.
FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public

# Downloaded map data and built chunks. Mount a persistent disk here so they survive restarts.
ENV EARTHWALK_CACHE=/data
RUN mkdir -p /data && chown node:node /data
VOLUME /data

# Hosting providers put their own proxy in front, so take the caller's address from it.
ENV EARTHWALK_TRUST_PROXY=1
# On Linux the C library keeps a pool of memory for each thread that asks for some (Node reads files on
# four), and gives little of it back: a process whose JavaScript heap is 200 MB can hold 450. Two pools at
# most. (The live machine reached 470 MB of its 512 on 2026-11-23 with the heap capped at 192.)
ENV MALLOC_ARENA_MAX=2
ENV PORT=8787
EXPOSE 8787

USER node
# The heap is capped well under the 512 MB of a small host, and its nursery kept small, so that Node tidies
# up in good time and does not grow until the host stops it (which is what happened on 2026-11-23, twice).
# Measured with the heaviest places built from nothing: what is really alive is at most 112 MB, but with the
# old 240 MB cap and the usual nursery up to 240 MB of finished-with scratch piled up first, and the process
# reached 414 MB on the live machine; with these it stays under 280 MB here, and builds take about a sixth longer.
CMD ["node", "--max-old-space-size=192", "--max-semi-space-size=8", "src/index.ts"]
