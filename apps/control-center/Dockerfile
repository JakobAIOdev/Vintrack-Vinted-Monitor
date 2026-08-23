FROM node:20-slim AS base

# --- Dependencies ---
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    && rm -rf /var/lib/apt/lists/*
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

# --- Builder ---
FROM deps AS builder
WORKDIR /app
COPY . .
ENV NODE_OPTIONS="--max-old-space-size=1536"
ENV NEXT_DISABLE_TURBOPACK=1
ARG NEXT_BUILD_CPUS
ENV NEXT_BUILD_CPUS=$NEXT_BUILD_CPUS
RUN npx prisma generate
RUN --mount=type=cache,target=/app/.next/cache npm run build

# --- Runtime ---
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid=1001 nodejs
RUN useradd --system --uid=1001 --gid nodejs nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/package.json ./package.json
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
CMD ["node", "server.js"]
