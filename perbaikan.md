# Perbaikan Production Readiness Swift AI

Tanggal audit awal: 2026-06-01, timezone Asia/Jakarta.

Status implementasi terakhir: 2026-06-01.

## Status Singkat

Web belum siap production.

Local source code sudah cukup sehat untuk build dan regression, tetapi runtime production masih blocked oleh konfigurasi dan service worker.

## Status Implementasi

Sudah diimplementasikan di repo:

- `scripts/post-deploy-health.js` sekarang gagal untuk redirect, non-2xx, non-JSON, `unhealthy`, `degraded`, worker missing/disabled, dan punya retry config.
- `package.json` menambah `postdeploy:health:prod` untuk canonical domain `https://www.ai-swift.biz.id`.
- `.github/workflows/ci.yml` menambah production health gate setelah push ke `main`.
- `scripts/deploy-readiness.js` sekarang memvalidasi fallback serverless disabled, Supabase service role non-placeholder, Redis `noeviction`, worker heartbeat, dan worker health URL.
- `lib/env.ts` tidak lagi salah menolak Supabase secret key format `sb_secret...`.
- `workers/Dockerfile` sekarang menyalin source runtime yang dibutuhkan worker (`scripts`, `workers`, `lib`, `components`, `auth.ts`, dan pendukung lain).
- `scripts/run-ts-script.js` bisa memuat dependency `.tsx`, bukan hanya `.ts`.
- `scripts/generation-runtime-contracts.js` menambah guard untuk Docker runtime source dan loader `.tsx`.

Masih harus dilakukan di provider:

- Deploy dedicated worker dan set `SWIFT_WORKER_HEALTH_URL`.
- Ubah Redis `maxmemory-policy` ke `noeviction`.
- Redeploy Vercel production dengan source terbaru dan env `SWIFT_GENERATION_EXECUTION_MODE=queue`.

Status utama:

- Local `npm run typecheck`: PASS
- Local `npm run lint`: PASS
- Local `npm run build`: PASS
- Local `npm run test:regression`: PASS
- Local `npm run test:workspace-builder`: PASS
- Local `npm run runtime-smoke`: PASS
- Local `npm run test:generation-runtime-contracts`: PASS
- Local `npm run deploy:readiness`: FAIL, blocker `REDIS_EVICTION_POLICY`, `GENERATION_WORKER_HEARTBEAT`, `SWIFT_WORKER_HEALTH_URL`
- Live `https://www.ai-swift.biz.id/api/health?refreshProvider=true`: HTTP 503, status `unhealthy`
- Live `https://www.ai-swift.biz.id/api/worker/health`: worker `missing`, heartbeat `null`

## Temuan Paling Penting

### 1. Production masih mode serverless, padahal readiness mewajibkan queue worker

Live health menunjukkan:

- `generationExecutionMode`: `serverless`
- `blockingFailures`: `SWIFT_GENERATION_EXECUTION_MODE`
- pesan readiness: production harus memakai queue mode dengan dedicated worker

Kode yang mengunci aturan ini ada di:

- `lib/production/readiness.ts`

Kesimpulan:

- Di Vercel production, set `SWIFT_GENERATION_EXECUTION_MODE=queue`.
- Pastikan `SWIFT_DISABLE_SERVERLESS_GENERATION_FALLBACK=true`.
- Jangan anggap production ready selama live health masih melaporkan `serverless`.

### 2. Dedicated generation worker belum hidup

Local deploy readiness gagal di:

- `GENERATION_WORKER_HEARTBEAT`
- detail: `Worker heartbeat key is missing in Redis. Start the dedicated worker service.`

Live worker health juga menunjukkan:

- `worker`: `missing`
- `heartbeat`: `null`
- queue `degraded`
- dead-letter queue punya 3 job waiting

Kode worker dan deployment sudah tersedia:

- `workers/Dockerfile`
- `railway.worker.json`
- `workers/index.ts`
- `lib/queue/generation-queue.ts`

Yang perlu dilakukan:

1. Deploy worker terpisah, misalnya Railway, memakai `railway.worker.json`.
2. Worker command harus menjalankan `npm run worker:generation`.
3. Worker env minimal harus sama dengan production untuk:
   - `DATABASE_URL`
   - `DIRECT_DATABASE_URL`
   - `REDIS_URL`
   - `OPENROUTER_API_KEY`
   - `NEXTAUTH_SECRET`
   - `SANDBOX_SERVICE_URL`
   - `SANDBOX_SERVICE_TOKEN`
   - Supabase env yang dipakai runtime
4. Pastikan worker expose `/health`.
5. Set Vercel env `SWIFT_WORKER_HEALTH_URL=https://<worker-domain>/health`.

Target:

