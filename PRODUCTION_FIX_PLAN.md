# PRODUCTION FIX PLAN — Swift AI

> Dokumen ini adalah rencana pelaksanaan perbaikan komersial Swift AI (pengganti `fixing.md`).
> Dibuat: 2 Okt 2026. Status gate terakhir: **typecheck 0 error, lint 0 error, build exit 0,
> audit:production 56/56, demo:readiness READY_FOR_DEMO, 16 test gate LULUS.**

---

## 1. Ringkasan eksekutif

Repo ini sedang bermigrasi **separuh jalan** dari Prisma/PostgreSQL ke Drizzle/libsql (Turso) dan
dari NextAuth ke Clerk. Runtime utama sudah pindah, tetapi skrip operasi, health-check, test, dan
dokumen produksi masih menunjuk Prisma/Postgres/NextAuth. Karena `@prisma/client` tidak lagi
terpasang, setiap sisa referensi itu berujung `MODULE_NOT_FOUND` atau degradasi senyap.

Temuan P0 (blokir build/deploy) dan P1 (celah uang, gate mati) sudah diperbaiki dan diverifikasi
pada sesi ini. Sisa pekerjaan P1–P3 tertuang di bagian 5.

---

## 2. Katalog error: kenapa terjadi (akar penyebab)

### A. Akar utama — migrasi separuh (Prisma → Drizzle)

| # | Gejala | Akar penyebab | Bukti |
|---|--------|---------------|-------|
| A1 | `Cannot find module '@prisma/client'` saat worker boot (P0) | `schema-health` lama masih Prisma; dijalankan `workers/index.ts:64` | `scripts/schema-health-check.js`, `lib/db/schema-health.ts` (kini ditulis ulang) |
| A2 | Semua `db:*` / `drizzle-kit` gagal | `drizzle.config.ts` tidak pernah dibuat | kini ada, `drizzle-kit check` OK |
| A3 | Deploy tidak pernah apply skema | wrapper build lama berasumsi `prisma migrate deploy` | kini `scripts/vercel-build.js` → `scripts/drizzle-migrate.js` (journal-driven) |
| A4 | `npm run real-e2e` / `npm run deploy:gate` CRASH | `scripts/real-e2e.js:3` top-level `require("@prisma/client")` + butuh `DATABASE_URL` postgres | port ke `scripts/real-e2e.ts` (Drizzle/libsql) |
| A5 | `npm run metrics:generation` CRASH | `scripts/generation-metrics-report.js:2` | port ke libsql/SQL statis |
| A6 | `npm run audit:fullstack --history` CRASH | `scripts/audit_fullstack_generation.js:66` + tolak non-postgres | port mode history ke libsql |
| A7 | `deploy:readiness` kehilangan cek heartbeat DB **senyap** | `scripts/deploy-readiness.js:173` dibungkus `try→catch→return []` | ganti dengan libsql + `console.warn` eksplisit |
| A8 | Test regression/hardening/queue gagal | assertion idiom Prisma/NextAuth, padahal kode sudah Drizzle/Clerk; 1 regex pecah karena CRLF Windows | sudah di-port, exit 0 |
| A9 | `test:chaos` gagal | `scripts/chaos-concurrency.js` Prisma + butuh PostgreSQL + `pg_advisory_xact_lock` (tidak ada di SQLite) | port penuh ke `scripts/chaos-concurrency.ts` |

### B. Build gagal (exit 1)

- `.env.local` berisi `OPENROUTER_FALLBACK_MODELS=<nilai>`.
- Saat `next build` (NODE_ENV=production): `getOpenRouterModelChain()` → `assertProductionModelConfig()`
  (`lib/ai/openrouter-config.ts:88`) → cek `DEPRECATED_MODEL_ENV_KEYS` (baris 19-25) → **throw baris 53-57**
  di rute `/api/generate/estimate`.
- Perbaikan: key deprecated dihapus dari `.env.local`; variatif resmi: `OPENROUTER_MODEL` + `SWIFT_AI_MODEL_CHAIN`.

### C. Celah uang (race condition billing)

- `BillingService.finalizeTopUpOrder` (lama): baca `order.status === "paid"` lalu kredit saldo tanpa
  syarat → dua webhook Pakasir bersamaan = **saldo masuk 2×**.
