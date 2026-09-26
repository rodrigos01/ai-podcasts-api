# Used by .github/workflows/deploy.yml, which builds this image directly on
# the GitHub Actions runner with Docker Buildx (+ its GitHub Actions layer
# cache) instead of `gcloud run deploy --source`'s buildpacks. `npm run
# deploy` (scripts/deploy.sh) still deploys via buildpacks and ignores this.
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
# audio.service.ts spawns ffmpeg per TTS chunk to encode Cloud TTS's raw PCM
# output to AAC on the fly (see utils/aacEncoder.ts, migrated 2026-09-26
# from requesting pre-compressed Ogg Opus directly — see AGENTS.md).
# --no-install-recommends skips ffmpeg's (unneeded, headless-server) video/
# hardware-acceleration dependencies.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
CMD ["node", "dist/index.js"]
