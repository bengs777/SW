# Audit Prompting -> Preview -> Deploy Swift AI

Tanggal audit: 2026-06-12

## Ringkasan

Kode lokal alur utama aplikasi dalam kondisi buildable. TypeScript, lint, regression, runtime contracts, dan audit env lulus.

Status live production terbaru: belum siap dipakai semua user sampai dedicated worker VPS direstart/waras lagi. `deploy:readiness` terbaru gagal di `GENERATION_WORKER_HEARTBEAT` karena Redis heartbeat masih menandai worker/job lama yang stalled, dan endpoint worker proxy membalas `503 worker unreachable`.

Update investigasi screenshot 2026-06-12:

- Error di screenshot `Executor hard timeout after 31011ms during operation_11` berasal dari executor TaskGraph generation, bukan dari queue timeout 900 detik.
- Angka `31011ms` cocok dengan fallback/default executor sekitar 30 detik. Ini terlalu pendek untuk prompt full e-commerce multi-file karena patch operations berjalan serial dan ikut menulis lifecycle/DB audit.
- `components/editor/sandbox-preview.tsx` sebelumnya juga punya watchdog preview pendek. Untuk module graph besar, preview bisa timeout sebelum CDN/module loader selesai.
- Runtime health production publik sehat, tetapi internal health dengan bearer token lokal masih tidak membuka detail internal. Artinya `SWIFT_METRICS_TOKEN` yang ada di file lokal belum terbukti tersinkron ke production.
- Worker heartbeat live sehat, tetapi perlu restart/deploy agar heartbeat baru menampilkan metadata timeout non-secret.

Fix kode yang diterapkan:

- `lib/timeouts.ts` sekarang memperlakukan dedicated generation worker/queue mode sebagai production-like executor, sehingga fallback `SWIFT_EXECUTOR_HARD_TIMEOUT_MS` menjadi `120000ms`, bukan `30000ms`.
- `lib/queue/generation-queue.ts` dan `lib/workers/generation-worker.ts` sekarang menyimpan metadata timeout non-secret di heartbeat/runtime info: `generationJobMs`, `executorHardMs`, dan `executorStuckOperationMs`.
- `components/editor/sandbox-preview.tsx` menaikkan boot/runtime watchdog preview menjadi `90000ms` dan mencatat `timeoutMs` di telemetry.
- `scripts/worker-health-smoke.js` tetap memakai public worker proxy dari env/sandbox URL sehingga smoke test tidak default ke localhost.
- `lib/ai/openrouter-config.ts`, `.env`, `.env.vercel`, dan `.env.vps` sekarang tidak memakai `openrouter/free`; fallback diganti ke model NVIDIA eksplisit yang berhasil dites melalui OpenRouter API.
- `scripts/production-env-audit.js`, `scripts/vps-production-bootstrap.sh`, dan docs OpenRouter/launch checklist sudah disamakan dengan chain eksplisit tersebut.

Verifikasi setelah fix screenshot:

```text
npm run typecheck -> PASS
npm run lint -> PASS
npm run test:generation-runtime-contracts -> PASS
npm run test:regression -> PASS
npm run audit:production-env -> PASS
npm run deploy:readiness -> NOT_READY_FOR_DEPLOY: GENERATION_WORKER_HEARTBEAT
```

Catatan: `audit:production` penuh sempat lulus pada audit sebelumnya, tetapi run terbaru timeout di cek eksternal setelah 184 detik. Karena perubahan terakhir hanya preview loader dan dokumen, sinyal blocker utama tetap readiness worker live.

Temuan provider live:

```text
npm run metrics:generation -> 30 sample, 29 failed, mayoritas provider_failed
Recent DB attempts -> primary sering 429/rate_limit; openrouter/free fallback memilih poolside/openrouter owl dan balas 401/auth atau overloaded
OpenRouter model list -> model eksplisit masih ada
Small OpenRouter smoke -> google/gemma-4-31b-it:free dan beberapa NVIDIA fallback balas 200
```

Fix provider:

```env
SWIFT_AI_MODEL_CHAIN=google/gemma-4-31b-it:free,nvidia/nemotron-nano-9b-v2:free,nvidia/nemotron-3-nano-30b-a3b:free,nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free,nvidia/nemotron-3-super-120b-a12b:free,nvidia/nemotron-3-ultra-550b-a55b:free
```