- Perbaikan: **claim kondisional** `UPDATE top_up_orders SET status='paid' ... WHERE reference=? AND status!='paid' RETURNING`;
  baris klaim yang menang lanjut kredit, yang kalah return `alreadyProcessed: true`. Berlaku untuk
  kedua cabang (top-up dan langganan), claim dilakukan **sebelum** efek samping.

### D. Observability palsu

- `lib/db/client.ts` (wrapper) menimpa implementasi dengan stub
  `{activeConnections:0, ..., error:"Not implemented for Drizzle"}` → `/api/health` dan
  `/api/production/monitoring` selalu melaporkan nol. Kini di-re-export dari `src/lib/db/client.ts`
  (menyediakan `activeConnections`, `maxConnections`, `poolUsage`, `usagePct`).

### E. Celah produk mode ask/review

- Sebelumnya semua mode (termasuk `ask`/`review`) masuk `POST /api/generate/jobs|direct` →
  **job pembuatan dibuat & dibilling** untuk sekadar tanya-jawab.
- Perbaikan: guard `!isMutatingCollaborationMode(...)` → **409 `collaboration_mode_not_generating`**
  sebelum reservasi billing; jalur baru `POST /api/ai/answer` (auth + flag `ENABLE_AI_CHAT` +
  rate limit + zod, tanpa billing); UX di `components/editor/chat-panel.tsx` menampilkan label
  "Tanya AI"/"Mulai review", placeholder khusus, dan menyembunyikan estimasi biaya di mode non-generate.

### F. Dokumen/gate

- `ops.vps-production-runbook` gagal (55/56): `planproduction.md` hanya ada di worktree
  `.kilo/worktrees/paint-zircon/`. Kini disalin ke repo utama → audit **56/56**.
- Empat dokumen produksi lain masih hanya di worktree → dipindahkan ke repo utama (Fase 4).

---

## 3. Perbaikan yang sudah dieksekusi & diverifikasi (sesi ini)

| # | Perbaikan | File | Verifikasi |
|---|-----------|------|-----------|
| 1 | Blokir build dibuka | `.env.local` (hapus `OPENROUTER_FALLBACK_MODELS`) | `npm run build` exit 0 |
| 2 | Konfigurasi drizzle-kit | `drizzle.config.ts` | `npx drizzle-kit check` fine |
| 3 | Migrator journal-driven + klasifikasi error | `scripts/drizzle-migrate.js` | `status=ok tables=28` |
| 4 | Wrapper build: migrate → schema-health → next build | `scripts/vercel-build.js` | build exit 0 |
| 5 | Schema-health tanpa Prisma | `scripts/schema-health-check.js`, `lib/db/schema-health.ts` | `schema:health` exit 0 |
| 6 | Env loader untuk skrip TS | `scripts/run-ts-script.js` | test recovery/crash pass |
| 7 | Tabel migrasi idempoten | `create-migrations-table.js` | rerun aman |
| 8 | Guard 409 ask/review sebelum billing | `app/api/generate/jobs/route.ts`, `app/api/generate/direct/route.ts` | typecheck/lint/build |
| 9 | Endpoint chat bebas billing | `app/api/ai/answer/route.ts`, `app/dashboard/project/[id]/page.tsx` (`sendChatAnswer`) | typecheck/build |
| 10 | Hint UX mode ask/review | `components/editor/chat-panel.tsx` | typecheck/lint/build |
| 11 | Klaim idempoten top-up (anti double-credit) | `lib/services/billing.service.ts` (`finalizeTopUpOrder`) | typecheck/lint |
| 12 | Pool usage jujur | `lib/db/client.ts`, `src/lib/db/client.ts` | typecheck |
| 13 | Test di-port (regression, hardening, queue) + allowlist `next-auth` | `scripts/regression-tests.js`, `scripts/pipeline-hardening-regression.js`, `scripts/queue-reconciliation-regression.ts`, `lib/ai/generation-pipeline.ts` | exit 0 |
| 14 | `test:chaos` di-port penuh (50 duplikat → 1 reservation, refund tunggal, rollback, stale-guard) | `scripts/chaos-concurrency.ts` + wrapper `.js` | exit 0 |
| 15 | Runbook VPS di repo utama | `planproduction.md` | `audit:production` 56/56 |

