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
ENV PORT=8787
EXPOSE 8787

USER node
CMD ["node", "src/index.ts"]