Catatan: selama `SWIFT_AI_FREE_MODE=true`, tetap ada risiko 429 karena kuota/free capacity OpenRouter. Untuk benar-benar stabil bagi user berbayar, pakai model/provider paid atau tambah credit OpenRouter.

Catatan live production:

- Perubahan kode belum otomatis aktif untuk user sampai commit/push/deploy dilakukan dan VPS worker/sandbox direstart.
- Setelah deploy/restart, cek `/worker/health` atau dashboard system. Heartbeat seharusnya menunjukkan `timeouts.executorHardMs` minimal `120000`.
- Jika masih muncul `Executor hard timeout after 31xxxms`, berarti worker production masih menjalankan build lama atau `.env` worker tidak terbaca.

Update live 14:59 WIB:

- `https://www.ai-swift.biz.id/api/provider/health` sudah memakai provider chain baru tanpa `openrouter/free`.
- `https://sandbox.ai-swift.biz.id/health` sehat dan storage tersedia.
- `https://sandbox.ai-swift.biz.id/worker/health` masih `503` dengan status `worker: unreachable`.
- `npm run deploy:readiness` gagal di `GENERATION_WORKER_HEARTBEAT`: `stalled_generation_detected` dan `heartbeat_active_jobs_without_queue_active_jobs`.
- Kesimpulan: code/app/provider sudah lebih baik, tetapi VPS worker perlu pull kode terbaru, sync `.env`, restart PM2, lalu bersihkan/replay job stalled jika masih tersisa.

Langkah fix operasional di VPS:

```bash
cd /root/swift-runtime
git pull origin main
npm ci
npx prisma generate
pm2 restart swift-generation-worker --update-env
pm2 restart swift-sandbox --update-env
pm2 save
npm run worker:health
npm run deploy:readiness
```

Jika `deploy:readiness` masih gagal dengan `stalled_generation_detected`, cek log worker dan DLQ:

```bash
pm2 logs swift-generation-worker --lines 200
npm run metrics:generation
```

Jangan lanjut push/deploy project user dari dashboard sebelum `deploy:readiness` kembali `READY_FOR_DEPLOY`.

Update investigasi screenshot 14:44 WIB:

- Project `cmq672gu3000112to1k3yj3xj` belum punya `ProjectFile` resmi dan belum punya `GenerationHistory` sukses.
- UI menampilkan `generation_draft` artifact terbaru `cmqam92cr0i5mp9d67cf51imf` dengan 18 file, status masih `draft`.
- Job terbaru `cmqam8y6z00035vfg6n4hhvs5` gagal dengan `SWIFT_AI_PROVIDER_FAILOVER_EXHAUSTED`.
- Provider attempts job tersebut masih jatuh ke `poolside/laguna-m.1:free`, `openrouter/owl-alpha`, dan `poolside/laguna-xs.2:free`; ini tanda worker production masih memakai chain lama `openrouter/free` atau belum restart dengan `.env` baru.
- Preview timeout `90000ms` menunjukkan patch timeout preview sudah aktif, tetapi runtime preview masih bisa hang jika CDN compiler Babel/Tailwind lambat.

Fix tambahan:

- `components/editor/sandbox-preview.tsx` sekarang tidak lagi memuat Babel sebagai blocking script di `<head>`.
- Tailwind CDN dibuat `defer`.
- Loader Babel dinamis diberi timeout 8 detik per CDN dan fallback ke jsdelivr, supaya preview tidak menunggu 90 detik hanya karena CDN compiler lambat.

Update perbaikan 2026-06-12:

- `scripts/worker-health-smoke.js` sekarang otomatis memakai `SANDBOX_PUBLIC_BASE_URL/worker/health` jika `SWIFT_WORKER_HEALTH_URL` belum diset.
- `.env`, `.env.vercel`, dan `.env.vps` sudah disinkronkan ke timeout generation efektif `900000ms`.
- `.env`, `.env.vercel`, dan `.env.vps` sudah ditambah `SWIFT_WORKER_HEALTH_URL`.
- `.env`, `.env.vercel`, dan `.env.vps` sudah ditambah `SWIFT_METRICS_TOKEN` random baru. Nilai token tidak ditulis di laporan ini.
- `npm run worker:health` sudah lulus dan membaca endpoint `https://sandbox.ai-swift.biz.id/worker/health` dari env project.

