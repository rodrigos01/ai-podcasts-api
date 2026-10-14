# Used by .github/workflows/deploy.yml, which builds this image directly on
# the GitHub Actions runner with Docker Buildx (+ its GitHub Actions layer
# cache) instead of `gcloud run deploy --source`'s buildpacks. `npm run
# deploy` (scripts/deploy.sh) still deploys via buildpacks and ignores this.
# The admin SPA (admin/) is built separately and served by the API at /admin.
# The Firebase web config is public (it ships in the bundle); the API key comes
# in as a build arg from the FIREBASE_WEB_API_KEY repository variable.
FROM node:22-slim AS admin-build
WORKDIR /admin
ARG VITE_FIREBASE_API_KEY
ARG VITE_FIREBASE_AUTH_DOMAIN
ARG VITE_FIREBASE_PROJECT_ID
COPY admin/package*.json ./
RUN npm ci
COPY admin/ ./
RUN npm run build

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
# ffmpeg encodes raw PCM chunks from Gemini TTS into standalone ADTS AAC
# chunks — see src/utils/aac.ts and src/services/audio.service.ts.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=admin-build /admin/dist ./admin/dist
CMD ["node", "dist/index.js"]