- `/api/worker/health` mengembalikan HTTP 200
- `worker` menjadi `healthy`
- `heartbeat.ageMs` ada dan kurang dari 90 detik
- `npm run deploy:readiness` menjadi `READY_FOR_DEPLOY`

### 3. Redis policy belum aman untuk BullMQ production

Live worker health menunjukkan Redis:

- `ping`: `PONG`
- `maxmemory-policy`: `volatile-lru`
- target app: `noeviction`
- `evictionPolicyOk`: `false`

Risiko:

- Job BullMQ bisa terhapus oleh Redis eviction.
- Queue bisa terlihat kosong atau gagal secara acak saat tekanan memory naik.

Yang perlu dilakukan:

1. Ubah Redis `maxmemory-policy` ke `noeviction` di provider Redis.
2. Atau aktifkan `SWIFT_REDIS_AUTO_SET_NOEVICTION=true` jika provider mengizinkan `CONFIG SET`.
3. Verifikasi ulang lewat `/api/worker/health`.

Target:

- `redis.memory.evictionPolicyOk=true`
- `evictionPolicy=noeviction`

### 4. Production env Supabase service role invalid menurut validator

Live cold-start health menunjukkan:

- `SUPABASE_SERVICE_ROLE_KEY` severity `error`
- pesan: harus non-placeholder dan minimal 32 karakter

Catatan:

- Local `.env` memiliki key terisi, tetapi live production validator tetap menganggap production value bermasalah.
- Jangan pakai anon key sebagai service role key.

Yang perlu dilakukan:

1. Ambil Supabase `service_role` key dari dashboard Supabase.
2. Set di Vercel production sebagai `SUPABASE_SERVICE_ROLE_KEY`.
3. Pastikan nilainya berbeda dari `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` atau `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
4. Redeploy dan cek `/api/health?coldStart=true`.

Target:

- `checks.environment.audit.ok=true`
- tidak ada issue severity `error`

### 5. Token deploy generated app belum lengkap

Live readiness menunjukkan:

- `VERPRO_ACCES_TOKEN` missing/invalid, status optional

Walau optional di readiness, fitur deploy generated app bisa terganggu jika token ini diperlukan route deploy.

Yang perlu dilakukan:

1. Pastikan nama env sesuai kode saat ini: `VERPRO_ACCES_TOKEN`.
2. Isi dengan Vercel access token yang benar untuk deploy generated project.
3. Pastikan `VERDI_TEAM` tetap terisi.
4. Uji flow Deploy Vercel dari dashboard project.

### 6. Script postdeploy health bisa false positive pada redirect

Command:

```bash
npm run postdeploy:health -- https://ai-swift.biz.id
```

Hasilnya mencetak `POST_DEPLOY_HEALTH_OK`, padahal response awal adalah HTTP 307 redirect ke `https://www.ai-swift.biz.id`, dan target canonical health sebenarnya HTTP 503.

Kode terkait:

- `scripts/post-deploy-health.js`

Masalah:

- Script hanya fail untuk HTTP `>=500`.
- HTTP 3xx tidak dianggap gagal.
- Node request script tidak follow redirect.

Yang perlu diperbaiki sebelum CI production:

1. Gunakan URL canonical `https://www.ai-swift.biz.id`.
2. Ubah script agar fail jika status code bukan 2xx.
3. Atau implement follow redirect lalu validasi final response.

Target:

- Health gate gagal bila endpoint redirect, non-JSON, 401/403, 404, 5xx, `unhealthy`, atau `degraded` tanpa override.

### 7. Error ecommerce checkpoint di screenshot kemungkinan belum memakai source lokal terbaru

Screenshot dan live runtime failure menunjukkan error:

- `Tahap 2: ecommerce routes checkpoint failed`
- `Missing ecommerce route: app/login/page.tsx`
- `Missing ecommerce route: app/admin/page.tsx`

Tetapi local source sekarang sudah punya guard kondisional:

- `stagedEcommerceRouteRequirements()`
- `plannerRequiresEcommerceLogin()`
- `plannerRequiresEcommerceAdmin()`
- `ecommerceRequiredFiles()`

Regression juga sudah PASS:

- `ecommerce checkpoint and planner routes are conditional`
- `ecommerce.conditional-auth-admin-routes`

Kesimpulan paling mungkin:

- Production belum berjalan dengan source fix terbaru, atau failure live berasal dari job sebelum deploy fix.

Yang perlu dilakukan:

1. Deploy commit lokal terbaru ke production.
2. Pastikan deployment memakai commit `99c8a6c fix: make ecommerce route checkpoints intent-driven` atau commit setelahnya.
3. Setelah worker hidup, ulangi prompt `Buat web e-commerce`.
4. Verifikasi Tahap 2 tidak lagi meminta `app/login/page.tsx` dan `app/admin/page.tsx` kecuali prompt memang minta login/admin.

