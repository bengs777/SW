# SWIFT AI — Production Architecture

## Overview

SWIFT AI adalah platform AI website/application generation berbasis orchestrated generation pipeline.

Fokus utama platform:

* Reliable AI generation
* Deterministic project scaffolding
* Queue-based execution
* Production-safe orchestration
* Multi-stage validation and repair
* Editable generated applications

SWIFT AI bukan sekadar endpoint AI yang menghasilkan kode.
Arsitektur sistem dirancang sebagai distributed generation platform dengan separation antara:

* API layer
* Queue layer
* Worker layer
* AI orchestration layer
* Validation layer
* Repair/reconcile layer
* Deployment readiness layer

---

# High Level Architecture

```text
┌──────────────────────┐
│      Frontend UI     │
│  Next.js Dashboard   │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│  Generation API      │
│ /api/generate/jobs   │
└──────────┬───────────┘
           │ enqueue
           ▼
┌──────────────────────┐
│     BullMQ Queue     │
│      Redis Queue     │
└──────────┬───────────┘
           │ consume
           ▼
┌──────────────────────┐
│ Dedicated AI Worker  │
│ generation-worker    │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ AI Orchestrator      │
│ Planning + Routing   │
└──────────┬───────────┘
           │
 ┌─────────┼─────────┐
 ▼         ▼         ▼
Planner   Generator  Repair
Agent     Agent      Agent

           ▼
┌──────────────────────┐
│ Validation Pipeline  │
│ lint/type/build      │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ Deploy Ready Output  │
└──────────────────────┘
```

---

# Core Principles

## 1. Queue-First Generation

Production generation tidak dijalankan langsung di serverless request.

Semua generation production wajib:

* masuk queue
* diproses dedicated worker
* durable
* retryable
* observable

Serverless fallback hanya boleh untuk local development atau explicit non-production testing.

---

## 2. Fail Fast Production Policy

SWIFT AI tidak menggunakan silent degradation.

Jika production environment tidak memenuhi syarat:

* worker missing
* Redis eviction policy salah
* provider AI unhealthy
* queue unavailable

maka request generation akan gagal jelas.

Tujuan:

* menghindari false-success
* menghindari hidden instability
* meningkatkan observability
* menjaga reliability generation

---

## 3. Deterministic Foundation

Komponen core project tidak digenerate secara acak oleh AI.

Bagian deterministic:

* project scaffold
* auth structure
* database layer
* routing shell
* deployment config
* Prisma setup
* environment template
* validation pipeline

AI difokuskan pada:

* feature generation
* component logic
* business logic
* page composition
* scoped modifications

---

## 4. Separation Between Full Generation and Patch Mode

SWIFT AI memisahkan:

| Mode            | Purpose                              |
| --------------- | ------------------------------------ |
| Full Generation | Membuat aplikasi/proyek baru         |
| Patch/Edit      | Modifikasi lokal file tertentu       |
| Reconcile       | Memperbaiki inconsistency            |
| Repair          | Memperbaiki build/type/runtime error |

Prompt besar tidak boleh diperlakukan sebagai patch kecil.

---

# Execution Pipeline

## Step 1 — Request Intake

User mengirim prompt generation.

Contoh:

```text
Buat aplikasi marketplace burung dengan admin, seller, pembeli, dan kurir.
```

API layer melakukan:

* auth validation
* quota validation
* payload validation
* intent analysis
* execution mode validation
* readiness checks

Jika production menggunakan serverless generation mode:

request langsung ditolak.

---

## Step 2 — Queue Enqueue

Request valid dimasukkan ke BullMQ queue.

Queue requirements:

* Redis connected
* maxmemory-policy=noeviction
* worker active
* queue writable

Health queue diperlakukan sebagai business critical infrastructure.

---

## Step 3 — Dedicated Worker Execution

Dedicated worker memproses generation.

Worker responsibilities:

* consume jobs
* maintain heartbeat
* manage concurrency
* retry failed tasks
* recover stalled jobs
* isolate orchestration runtime

Worker bukan serverless runtime.

---

## Step 4 — AI Orchestration

Orchestrator bertanggung jawab untuk:

* prompt analysis
* task decomposition
* architecture planning
* scoped generation routing
* repair/reconcile flow
* provider failover

