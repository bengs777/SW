# Perbaikan Production Readiness Swift AI

Tanggal audit utama: 2026-06-01, timezone Asia/Jakarta.

Dokumen ini adalah gabungan status production readiness, hasil investigasi error `ENOSPC`, dan temuan live logs dari Vercel.

## Status Singkat

Web belum siap production.

Local source code sudah cukup sehat untuk build dan regression, tetapi runtime production masih blocked oleh konfigurasi worker, status queue, dan beberapa sinyal health yang belum hijau.

Update implementasi repo: 2026-06-01.

Perubahan terbaru sudah menambahkan guard storage sandbox untuk mencegah error `ENOSPC` muncul terlambat saat write/install/build, memperkaya `/health` sandbox dengan detail free space, dan menurunkan sinyal Prisma connection closed transient menjadi warning agar log worker health tidak menyesatkan.

## Ringkasan Temuan

- Error `ENOSPC: no space left on device, write` paling mungkin berasal dari filesystem sandbox/runtime saat menulis file atau saat install dependency.
- Local disk Windows masih longgar, jadi sumber `ENOSPC` bukan drive `C:` di mesin ini.
- Sandbox service health endpoint masih `ok:true`, jadi root storage service hidup.
- Live production worker health masih `degraded` karena worker service belum dikonfigurasi dan heartbeat worker belum ada.
- Live logs Vercel menunjukkan error Prisma pada request `/api/worker/health`: `Error in PostgreSQL connection: Error { kind: Closed, cause: None }`.
- Redis production sudah `noeviction` dan memory masih sangat longgar, jadi Redis bukan penyebab utama error ini.
- Local `npm run deploy:readiness` sekarang PASS untuk Redis dan sandbox runtime. Sisa blocker adalah dedicated worker heartbeat dan `SWIFT_WORKER_HEALTH_URL`.

## Status Implementasi Yang Sudah Ada Di Repo

Sudah diimplementasikan sebelumnya:

- `scripts/post-deploy-health.js` sekarang gagal untuk redirect, non-2xx, non-JSON, `unhealthy`, `degraded`, worker missing/disabled, dan punya retry config.
- `package.json` menambah `postdeploy:health:prod` untuk canonical domain `https://www.ai-swift.biz.id`.
- `.github/workflows/ci.yml` menambah production health gate setelah push ke `main`.
- `scripts/deploy-readiness.js` memvalidasi fallback serverless disabled, Supabase service role non-placeholder, Redis `noeviction`, worker heartbeat, dan worker health URL.
- `lib/env.ts` tidak lagi salah menolak Supabase secret key format `sb_secret...`.
- `workers/Dockerfile` menyalin source runtime yang dibutuhkan worker.
- `scripts/run-ts-script.js` bisa memuat dependency `.tsx`.
- `scripts/generation-runtime-contracts.js` menambah guard untuk Docker runtime source dan loader `.tsx`.

Sudah diimplementasikan pada update ini:

- `lib/sandbox/runtime.ts` mengecek free space sandbox sebelum menulis file generated, sebelum install dependency, dan sebelum build preview.
- `services/sandbox-runtime/server.mjs` mengecek free space sebelum write/install/build dan mengembalikan error `Sandbox storage exhausted...` yang lebih jelas.
- `/health` sandbox runtime sekarang mengembalikan detail `storage`, termasuk `availableBytes`, `totalBytes`, `minFreeBytes`, dan `ok`.
- `lib/db/client.ts` mengklasifikasikan Prisma connection closed transient sebagai `prisma_connection_warning`, bukan `prisma_error`.
- `scripts/generation-runtime-contracts.js` menambah regression guard `sandbox.storage-preflight`.

## Investigasi Error `ENOSPC`

### Gejala

Di dashboard muncul:

- `ENOSPC: no space left on device, write`
- preview tetap kosong
- file count masih `0 files`
- sandbox/generation berhenti sebelum preview terbentuk

### Bukti Lokasi Write Yang Paling Relevan

Write file sandbox terjadi di:

- [services/sandbox-runtime/server.mjs](services/sandbox-runtime/server.mjs)
- [lib/sandbox/runtime.ts](lib/sandbox/runtime.ts)

Alur pentingnya:

- buat root sandbox
- tulis `package.json`
- tulis file runtime lain
- loop semua file generated dan tulis ke disk
- lanjut `npm ci` atau `npm install`
- build project

### Titik Write Yang Paling Mungkin Memicu ENOSPC

Di `services/sandbox-runtime/server.mjs`:

- `ensureFiles(...)`
- `npm ci --ignore-scripts`
- `npm run build`

Di `lib/sandbox/runtime.ts`:

- `ensureRuntimeFiles(...)`
- `npm install --ignore-scripts --include=dev`
- `npm run typecheck`
- `npm run lint`
- `npm run build`

### Kenapa Ini Bukan Error UI Saja

Kode menunjukkan error ini memang muncul saat proses menulis file ke filesystem sandbox, bukan karena tampilan dashboard atau React runtime semata.

### Kenapa Bukan Disk Lokal Windows

Hasil cek lokal:

- drive `C:` masih punya sekitar `27.6 GB` free
- folder `.swift-sandboxes` lokal kecil
- `.swift-reports` lokal sekitar `94 MB`

Artinya, ruang disk lokal masih aman.

### Kesimpulan ENOSPC

`ENOSPC` paling masuk akal berasal dari storage sandbox/runtime yang dipakai proses generate, bukan dari disk lokal Windows.

Kemungkinan penyebabnya:

- volume sandbox terlalu kecil
- dependency install menulis terlalu banyak file
- cleanup sandbox tidak cukup agresif
- ada akumulasi state runtime di storage yang sama

Status implementasi:

- Sudah ada preflight storage sebelum sandbox menulis file generated.
- Sudah ada preflight storage sebelum dependency install.
- Sudah ada preflight storage sebelum build.
- Health endpoint sandbox sudah melaporkan storage low sebagai `503 degraded`.

## Investigasi Live Logs Vercel

### Bukti Log Paling Penting

Dari log Vercel yang dicopas ke file lampiran:

- request `GET /api/worker/health` menghasilkan log Prisma error
- pesan error: `Error in PostgreSQL connection: Error { kind: Closed, cause: None }`
- source log: `serverless-middleware`
- response status: `503`

### Apa Artinya

Ini bukan error frontend.

Ini menunjukkan ada jalur backend yang menyentuh Prisma/PostgreSQL lalu koneksinya tertutup saat request diproses atau saat cold start/schema check.

### Jalur Kode Yang Relevan

- [app/api/worker/health/route.ts](app/api/worker/health/route.ts)
- [lib/queue/generation-queue.ts](lib/queue/generation-queue.ts)
- [lib/observability/external-runtime-health.ts](lib/observability/external-runtime-health.ts)
- [lib/db/client.ts](lib/db/client.ts)
- [instrumentation.node.ts](instrumentation.node.ts)
- [lib/db/schema-health.ts](lib/db/schema-health.ts)

### Interpretasi Teknis

`/api/worker/health` sendiri tidak memanggil Prisma secara langsung, tetapi request itu tetap memicu lapisan instrumentation dan database guard yang bisa memanggil schema health check.

`instrumentation.node.ts` menjalankan:

- deployment readiness check
- database schema guard
- generation worker bootstrap
- orchestration cleanup

Schema guard di `lib/db/schema-health.ts` melakukan query raw ke `_prisma_migrations`, `information_schema.tables`, dan `information_schema.columns`.

Jadi, error Prisma kemungkinan muncul dari init/guard database yang ikut tereksekusi saat request ini masuk, bukan dari handler health route itu sendiri.

## Status Live Worker Health

Live `/api/worker/health` saat ini mengembalikan:

- `status: degraded`
- `worker: missing`
- `queue: degraded`
- `deadLetter.waiting: 3`
- `heartbeat: null`
- `redis.status: ready`
- `redis.memory.evictionPolicy: noeviction`
- `workerService.status: missing`
- `workerService.configured: false`

### Arti Praktisnya

- Redis sehat.
- Worker dedicated belum terhubung.
- URL health worker belum diset.
- Ada dead-letter backlog yang belum dibereskan.

Hasil `npm run deploy:readiness` terbaru:

- PASS `REDIS_EVICTION_POLICY`
- PASS `SANDBOX_RUNTIME_HEALTH`
- FAIL `GENERATION_WORKER_HEARTBEAT`
- FAIL `SWIFT_WORKER_HEALTH_URL`

## Hal Yang Sudah Terkonfirmasi Bukan Penyebab Utama

- Redis bukan penyebab utama saat ini.
- Mesin lokal Windows bukan penyebab `ENOSPC`.
- Sandbox service health endpoint bukan sumber masalah, karena `/health` masih `ok:true`.

## Yang Masih Harus Dilakukan Di Provider

### P0 - Blocker Production

1. Set Vercel production env `SWIFT_GENERATION_EXECUTION_MODE=queue`.
2. Set Vercel production env `SWIFT_DISABLE_SERVERLESS_GENERATION_FALLBACK=true`.
3. Deploy dedicated worker dari `workers/Dockerfile` memakai `railway.worker.json`.
4. Set `SWIFT_WORKER_HEALTH_URL` ke endpoint worker `/health`.
5. Ganti Redis `maxmemory-policy` ke `noeviction` kalau belum permanen.
6. Pastikan production `SUPABASE_SERVICE_ROLE_KEY` benar.
7. Redeploy Vercel production dengan commit terbaru.

### P1 - Stabilitas Queue Dan Recovery

1. Setelah worker hidup, inspeksi dead-letter queue.
2. Replay job yang masih valid.
3. Bersihkan job dead-letter yang sudah tidak relevan.
4. Jalankan ulang `npm run deploy:readiness`.
5. Jalankan ulang:

```bash
curl -L https://www.ai-swift.biz.id/api/health?refreshProvider=true
curl -L https://www.ai-swift.biz.id/api/worker/health
```

## Status Implementasi Lokal

Lulus lokal:

- `npm run typecheck`
- `npm run lint`
- `npm run build`
- `npm run test:hardening`
- `npm run test:regression`
- `npm run test:workspace-builder`
- `npm run runtime-smoke`
- `npm run test:generation-runtime-contracts`

Masih gagal:

- `npm run deploy:readiness`
- live production health

Catatan readiness terbaru:

- `npm run deploy:readiness` gagal hanya karena dedicated worker belum heartbeat dan `SWIFT_WORKER_HEALTH_URL` belum diset.

## Kesimpulan Akhir

Masalah yang terlihat saat ini terdiri dari dua lapis:

1. Error `ENOSPC` saat generate project, yang paling mungkin berasal dari filesystem sandbox/runtime saat menulis file atau dependency.
2. Production worker health yang belum hijau, ditambah sinyal Prisma/PostgreSQL closed connection di live logs.

Jadi, web belum production-ready sampai:

- sandbox storage aman,
- worker dedicated hidup,
- `SWIFT_WORKER_HEALTH_URL` terisi,
- Redis benar-benar stabil,
- dan live health kembali hijau.