## Urutan Perbaikan Wajib

### P0 - Blocker Production

1. Set Vercel production env `SWIFT_GENERATION_EXECUTION_MODE=queue`.
2. Set Vercel production env `SWIFT_DISABLE_SERVERLESS_GENERATION_FALLBACK=true`.
3. Deploy dedicated worker dari `workers/Dockerfile` memakai `railway.worker.json`.
4. Set `SWIFT_WORKER_HEALTH_URL` ke endpoint worker `/health`.
5. Ganti Redis `maxmemory-policy` ke `noeviction`.
6. Perbaiki `SUPABASE_SERVICE_ROLE_KEY` production.
7. Redeploy Vercel production dengan commit terbaru.

### P1 - Stabilitas Queue dan Recovery

1. Setelah worker healthy, inspeksi 3 job di dead-letter queue.
2. Replay job yang masih valid lewat admin endpoint atau tooling yang sudah ada.
3. Bersihkan dead-letter job yang sudah tidak relevan setelah root cause teratasi.
4. Jalankan ulang `npm run deploy:readiness`.
5. Jalankan ulang live health:

```bash
curl -L https://www.ai-swift.biz.id/api/health?refreshProvider=true
curl -L https://www.ai-swift.biz.id/api/worker/health
```

### P2 - Health Gate dan CI

1. Perbaiki `scripts/post-deploy-health.js` agar redirect/non-2xx tidak false positive.
2. Tambahkan gate post-deploy memakai canonical domain `https://www.ai-swift.biz.id`.
3. Pastikan CI/CD gagal bila health `unhealthy` atau `degraded`.

### P3 - Functional Production Validation

Setelah P0 sampai P2 selesai, uji manual:

1. Login Google.
2. Buka dashboard.
3. Buat project baru.
4. Prompt: `Buat web e-commerce`.
5. Pastikan preview muncul.
6. Pastikan error `Missing ecommerce route: app/login/page.tsx` tidak muncul.
7. Uji prompt: `Buat web e-commerce dengan login user`.
8. Pastikan `app/login/page.tsx` baru wajib pada prompt ini.
9. Uji prompt: `Buat e-commerce full stack dengan admin panel`.
10. Pastikan `app/admin/page.tsx` wajib pada prompt ini.
11. Uji deploy generated app ke Vercel.

## Command Audit Yang Sudah Dijalankan

```bash
npm run typecheck
npm run lint
npm run build
npm run deploy:readiness
npm run test:regression
npm run test:workspace-builder
npm run runtime-smoke
npm run test:generation-runtime-contracts
npm run postdeploy:health -- https://ai-swift.biz.id
curl -i https://ai-swift.biz.id/api/health?refreshProvider=true
curl -L -i https://ai-swift.biz.id/api/health?refreshProvider=true
curl -L https://www.ai-swift.biz.id/api/worker/health
curl -L https://www.ai-swift.biz.id/api/health?coldStart=true
```

Catatan penting:

- `npm run build` menjalankan `prisma migrate deploy` lewat `scripts/vercel-build.js`.
- Tidak ada pending migration, jadi tidak ada perubahan schema database.

## Definisi Siap Production

Web baru boleh dianggap siap production jika semua ini terpenuhi:

- `npm run typecheck` PASS
- `npm run lint` PASS
- `npm run build` PASS
- `npm run test:regression` PASS
- `npm run test:generation-runtime-contracts` PASS
- `npm run deploy:readiness` mencetak `READY_FOR_DEPLOY`
- `https://www.ai-swift.biz.id/api/health?refreshProvider=true` HTTP 200 dan `status=healthy`
- `https://www.ai-swift.biz.id/api/worker/health` HTTP 200 dan `worker=healthy`
- `SWIFT_GENERATION_EXECUTION_MODE=queue` di production
- worker heartbeat fresh kurang dari 90 detik
- Redis eviction policy `noeviction`
- Supabase service role env valid
- Dead-letter queue tidak menyimpan job lama yang belum ditangani
- Prompt ecommerce sederhana menghasilkan preview tanpa wajib login/admin

## Kesimpulan

Masalah source code ecommerce checkpoint tampaknya sudah diperbaiki di local repo dan regression sudah menjaga perilaku itu.

Blocker production saat ini adalah runtime dan deployment:

1. production masih `serverless`, bukan `queue`
2. dedicated worker belum heartbeat
3. Redis eviction policy belum aman
4. Supabase service role production tidak valid menurut validator
5. postdeploy health script bisa false positive pada redirect
6. production perlu redeploy commit fix terbaru dan diuji ulang

Fokus pertama: hidupkan queue worker production sampai `/api/worker/health` sehat, lalu redeploy source terbaru.