Error yang benar-benar muncul saat audit bukan compile/runtime fatal di pipeline prompt. Titik masalahnya ada di operasional:

1. `npm run worker:health` sebelumnya gagal jika tidak diberi `SWIFT_WORKER_HEALTH_URL`, karena default-nya cek `http://127.0.0.1:4000/health` dan worker lokal tidak sedang berjalan.
2. `npm run audit:production` dan `npm run demo:readiness` butuh timeout lebih panjang dari 120 detik karena gate ini menjalankan full build.
3. `SWIFT_METRICS_TOKEN` dan `SWIFT_WORKER_HEALTH_URL` sebelumnya belum diset di env deploy-readiness, jadi observability masih degraded/recommended warning.
4. Env timeout sebelumnya `AI_QUEUE_TIMEOUT_MS=500000`, `SWIFT_GENERATION_JOB_TIMEOUT_MS=500000`, dan `SWIFT_STALE_GENERATION_TIMEOUT_MS=500000` secara efektif diabaikan oleh kode karena minimum runtime dikunci `900000ms`.
5. Secret production terlihat di `.env.vps`/chat. Walaupun `.gitignore` sudah aman, token/key yang pernah terekspos sebaiknya dirotasi.

## Alur Yang Diaudit

1. User mengirim prompt dari editor.
   - UI membuat `previewContext`, `idempotencyKey`, attachments, bahasa prompt, dan collaboration mode.
   - File: `app/dashboard/project/[id]/page.tsx`

2. API membuat job generation.
   - Endpoint: `POST /api/generate/jobs`
   - Validasi Zod, auth, project access, billing reservation, idempotency, queue decision.
   - File: `app/api/generate/jobs/route.ts`

3. Job masuk Redis/BullMQ.
   - Queue: `swift-generation-v2`
   - Health memakai Redis ping, backlog, saturation, dead-letter queue, dan worker heartbeat.
   - File: `lib/queue/generation-queue.ts`

4. Dedicated worker menjalankan orchestrator.
   - Worker ambil lease, jalankan generation, validasi, persist, refund jika gagal/timeout.
   - File: `lib/workers/generation-worker.ts`

5. File masuk editor dan preview.
   - Draft bisa muncul lebih dulu di Monaco.
   - Snapshot resmi menunggu persist dan sandbox/runtime validation.
   - Browser preview punya iframe sandbox dan timeout 45 detik.
   - File: `components/editor/sandbox-preview.tsx`

6. Preview runtime/sandbox siap.
   - Sandbox service public sehat di `https://sandbox.ai-swift.biz.id/health`.
   - Worker proxy public sehat di `https://sandbox.ai-swift.biz.id/worker/health`.

7. Deploy Vercel.
   - UI menolak deploy jika file masih status `draft`.
   - API deploy membuat payload Next.js minimal, guard ukuran file, lalu call Vercel deployment API.
   - File: `app/api/projects/[id]/deploy/route.ts`

## Bukti Audit

Command yang lulus:

```text
npm run typecheck
npm run lint
npm run build
npm run runtime-smoke
npm run deploy:preflight
npm run deploy:readiness
npm run audit:production
npm run demo:readiness
npm run test:artifact-schema
npm run test:generation-runtime-contracts
npm run test:path-policy
npm run test:workspace-builder
npm run test:hardening
npm run test:resilience
npm run test:queue-reconciliation
npm run test:recovery
npm run test:orchestration-mode
```

Live endpoint yang sehat:

```text
https://www.ai-swift.biz.id/api/health -> 200 healthy
https://www.ai-swift.biz.id/api/provider/health -> 200 healthy
https://sandbox.ai-swift.biz.id/health -> 200 healthy
https://sandbox.ai-swift.biz.id/worker/health -> 200 healthy
```

Command yang sebelumnya gagal tanpa env tambahan:

```text
npm run worker:health
Error: connect ECONNREFUSED 127.0.0.1:4000
```

