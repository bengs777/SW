# Swift AI persistent generation worker host.
# This intentionally runs the BullMQ worker as a dedicated non-Vercel process.

FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache libc6-compat

FROM base AS deps
COPY package*.json ./
COPY prisma ./prisma
RUN mkdir -p scripts
COPY scripts/prisma-generate.js ./scripts/prisma-generate.js
RUN npm ci

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV SWIFT_GENERATION_EXECUTION_MODE=queue
ENV SWIFT_DISABLE_SERVERLESS_GENERATION_FALLBACK=true
ENV PORT=4000

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/app ./app
COPY --from=builder /app/auth.ts ./auth.ts
COPY --from=builder /app/components ./components
COPY --from=builder /app/component-registry ./component-registry
COPY --from=builder /app/hooks ./hooks
COPY --from=builder /app/lib ./lib
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/styles ./styles
COPY --from=builder /app/templates ./templates
COPY --from=builder /app/types ./types
COPY --from=builder /app/workers ./workers
COPY --from=builder /app/next-auth.d.ts ./next-auth.d.ts
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/next.config.js ./next.config.js

EXPOSE 4000
CMD ["npm", "run", "worker:generation"]
