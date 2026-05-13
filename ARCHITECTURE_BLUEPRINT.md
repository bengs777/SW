# Swift AI Production Architecture Blueprint

## Executive Summary

This document details the architectural transformation of Swift AI from a monolithic prototype into a hardened, production-grade, distributed AI builder platform. The core transformation involves decoupling compute-intensive operations from the Next.js runtime, implementing proper state machines, and establishing clear boundaries between components.

---

## 1. Architecture Overview

### 1.1 Target Stack

```
┌─────────────────────────────────────────────────────────────────┐
│                         VERCEL (Frontend)                        │
│                      Next.js 16 App Router                       │
│                 Runtime: nodejs, Edge middleware                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     TURSO (LibSQL) Database                      │
│                  - Prisma Client (connection pool)               │
│                  - Metadata, jobs, projects, users               │
│                  - NO large blobs or file content                │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      SUPABASE STORAGE                            │
│                 - Generated source files (per version)         │
│                 - Preview bundles & build artifacts            │
│                 - Exports, templates, attachments              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     BULLMQ + UPSTASH REDIS                      │
│            - generationQueue (primary job queue)               │
│            - repairQueue (targeted fix queue)                  │
│            - sandboxQueue (runtime state management)           │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│              STANDALONE WORKERS (Railway/Fly.io)                │
│                                                                 │
│ ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐ │
│ │ GenerationWorker│  │  RepairWorker   │  │  SandboxWorker  │ │
│ │ - DeepSeek V3.2 │  │ - Claude Sonnet │  │ - Runtime mgr   │ │
│ │ - File streaming│  │ - Targeted fix  │  │ - Isolation     │ │
│ └─────────────────┘  └─────────────────┘  └─────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 Key Architectural Principles

| Principle | Implementation |
|-----------|----------------|
| **Separation of Concerns** | Workers run as standalone Node.js processes, not inside Next.js |
| **Transactional Integrity** | AI calls NEVER inside `prisma.$transaction()`. Only metadata writes. |
| **Circuit Breakers** | Provider timeouts with `AbortController`, exponential backoff |
| **Idempotency** | Job locking via `projectId + generationId` composite key |
| **Observability** | Structured logging with correlation IDs, metrics export |

---

## 2. Implementation Roadmap

### Phase 1: Foundation & Queue Layer

#### Files to Create/Modify:

**CREATE: `/lib/queue/index.ts`** (Centralized Queue Factory)
```typescript
// Single source of truth for all BullMQ queues
export const generationQueue = new Queue("swift:generation:v2", { connection })
export const repairQueue = new Queue("swift:repair:v1", { connection })
export const sandboxQueue = new Queue("swift:sandbox:v1", { connection })
```

**MODIFY: `next.config.js`** (Already done - webpack externals)
```javascript
experimental: {
  serverComponentsExternalPackages: ['bullmq', 'ioredis'],
}
```

**CREATE: `/workers/` directory structure**
```
/workers
  ├── index.ts              # Worker entry point
  ├── generation-worker.ts  # Standalone generation worker
  ├── repair-worker.ts      # Standalone repair worker
  ├── sandbox-worker.ts     # Standalone sandbox worker
  ├── redis.ts              # Centralized Redis connection
  └── graceful-shutdown.ts  # SIGTERM/SIGINT handlers
```

### Phase 2: Transactional Integrity

#### Files to Modify:

**MODIFY: `lib/services/generation-orchestrator.service.ts`**
- Remove AI calls from transaction blocks
- Implement artifact buffering pattern:
  1. Generate files in memory
  2. Validate and repair
  3. THEN commit to database and storage

**CREATE: `lib/storage/supabase-storage.ts`**
```typescript
// Store pointers in PostgreSQL, blobs in Supabase
async function storeProjectFiles(
  projectId: string,
  files: GeneratedFile[],
): Promise<StorageResult> {
  const storageKey = `projects/${projectId}/${timestamp}/`
  await supabase.storage.from('swift-source').uploadMany(
    files.map(f => ({
      path: `${storageKey}${f.path}`,
      content: f.content,
    }))
  )
  return storageKey
}
```

### Phase 3: Context Optimization Engine

#### Files to Create:

**CREATE: `lib/ai/context-budget.ts`**
```typescript
export type ContextBudget = {
  maxFiles: number        // Default: 8-10 files
  maxCharsPerFile: number // Default: 8KB
  maxTotalChars: number   // Default: 64KB
  usedFiles: number
  usedChars: number
}