Command yang sama lulus jika endpoint worker production diberikan. Setelah update script/env, command ini seharusnya lulus langsung selama `.env` memuat `SANDBOX_PUBLIC_BASE_URL` atau `SWIFT_WORKER_HEALTH_URL`.

```powershell
$env:SWIFT_WORKER_HEALTH_URL="https://sandbox.ai-swift.biz.id/worker/health"
npm run worker:health
```

## Letak Error Dan Fix

### 1. Worker health smoke default ke localhost

Letak:

```text
scripts/worker-health-smoke.js
workers/index.ts
ecosystem.config.cjs
```

Gejala:

```text
ECONNREFUSED 127.0.0.1:4000
```

Penyebab:

Script smoke sebelumnya memakai default `http://127.0.0.1:4000/health`. Di laptop ini worker health server lokal tidak berjalan, jadi smoke gagal. Production worker sebenarnya sehat melalui Redis heartbeat dan public proxy.

Fix:

```env
SWIFT_WORKER_HEALTH_URL=https://sandbox.ai-swift.biz.id/worker/health
```

Tambahkan ke `.env.vercel` dan `.env.vps`, lalu restart/redeploy. Untuk test lokal sementara:

```powershell
$env:SWIFT_WORKER_HEALTH_URL="https://sandbox.ai-swift.biz.id/worker/health"
npm run worker:health
```

Atau jalankan worker lokal:

```powershell
$env:SWIFT_WORKER_HEALTH_PORT="4000"
npm run worker:generation
```

Catatan: jika `.env` lokal masih memakai DB/Redis production, menjalankan worker lokal akan menyentuh production queue.

Status: sudah diterapkan di `.env`, `.env.vercel`, `.env.vps`, dan fallback script sudah diperbaiki. Script juga sudah membaca `.env` lewat `@next/env`.

### 2. Observability token belum diset

Letak:

```text
app/api/worker/health/route.ts
lib/production/readiness.ts
scripts/deploy-readiness.js
```

Gejala:

```text
/api/worker/health -> 401 Unauthorized tanpa token/login developer
deploy:readiness -> WARN SWIFT_METRICS_TOKEN
```

Penyebab:

Endpoint internal memang diproteksi. Tanpa `SWIFT_METRICS_TOKEN`, health scraping eksternal harus login developer atau akan 401.

Fix:

```env
SWIFT_METRICS_TOKEN=<random-32+-chars>
SWIFT_WORKER_HEALTH_URL=https://sandbox.ai-swift.biz.id/worker/health
```

Set di Vercel Production dan VPS env, lalu verifikasi:

```powershell
npm run deploy:readiness
```

Status: token random sudah ditambahkan ke `.env`, `.env.vercel`, dan `.env.vps`. Jika env production di Vercel/VPS tidak otomatis tersinkron dari file ini, push/sync env ke platform lalu redeploy/restart.

### 3. Timeout command audit terlalu pendek

Letak:

```text
scripts/production-audit.js
scripts/demo-readiness.js
scripts/vercel-build.js
```

Gejala:

```text
npm run audit:production timeout di sekitar 124 detik
npm run demo:readiness timeout jika dibatasi 120 detik
```

Penyebab:

`audit:production` menjalankan `lint`, `typecheck`, dan full `build`. Build sendiri butuh sekitar 155 detik di mesin ini. Full production audit butuh sekitar 219 detik. Demo readiness butuh sekitar 207 detik.

Fix:

Gunakan timeout minimal:

```text
audit:production: 360 detik
demo:readiness: 300 detik
build: 300 detik
```

Jika dipakai di CI, pisahkan gate:

```powershell
npm run typecheck
npm run lint
npm run deploy:preflight
npm run build
npm run audit:production
```

### 4. Timeout generation env tidak sesuai kode

Letak:

```text
lib/timeouts.ts
lib/env.ts
lib/workers/generation-worker.ts
app/dashboard/project/[id]/page.tsx
```

Gejala:

Env berisi `500000ms`, tetapi runtime minimum dikunci `900000ms`.

Bukti kode:

```text
MIN_GENERATION_JOB_TIMEOUT_MS = 900_000
aiQueueTimeoutMs = Math.max(900_000, ...)
```

Penyebab:

Nilai `AI_QUEUE_TIMEOUT_MS`, `SWIFT_GENERATION_JOB_TIMEOUT_MS`, dan `SWIFT_STALE_GENERATION_TIMEOUT_MS` di bawah 900 detik tidak efektif.

