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
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
CMD ["node", "dist/index.js"]