export function calculateContextBudget(prompt: string): ContextBudget {
  // Dynamic budget based on prompt complexity
}
```

**CREATE: `lib/ai/file-ranker.ts`**
```typescript
// Ranking algorithm for file relevance
export function rankFilesByRelevance(
  files: GeneratedFile[],
  prompt: string,
  failingFile?: string,
  stackTrace?: string,
): RankedFile[]
```

### Phase 4: State Machine Implementation

#### Files to Create:

**CREATE: `lib/queue/state-machine.ts`**
```typescript
export type GenerationState = 
  | "queued" 
  | "generating" 
  | "parsing" 
  | "validating" 
  | "saving" 
  | "compiling" 
  | "repairing" 
  | "completed" 
  | "failed"

export class GenerationStateMachine {
  private state: GenerationState = "queued"
  private transitions: Record<GenerationState, GenerationState[]> = {
    queued: ["generating", "failed"],
    generating: ["parsing", "failed"],
    parsing: ["validating", "repairing"],
    // ... etc
  }
}
```

---

## 3. Lifecycle Blueprints

### 3.1 Worker Lifecycle

```
┌─────────────┐     ┌─────────────┐     ┌──────────────┐
│   Startup   │────▶│  Connect    │────▶│  Register    │
│  (Node.js)  │     │   Redis     │     │  Signal      │
└─────────────┘     │   (global)  │     │ Handlers     │
                    └─────────────┘     └──────────────┘
                          │                    │
                          ▼                    ▼
                    ┌─────────────┐     ┌──────────────┐
                    │ Listen for  │────▶│  Process     │
                    │    Jobs     │     │   Events     │
                    └─────────────┘     └──────────────┘
                          │                    │
                          ▼                    ▼
                    ┌─────────────┐     ┌──────────────┐
                    │  Release    │◀───▶│   Handle     │
                    │   Lock      │     │  Retries     │
                    └─────────────┘     └──────────────┘
```

### 3.2 Generation Flow

```
User Request
     │
     ▼
[API Route: POST /api/generate/jobs]
     │  - Validate auth
     │  - Create job in DB (outside transaction)
     │  - Enqueue to BullMQ
     │  - Return 202 Accepted
     ▼
[BullMQ: generationQueue]
     │  - Job picked up by Worker
     │  - Load project files from Supabase
     │  - Build context (sliced, not full)
     │  - Call AI provider (with timeout)
     │  - Stream results, buffer in memory
     │  - Commit to Supabase (single transaction)
     │  - Update PostgreSQL (storage pointer)
     │  - Start sandbox preview
     ▼
[Response to Client via SSE]
```

### 3.3 Redis Connection Pattern (Singleton)

```typescript
// lib/workers/redis.ts
const globalForRedis = globalThis as unknown as { redis?: IORedis }

export function getRedis(): IORedis {
  if (globalForRedis.redis?.status === "ready") {
    return globalForRedis.redis
  }

  const redis = new IORedis(process.env.REDIS_URL!, {
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
    lazyConnect: true,
  })

  globalForRedis.redis = redis
  return redis
}
```

---

## 4. Deployment Strategy

### 4.1 Vercel (Frontend + API)

**Environment Variables Required:**
```bash
DATABASE_URL=              # Neon pooled PostgreSQL connection string
DIRECT_DATABASE_URL=       # Neon direct PostgreSQL connection string for migrations
REDIS_URL=                 # Upstash Redis URL
SUPABASE_URL=              # Supabase project URL
SUPABASE_SERVICE_ROLE_KEY= # For server-side uploads
NEXT_RUNTIME=nodejs        # For API routes
```

**Build Configuration:**
```json
// package.json scripts
{
  "build": "node scripts/vercel-build.js",
  "start:worker": "node workers/index.js"
}
```

### 4.2 Railway/Fly.io (Workers)

**Dockerfile:**
```dockerfile
FROM node:20-alpine AS base
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

