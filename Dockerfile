# Self-hosted OpenGiveaway server (organizer Web UI + API + public verifier).
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
COPY scripts ./scripts
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/web ./web

# Giveaway data is persisted here; mount a volume to keep it across restarts.
VOLUME ["/data"]
EXPOSE 8080

# `serve`-ready: organizer UI on 8080, data under /data.
ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["app", "--data", "/data", "--port", "8080"]