---

## 4. Keputusan produk (terkunci)

1. Mode **ask/review tidak pernah membuat job generate** → 409 sebelum billing.
2. **Tidak ada auto-routing** antar model; rantai model dikonfigurasi eksplisit
   (`OPENROUTER_MODEL` + `SWIFT_AI_MODEL_CHAIN`).
3. Kepuasan AI (ask/review) **gratis** + rate limit: flag `ENABLE_AI_CHAT` (default true),
   limit per menit (`AI_RATE_LIMIT_PER_MINUTE`, default 12) + limit harian.
4. Billing generate: gratis harian 3× user free (`FREE_GENERATE_LIMIT_PER_DAY`), paid harian 500,
   per-jam 60; reservi saldo kondisional `balance >= cost`.
5. Rate limit route mutasi user memakai `enforceRouteRateLimit` (default 30/menit, 300/jam);
   webhook Pakasir mengandalkan **signature + IP + API-confirmation**, bukan rate limit.

---

## 5. Sisa pekerjaan (plan pelaksanaan)

### Fase 1 — P0: gerbang deploy
- [ ] Port `scripts/real-e2e.js` → `scripts/real-e2e.ts` (Drizzle/libsql, cleanup di `finally`,
      tetap panggil `npm run runtime-smoke`). Wrapper `.js` dipertahankan agar
      `real-e2e` & `deploy:gate` tetap jalan.
- [ ] `scripts/deploy-readiness.js`: ganti blok Prisma (baris ±171-218) dengan libsql + SQL statis
      ke `worker_heartbeats` (kolom `heartbeat_at` = unix **detik**), dan **jangan `return []` senyap** —
      `console.warn` bila pemeriksaan gagal.

### Fase 2 — P1: sisa skrip Prisma
- [ ] Port `scripts/generation-metrics-report.js` → libsql/SQL statis.
- [ ] Port mode `--history` `scripts/audit_fullstack_generation.js` → libsql (hapus syarat postgres).
- [ ] Hapus skrip yatim: `scripts/apply_preview_heuristics.js`, `scripts/inspect_generation_histories.js`.
- [ ] Setelah grep `require('@prisma/client')|from "@prisma/client"` di `scripts/` = 0,
      buang `prisma ^5.22.0` dari devDependencies (scaffold app user tetap boleh pakai
      `@prisma/client` — konteks berbeda).

### Fase 3 — P1: rate limit route mutasi user (8 → ≥ 20 route)
- [ ] Terapkan `enforceRouteRateLimit` + jawab 429 di: `generate/estimate`,
      `generate/jobs/[jobId]/{cancel,draft,stream}`, `projects` (POST), `projects/[id]`,
      `projects/[id]/{deploy,domain,github,export,sandbox,validate-preview}`, `workspaces` (POST),
      `workspaces/[id]/members`, `api-keys`, `api-keys/[id]`, `templates`, `templates/[id]`,
      `crypto/checkout`.
- [ ] **Lewati**: webhook (signature), `health|metrics|production/monitoring|system/*|
      worker/health|provider*` (monitoring), `admin/*` (gate admin), `auth/[...clerk]`.

### Fase 4 — P1: legal & dokumen
- [ ] Halaman `app/refund/page.tsx` (pola `app/privacy/page.tsx`) + tautan di footer.
- [ ] Pindahkan dari `.kilo/worktrees/paint-zircon/` ke repo utama: `PRODUCTION_STATUS.md`,
      `DEPLOYMENT_STATUS_DASHBOARD.md`, `START_HERE_DEPLOYMENT.md`, `DEPLOYMENT_STEP_BY_STEP.md`
      (saring klaim basi; langkah Prisma yang sudah tak berlaku ditandai/dihapus).

### Fase 5 — P2
- [ ] `scripts/chaos-concurrency.ts` `cleanup()`: jangan telan error `rmSync` (warn + retry) —
      terima `Test-Path .tmp/chaos-concurrency.db` = False setelah `test:chaos`.
- [ ] `fixing.md` #12: `lib/db/client.ts` wajib murni re-export dari `src/lib/db/client.ts`;
      tsconfig `@/*` resolve `./src/*` lalu `./*` disengaja (dicatat di sini).
