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

EXPOSE 8080

# Default: multi-tenant server backed by Supabase. Provide SUPABASE_URL,
# SUPABASE_ANON_KEY (and optionally BITCOIN_PROVIDER_URL, PORT) at runtime.
# For the single-tenant filesystem mode instead, override the command with:
#   app --data /data --port 8080   (and mount a volume at /data)
ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["host", "--port", "8080"]