FROM base AS worker
COPY . .
RUN npm run build
CMD ["node", "workers/index.js"]
```

**Environment (same as Vercel +):**
```bash
SWIFT_ENABLE_GENERATION_WORKER=true
SWIFT_WORKER_TYPE=generation  # or repair, sandbox
```

### 4.3 Supabase Storage Structure

```
/swift-storage
  ├─ /projects/
  │   └─ {projectId}/
  │       ├─ {timestamp}/
  │       │   ├─ src/
  │       │   ├─ public/
  │       │   └─ package.json
  │       └─ latest -> {timestamp}
  ├─ /previews/
  │   └─ {projectId}/
  │       └─ {buildHash}/
  │           └─ .next/
  └─ /exports/
      └─ {projectId}/
          └─ {exportId}/
```

---

## 5. Risk Assessment & Mitigation

### 5.1 Critical Risks

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| **Worker crash during long AI call** | Job loss, user impact | Medium | Use BullMQ repeatable jobs with delay, dead letter queue |
| **Redis connection storms** | Queue unavailable | High | Global singleton pattern, connection pooling |
| **Sandbox resource exhaustion** | Platform instability | Medium | Implement container limits, cleanup cron |
| **Prisma transaction timeouts** | Data inconsistency | High | Never run AI inside transactions, use save points |
| **Supabase upload failures** | Build artifacts lost | Low | Retry with exponential backoff, fallback storage |

### 5.2 Monitoring Requirements

**Metrics to Track:**
- Queue depth and latency (p50, p95, p99)
- Redis connection count and error rate
- AI provider latency and token usage
- Sandbox startup time and memory usage
- Repair attempt frequency and success rate

**Alerts:**
- Queue latency > 30s for 5 consecutive minutes
- Redis connection failures > 10/min
- Worker crash rate > 5%/hour
- Sandbox failure rate > 10%

---

## 6. Files to Create/Modify (Detailed)

### New Files (Phase 1):

| Path | Purpose |
|------|---------|
| `/workers/index.ts` | Worker process entry point |
| `/workers/redis.ts` | Redis singleton for workers |
| `/workers/generation-worker.ts` | Standalone generation worker |
| `/workers/repair-worker.ts` | Standalone repair worker |
| `/workers/sandbox-worker.ts` | Standalone sandbox worker |
| `/workers/graceful-shutdown.ts` | Signal handlers |
| `/lib/queue/index.ts` | Queue factory |
| `/lib/queue/state-machine.ts` | Generation state machine |
| `/lib/storage/supabase-storage.ts` | Blob storage manager |
| `/lib/ai/context-budget.ts` | Context optimization |

### Modified Files:

| Path | Changes |
|------|---------|
| `next.config.js` | Already updated with webpack externals |
| `instrumentation.node.ts` | Remove worker start (moved to standalone) |
| `app/api/generate/jobs/route.ts` | Ensure runtime="nodejs", no worker logic |
| `lib/services/generation-orchestrator.service.ts` | Move AI outside transactions |

---

## 7. Verification Checklist

Before production deployment:

- [ ] No BullMQ bundling warnings in build
- [ ] All Prisma operations outside transactions verified
- [ ] Workers start independently from Next.js
- [ ] Supabase storage integration tested
- [ ] Context budgeting implemented (< 64KB per request)
- [ ] Graceful shutdown handlers verified
- [ ] Dead letter queue configured for failed jobs
- [ ] Monitoring dashboards created