- [ ] Backlog (tidak dikerjakan sekarang): 49 lint warning lama; route read-only tanpa rate limit.

### Fase 6 — Verifikasi final & commit
- [ ] Jalankan: `typecheck`, `lint`, `build`, `schema:health`, `deploy:preflight`,
      `audit:production`, `demo:readiness`, 16 test gate, `deploy:readiness`, `real-e2e`,
      `metrics:generation`, `audit:fullstack` → semua exit 0.
- [ ] Kelompokkan commit (155+ perubahan belum di-commit):
      1. `fix(build)` blokir build + env deprecated
      2. `feat(db)` drizzle config, migrator, schema-health, vercel-build
      3. `fix(test)` port regression/hardening/queue/chaos ke Drizzle
      4. `feat(ai)` guard ask/review + `/api/ai/answer` + hint UX
      5. `fix(billing)` klaim idempoten top-up + pool usage jujur
      6. `chore(deploy)` port real-e2e/deploy-readiness/metrics/audit + hapus yatim
      7. `feat(security)` rate limit mutasi user + halaman refund
      8. `docs` dokumen ini + konsolidasi dokumen worktree
- [ ] Setelah commit: jalur VPS sesuai `planproduction.md`
      (`npm run deploy:readiness` → `pm2 restart swift-generation-worker` → cek `/worker/health`).

---

## 6. Kriteria penerimaan (Definition of Done)

Semua harus exit 0 / terpenuhi:

```bash
npm run typecheck
npm run lint                 # 0 error
npm run build
npm run schema:health
npm run deploy:preflight
npm run audit:production      # 56/56
npm run demo:readiness        # READY_FOR_DEMO
npm run test:regression && npm run test:hardening && npm run test:queue-reconciliation
npm run test:recovery && npm run test:worker-crash && npm run test:resilience
npm run test:corpus && npm run test:path-policy && npm run test:orchestration-scope
npm run test:orchestration-mode && npm run test:artifact-schema
npm run test:workspace-builder && npm run test:generation-runtime-contracts
npm run test:chaos
npm run deploy:readiness
npm run real-e2e              # = deploy:gate
npm run metrics:generation
npm run audit:fullstack
```

Kriteria lain:
- Grep `@prisma/client` di `scripts/` = 0.
- `.tmp/chaos-concurrency.db` hilang setelah `test:chaos`.
- Route mutasi user ber-rate-limit ≥ 20 (webhook tetap signature-based).
- `/refund` ada dan tersambung dari footer; 5 dokumen produksi berada di repo utama.
- Semua perubahan ter-commit (setelah persetujuan pemilik repo).

---

## 7. Risiko & mitigasi

| Risiko | Mitigasi |
|--------|----------|
| `real-e2e` menulis ke DB target | baris uji dibuat & dihapus dalam `finally`, tag unik `real-e2e-<ts>` |
| `runtime-smoke` butuh Chromium Playwright | `npx playwright install chromium` bila binary hilang |
| Rate limit menghambat user valid | nilai konservatif 30/menit, 300/jam + `Retry-After`/pesan jelas |
| 155+ perubahan belum di-commit | commit bertahap per kelompok (Fase 6) sesegera mungkin |
| Test chaos/e2e menulis DB | DB uji lokal (`.tmp`) + cleanup berulang; jalur production hanya saat deploy gate |

---

## 8. Catatan teknis penting

- **Satu-satunya klien DB runtime**: `src/lib/db/client.ts` (libsql/Turso, wajib
  `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN`, URL harus `libsql://`).
  `lib/db/client.ts` hanya re-export.
- Migrasi Drizzle: `drizzle/0000_spicy_princess_powerful.sql` + `drizzle/meta/_journal.json`;
  pelacakan di tabel `__drizzle_migrations`; baseline ditandai `recorded_baseline` bila tabel sudah ada.
- `heartbeat_at`/kolom `*_at` mode timestamp tersimpan sebagai **unix detik**.
- `.gitignore` memuat baris `fixing*.md` — karena itu dokumen ini memakai nama
  `PRODUCTION_FIX_PLAN.md` (ter-track), bukan `fixing production.md`.