Fix aman:

Samakan env dengan runtime aktual supaya operator tidak salah baca:

```env
AI_QUEUE_TIMEOUT_MS=900000
SWIFT_GENERATION_JOB_TIMEOUT_MS=900000
SWIFT_STALE_GENERATION_TIMEOUT_MS=900000
```

Jika memang ingin batas 500 detik, ubah kode minimum di `lib/timeouts.ts` dan audit semua UI/client timeout yang bergantung ke angka itu.

Status: sudah diterapkan di `.env`, `.env.vercel`, dan `.env.vps`.

### 5. Build lokal bisa menyentuh database production

Letak:

```text
scripts/vercel-build.js
.env
```

Gejala:

Saat `npm run build`, wrapper menjalankan:

```text
npx prisma generate
npx prisma migrate deploy
node scripts/schema-health-check.js
npx next build --webpack
```

Penyebab:

`scripts/vercel-build.js` memuat `.env`. Jika `.env` lokal berisi production Neon URL, local build akan melakukan migrate deploy ke database production.

Fix:

Untuk development lokal, pakai `.env` lokal/non-production. Untuk production deploy, jalankan migrasi hanya dari pipeline yang memang ditujukan ke production:

```powershell
npm run deploy:preflight
npm run build
```

Atau gunakan Vercel flow:

```powershell
npx vercel pull --yes --environment=production
npx vercel build --prod
npx vercel deploy --prebuilt --prod
```

### 6. Secret production sudah terekspos

Letak:

```text
.env.vps
.env.vercel
.env
```

Gejala:

Secret/API key production terlihat di IDE/chat. `.gitignore` sudah memblokir `.env*`, tetapi secret yang pernah terekspos tetap dianggap compromised.

Fix:

Rotasi semua secret penting:

```text
NEXTAUTH_SECRET
DATABASE_URL / DIRECT_DATABASE_URL password
OPENROUTER_API_KEY
REDIS_URL password
SANDBOX_SERVICE_TOKEN
SUPABASE_SERVICE_ROLE_KEY
VERPRO_ACCES_TOKEN
PAKASIR_API_KEY
CRYPTO_PAYMENT_PRIVATE_KEY
GOOGLE_CLIENT_SECRET
SWIFT_METRICS_TOKEN
```

Setelah rotasi:

```powershell
npm run audit:production-env
npm run deploy:readiness
npm run deploy:preflight
```

## Status Deploy-Ready

Saat audit ini:

```text
Build: PASS
Typecheck: PASS
Lint: PASS
Runtime smoke: PASS
Schema health: PASS
Prisma migrate status: up to date
Production audit: PASS 56/56
Deploy readiness: READY_FOR_DEPLOY
Demo readiness: READY_FOR_DEMO
App health: healthy
Provider health: healthy
Sandbox health: healthy
Worker proxy health: healthy
```

## Checklist Fix Prioritas

- [ ] Rotasi secret production yang sudah terekspos.
- [x] Tambahkan `SWIFT_METRICS_TOKEN` ke file env lokal/Vercel/VPS.
- [x] Tambahkan `SWIFT_WORKER_HEALTH_URL=https://sandbox.ai-swift.biz.id/worker/health`.
- [x] Samakan timeout env generation ke `900000ms`, atau turunkan minimum timeout di kode secara sadar.
- [ ] Pastikan CI/IDE command timeout minimal 300-360 detik untuk audit/build.
- [ ] Jangan menjalankan `npm run build` lokal dengan `.env` production kecuali memang ingin menyentuh production DB.
- [ ] Setelah env berubah: redeploy Vercel, restart worker/sandbox PM2, lalu jalankan `npm run deploy:readiness`.

## Definition Of Done

Fix dianggap selesai jika:

```text
npm run worker:health
npm run deploy:readiness
npm run deploy:preflight
npm run audit:production
npm run demo:readiness
```

semuanya lulus, dan satu prompt kecil dari UI berhasil sampai:

```text
queued -> running -> persisted -> preview_ready -> completed -> Deploy Vercel
```

tanpa status `draft` tersisa dan tanpa refund otomatis karena timeout.