Sistem tidak mengandalkan single giant generation pass.

---

## Step 5 — Validation Pipeline

Setelah generation selesai:

```bash
npm run lint
npm run typecheck
npm run build
npm run runtime-smoke
```

Validation menjadi bagian wajib pipeline.

Project tidak dianggap successful hanya karena AI selesai generate file.

---

## Step 6 — Repair/Reconcile

Jika validation gagal:

* AI repair agent dijalankan
* hanya file relevan diperbaiki
* dependency mismatch direconcile
* import/runtime/type error diperbaiki

Repair loop bersifat targeted.

---

# Infrastructure Architecture

## Frontend Layer

Stack:

* Next.js
* TypeScript
* TailwindCSS
* React Server Components

Responsibilities:

* dashboard UI
* generation monitoring
* project management
* prompt interaction
* deployment status

---

## Queue Layer

Stack:

* BullMQ
* Redis

Requirements:

```env
maxmemory-policy=noeviction
```

Reason:

Queue durability penting untuk:

* active jobs
* retry metadata
* stalled detection
* worker locks
* delayed jobs

---

## Worker Layer

Dedicated persistent runtime.

Recommended environments:

* VPS + PM2
* Docker
* Railway Worker
* ECS/Fargate
* Fly.io Machine

Not recommended:

* Vercel serverless functions

---

## AI Provider Layer

Supports:

* OpenRouter
* OpenAI
* Anthropic
* provider failover

Features:

* provider health scoring
* failover routing
* timeout management
* retry strategy
* degradation detection

---

# Production Safety Rules

## Mandatory Requirements

Production generation hanya boleh aktif jika:

| Requirement              | Status   |
| ------------------------ | -------- |
| Dedicated worker active  | Required |
| Queue mode enabled       | Required |
| Redis noeviction         | Required |
| AI provider healthy      | Required |
| Readiness checks passing | Required |

---

## Disabled In Production

Production tidak boleh:

* auto fallback ke serverless generation
* bypass readiness checks
* enqueue tanpa worker sehat
* menggunakan degraded Redis policy

---

# Observability

SWIFT AI menggunakan explicit health monitoring.

Health endpoints:

| Endpoint           | Purpose               |
| ------------------ | --------------------- |
| /api/worker/health | worker status         |
| /api/health        | application health    |
| deploy readiness   | deployment validation |

Metrics penting:

* worker heartbeat
* queue depth
* failed jobs
* provider failures
* generation duration
* repair retries
* validation failures

---

# Reliability Strategy

SWIFT AI fokus pada:

## 1. Generation Determinism

Mengurangi randomness architecture.

## 2. Constrained Generation

AI bekerja dalam boundary jelas.

## 3. Repairability

Generated project harus bisa diedit dan diperbaiki.

## 4. Retry Safety

Job failure tidak boleh menyebabkan corrupted project.

## 5. Fail Visibility

Error harus terlihat jelas.

---

# Development Philosophy

SWIFT AI tidak mengejar:

```text
"generate semuanya secara magic"
```

Fokus platform:

```text
Reliable generation with production-safe architecture.
```

Tujuan utama:

* generated apps dapat dijalankan
* generated apps dapat diedit
* generation dapat diulang
* infrastructure dapat diobservasi
* failure dapat direcover

---

# Current Direction

Roadmap utama:

## Phase 1 — Infrastructure Reliability

* queue-only production execution
* dedicated workers
* Redis durability
* fail-fast readiness

## Phase 2 — Orchestration Intelligence

* better intent routing
* scaffold vs patch separation
* scoped generation planning
* architecture-aware decomposition

## Phase 3 — Recovery & Repair

* resumable generation
* checkpointing
* atomic workspace promote
* advanced reconcile pipeline

## Phase 4 — Production Hardening

* distributed tracing
* generation replay tooling
* adaptive provider routing
* advanced observability
* benchmark-driven optimization

---

# Vision

SWIFT AI dibangun bukan sebagai demo AI coding biasa.

Target platform:

* reliable AI application generation
* production-safe orchestration
* editable generated applications
* scalable generation infrastructure
* deterministic deployment pipeline

Fokus jangka panjang:

```text
Prompt → Reliable App → Editable Project → Deployable System
```
