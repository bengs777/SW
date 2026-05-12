# Swift AI Standalone Workers
# This Dockerfile builds the worker process for Railway/Fly.io deployment
# Run with: docker build -t swift-workers -f workers/Dockerfile .
# Then: docker run -e REDIS_URL=xxx -e DATABASE_URL=xxx -e TURSO_AUTH_TOKEN=xxx swift-workers

FROM node:20-alpine AS base
RUN apk add --no-cache libc6-compat git

FROM base AS builder
WORKDIR /app
COPY package*.json ./
COPY tsconfig.json ./tsconfig.json
COPY prisma ./prisma
COPY lib ./lib
COPY workers ./workers
RUN npm ci
RUN npx tsc --project tsconfig.json --outDir /app/dist --module commonjs --moduleResolution bundler --target ES2022 --esModuleInterop --skipLibCheck --forceConsistentCasingInFileNames --resolveJsonModule workers/index.ts workers/redis.ts workers/queue.ts workers/generation-worker.ts workers/repair-worker.ts workers/sandbox-worker.ts workers/graceful-shutdown.ts

FROM node:20-alpine AS runner
WORKDIR /app

# Copy production dependencies
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./
COPY prisma ./prisma

# Create non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs
USER nextjs

EXPOSE 4000

ENV NODE_ENV=production
ENV SWIFT_WORKER_TYPE=generation

CMD ["node", "dist/workers/index.js"]