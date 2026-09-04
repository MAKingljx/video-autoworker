FROM node:22.22.3-slim AS base
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

FROM base AS deps
# Copy only dependency manifests first for better layer caching
COPY package.json ./
COPY pnpm-lock.yaml* ./
# better-sqlite3 requires native compilation tools
RUN apt-get update && apt-get install -y python3 make g++ --no-install-recommends && rm -rf /var/lib/apt/lists/*
RUN if [ -f pnpm-lock.yaml ]; then \
      pnpm install --frozen-lockfile; \
    else \
      echo "WARN: pnpm-lock.yaml not found in build context; running non-frozen install" && \
      pnpm install --no-frozen-lockfile; \
    fi

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Docker is a diagnostic-only build. Create an isolated source identity instead
# of copying host Git metadata, then force dirty provenance so the artifact can
# never be mistaken for a release built from a clean canonical commit.
RUN apt-get update && apt-get install -y git --no-install-recommends && rm -rf /var/lib/apt/lists/*
RUN git init && \
    git add --all && \
    git -c user.name="Docker diagnostic build" \
        -c user.email="docker-diagnostic@invalid" \
        commit -m "Synthetic Docker diagnostic source" && \
    touch .docker-diagnostic-untracked && \
    git status --porcelain | grep -q '^?? .docker-diagnostic-untracked$'
RUN pnpm build

FROM node:22.22.3-slim AS runtime

ARG MC_VERSION=dev
LABEL org.opencontainers.image.source="https://github.com/MAKingljx/video-autoworker"
LABEL org.opencontainers.image.description="Mission Control - operations dashboard"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.version="${MC_VERSION}"

WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
COPY --from=build /app/.next/standalone ./release
# Create data directory with correct ownership for SQLite
RUN mkdir -p data && chown nextjs:nodejs data
RUN echo 'const http=require("http");const r=http.get("http://127.0.0.1:"+(process.env.PORT||3000)+"/api/status?action=health",s=>{process.exit(s.statusCode===200?0:1)});r.on("error",()=>process.exit(1));r.setTimeout(4000,()=>{r.destroy();process.exit(1)})' > /app/healthcheck.js
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod 755 /app/docker-entrypoint.sh && \
    chmod -R a+rX /app/release/public/ /app/release/runtime/
USER nextjs
ENV PORT=3000
ENV MC_AUTH_MODE=openclaw-loopback \
    MC_DESKTOP_MODE=0 \
    MC_OPENCLAW_PROFILES_NO_AUTH=0 \
    MC_HOSTNAME=127.0.0.1 \
    HOSTNAME=127.0.0.1 \
    MISSION_CONTROL_DATA_DIR=/app/data \
    MISSION_CONTROL_DB_PATH=/app/data/mission-control.db \
    MISSION_CONTROL_TOKENS_PATH=/app/data/mission-control-tokens.json
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "/app/healthcheck.js"]
ENTRYPOINT ["/app/docker-entrypoint.sh"]
