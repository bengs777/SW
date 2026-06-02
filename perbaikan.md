# Runbook Perbaikan Production Swift AI

Tanggal investigasi: 2026-06-02 15:19 WIB

Dokumen ini fokus pada sisa pekerjaan production yang harus dilakukan di Railway dan Vercel setelah perbaikan repo diterapkan.

## Status Live Saat Ini

Health production:

```txt
https://www.ai-swift.biz.id/api/health?refreshProvider=true
```

Hasil penting:

- `status`: `unhealthy`
- `deployment`: `unhealthy`
- `worker`: `degraded`
- `queue`: `ok`
- `database`: `ok`
- `auth`: `ok`
- `providers`: `healthy`

Blocking failures:

- `GENERATION_WORKER_HEARTBEAT`
- `GENERATION_WORKER_RUNTIME`
- `SANDBOX_RUNTIME_HEALTH`

Detail worker:

- Redis native sehat dan menjawab `PONG`
- Queue tidak penuh
- Dead-letter queue berisi 3 job
- `workerHeartbeat` masih `null`
- `SWIFT_WORKER_HEALTH_URL` di Vercel masih placeholder:

```txt
https://<your-worker-service>.up.railway.app/health
```

Detail sandbox:

Endpoint sandbox:

```txt
https://swift-sandbox-service-production.up.railway.app/health
```

Masih membalas:

```json
{"ok":true,"service":"swift-sandbox-service"}
```

Payload ini belum valid untuk production karena belum berisi `runtime.storage`.

## Kesimpulan Investigasi

Masalah utama sekarang bukan database, auth, Redis, atau AI provider.

Masalah utama ada di 3 titik:

1. Worker dedicated belum aktif atau belum terhubung sebagai service production yang benar.
2. Vercel production masih memakai `SWIFT_WORKER_HEALTH_URL` placeholder.
3. Sandbox Railway masih deploy image lama atau service yang live masih bukan sandbox runtime versi terbaru.

Gejala UI seperti `No files available to validate` muncul karena job generate belum maju sampai menghasilkan draft files. Jadi tombol preview validation bukan akar masalahnya.

## File Pendukung Di Repo

Worker Railway:

- Config Railway: `railway.worker.json`
- Dockerfile: `workers/Dockerfile`
- Env template: `.env.railway.worker.production`
- Command runtime: `npm run worker:generation`
- Health path: `/health`

Sandbox Railway:

- Config Railway: `railway.json`
- Dockerfile: `services/sandbox-runtime/Dockerfile`
- Env template: `.env.railway.production`
- Health path: `/health`
- Root storage wajib: `/data/swift-sandbox`

Dashboard Vercel:

- Env utama production: `.env.production`
- Health checker worker/sandbox:
  - `lib/observability/external-runtime-health.ts`
  - `lib/production/readiness.ts`
  - `scripts/deploy-readiness.js`

## Implementasi Repo Yang Sudah Dikerjakan

Bagian ini sudah diterapkan di codebase lokal dan siap dipush/deploy:

- [x] Guard placeholder `SWIFT_WORKER_HEALTH_URL` di `lib/env.ts`, supaya nilai seperti `https://<your-worker-service>.up.railway.app/health` dianggap missing.
- [x] Guard placeholder worker URL di `scripts/deploy-readiness.js`, supaya readiness check tidak mencoba fetch URL palsu.
- [x] Template env worker Railway `.env.railway.worker.production`.
- [x] Validasi preview tidak lagi dianggap failed saat file hasil generate memang belum tersedia.
- [x] Tombol `Validate preview` disabled sampai ada file nyata yang bisa divalidasi.
- [x] Regression contract untuk config worker Railway, template env worker, dan normalisasi placeholder worker URL.

Yang belum bisa diselesaikan dari repo lokal:

- [ ] Membuat service Railway `swift-generation-worker`.
- [ ] Mengisi secret Railway/Vercel dengan nilai production asli.
- [ ] Mengambil URL publik worker Railway.
- [ ] Redeploy Vercel production dan sandbox Railway dari dashboard/platform.

## Urutan Perbaikan Yang Disarankan

Jangan mulai dari replay dead-letter queue. Job akan gagal ulang kalau worker dan sandbox belum sehat.

Urutan yang benar:

1. Push dan deploy code terbaru ke Vercel production.
2. Deploy dedicated worker di Railway.
3. Ambil URL publik worker.
4. Isi `SWIFT_WORKER_HEALTH_URL` di Vercel production.
5. Redeploy Vercel production.
6. Redeploy sandbox runtime Railway dari commit terbaru.
7. Pastikan sandbox health punya `runtime.storage`.
8. Cek production health sampai blocking failures hilang.
9. Baru replay dead-letter queue dan jalankan ulang prompt.

## Langkah 0: Deploy Code Terbaru Ke Vercel

Health live masih menunjukkan Vercel production mencoba membaca placeholder ini sebagai URL aktif:

```txt
https://<your-worker-service>.up.railway.app/health
```

Di repo lokal sudah ada guard agar placeholder seperti itu dianggap missing. Jadi sebelum menguji ulang health production, pastikan perubahan repo terbaru sudah:

- masuk GitHub
- terdeploy ke Vercel production
- tidak masih memakai deployment lama

Target setelah deploy code terbaru:

- `SWIFT_WORKER_HEALTH_URL` placeholder dilaporkan sebagai missing atau invalid env, bukan dicoba fetch sebagai endpoint
- error `Failed to parse URL from https://<your-worker-service>...` hilang

## Langkah 1: Deploy Dedicated Worker Di Railway

Buat service baru di Railway untuk worker. Jangan gabungkan dengan sandbox runtime.

Konfigurasi service:

```txt
Service name: swift-generation-worker
Source: GitHub repo SW
Config file: railway.worker.json
Dockerfile: workers/Dockerfile
Healthcheck path: /health
Port: 4000
```

Variables yang dimasukkan ke Railway worker memakai template:

```txt
.env.railway.worker.production
```

Wajib diganti dari placeholder:

```txt
DATABASE_URL
DIRECT_DATABASE_URL
REDIS_URL
OPENROUTER_API_KEY
SANDBOX_SERVICE_TOKEN
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY
SUPABASE_SERVICE_ROLE_KEY
SUPABASE_STORAGE_BUCKET
```

Nilai penting yang harus tetap seperti ini:

```txt
NODE_ENV=production
PORT=4000
SWIFT_WORKER_HEALTH_PORT=4000
SWIFT_WORKER_TYPE=generation
SWIFT_GENERATION_EXECUTION_MODE=queue
SWIFT_DISABLE_SERVERLESS_GENERATION_FALLBACK=true
SWIFT_ENABLE_GENERATION_WORKER=true
```

Target hasil:

```txt
https://<worker-service>.up.railway.app/health
```

harus mengembalikan HTTP `200` dengan:

```json
{
  "status": "healthy",
  "mode": "queue"
}
```

## Langkah 2: Isi Worker URL Di Vercel Production

Set environment variable Vercel production:

```txt
SWIFT_WORKER_HEALTH_URL=https://<worker-service>.up.railway.app/health
```

Jangan isi dengan placeholder.

Set di Vercel Dashboard:

```txt
Project -> Settings -> Environment Variables -> Production
```

Atau lewat CLI:

```bash
echo "https://<worker-service>.up.railway.app/health" | vercel env add SWIFT_WORKER_HEALTH_URL production
```

Setelah env diubah, redeploy production Vercel. Perubahan env Vercel tidak berlaku ke deployment lama.

Target hasil:

- `GENERATION_WORKER_RUNTIME` hilang
- `workerRuntime.ok === true`
- health tidak lagi menampilkan URL placeholder

## Langkah 3: Pastikan Worker Menulis Heartbeat Ke Redis

Worker dianggap sehat kalau Redis punya heartbeat fresh.

Health production sebelumnya menunjukkan:

```txt
workerHeartbeat: null
```

Setelah worker hidup, production health harus berubah menjadi heartbeat berisi data worker.

Target:

```txt
workerHeartbeatFresh: true
```

Jika worker endpoint sudah HTTP `200` tetapi heartbeat masih `null`, cek Railway worker logs:

- apakah `worker_boot` muncul
- apakah `worker_alive` muncul
- apakah ada error `REDIS_URL`
- apakah ada error schema guard atau Prisma
- apakah Redis yang dipakai worker sama dengan Redis yang dipakai Vercel

## Langkah 4: Redeploy Sandbox Runtime Railway

Sandbox yang live masih stale karena health endpoint masih:

```json
{"ok":true,"service":"swift-sandbox-service"}
```

Padahal kode terbaru harus mengembalikan:

```json
{
  "ok": true,
  "service": "swift-sandbox-runtime",
  "runtime": {
    "storage": {
      "availableBytes": 123456789,
      "minFreeBytes": 268435456,
      "ok": true
    }
  }
}
```

Periksa service sandbox di Railway:

```txt
Config file: railway.json
Dockerfile: services/sandbox-runtime/Dockerfile
Healthcheck path: /health
Volume mount path: /data
SWIFT_SANDBOX_ROOT=/data/swift-sandbox
```

Variables yang dimasukkan ke Railway sandbox memakai template:

```txt
.env.railway.production
```

Wajib diganti dari placeholder:

```txt
SANDBOX_SERVICE_TOKEN
SWIFT_SANDBOX_DATABASE_URL
SWIFT_SANDBOX_DIRECT_DATABASE_URL
```

Target hasil:

```txt
https://swift-sandbox-service-production.up.railway.app/health
```

harus mengandung:

- `service: "swift-sandbox-runtime"`
- `runtime.rootReady: true`
- `runtime.storage.availableBytes`
- `runtime.storage.minFreeBytes`
- `runtime.storage.ok: true`

## Langkah 5: Verifikasi Vercel Env Production

Pastikan Vercel production punya env ini:

```txt
SANDBOX_SERVICE_URL=https://swift-sandbox-service-production.up.railway.app
SANDBOX_SERVICE_TOKEN=<token yang sama dengan Railway sandbox>
SWIFT_WORKER_HEALTH_URL=https://<worker-service>.up.railway.app/health
REDIS_URL=<native redis:// atau rediss://>
SWIFT_GENERATION_EXECUTION_MODE=queue
SWIFT_DISABLE_SERVERLESS_GENERATION_FALLBACK=true
VERDI_TEAM=<vercel team id>
VERPRO_ACCES_TOKEN=<vercel deploy token>
```

Jangan masukkan env internal sandbox seperti ini ke Vercel dashboard kecuali memang dipakai untuk fallback lokal:

```txt
SWIFT_SANDBOX_ROOT=/data/swift-sandbox
SWIFT_SANDBOX_DATABASE_URL=...
SWIFT_SANDBOX_DIRECT_DATABASE_URL=...
```

Nilai tersebut milik service sandbox Railway.

## Langkah 6: Cek Health Setelah Redeploy

Cek sandbox:

```bash
curl https://swift-sandbox-service-production.up.railway.app/health
```

Cek production:

```bash
curl "https://www.ai-swift.biz.id/api/health?refreshProvider=true"
```

Target production health:

```txt
status=healthy
deployment.status=ready
worker=healthy
blockingFailures=[]
workerHeartbeatFresh=true
sandboxRuntime.ok=true
```

Target yang harus hilang:

```txt
GENERATION_WORKER_HEARTBEAT
GENERATION_WORKER_RUNTIME
SANDBOX_RUNTIME_HEALTH
```

## Langkah 7: Replay Dead-Letter Queue

Saat ini dead-letter queue berisi 3 job.

Replay hanya setelah:

- worker heartbeat fresh
- sandbox runtime healthy
- production health tidak blocked

Kalau replay dilakukan sebelum itu, job kemungkinan gagal ulang.

## Langkah 8: Test Prompt End-To-End

Setelah health hijau:

1. Buka project kosong yang tadi gagal.
2. Kirim ulang prompt.
3. Pastikan job masuk queue.
4. Pastikan draft files muncul di Monaco/Explorer.
5. Pastikan preview validation bisa diklik dan tidak berhenti di `No files available to validate`.
6. Pastikan preview runtime berjalan.
7. Pastikan Push GitHub dan Deploy Vercel hanya aktif setelah sandbox verified.

## Tabel Root Cause Dan Fix

| Masalah | Bukti Live | Fix |
| --- | --- | --- |
| Worker runtime invalid | `endpoint=https://<your-worker-service>.up.railway.app/health` | Deploy worker Railway dan isi URL asli di Vercel |
| Worker heartbeat missing | `workerHeartbeat=null` | Pastikan worker process hidup dan memakai Redis yang sama |
| Sandbox stale | `service=swift-sandbox-service` | Redeploy sandbox dari commit terbaru dengan `railway.json` |
| Sandbox storage contract missing | tidak ada `runtime.storage` | Pastikan Dockerfile dan `server.mjs` terbaru dipakai |
| Preview validation kosong | `generatedFiles.length=0` | Selesaikan worker/sandbox supaya draft files dibuat |

## Checklist Eksekusi

- [x] Guard placeholder worker URL di repo
- [x] Siapkan template `.env.railway.worker.production`
- [x] Tambahkan regression contract untuk worker config/env/placeholder URL
- [x] Perbaiki UX preview validation saat file belum tersedia
- [ ] Buat service Railway `swift-generation-worker`
- [ ] Pakai `railway.worker.json`
- [ ] Isi variables dari `.env.railway.worker.production`
- [ ] Deploy worker sampai `/health` HTTP `200`
- [ ] Copy URL worker asli
- [ ] Set `SWIFT_WORKER_HEALTH_URL` di Vercel production
- [ ] Redeploy Vercel production
- [ ] Redeploy sandbox Railway dari commit terbaru
- [ ] Pastikan volume sandbox mount ke `/data`
- [ ] Pastikan sandbox env `SWIFT_SANDBOX_ROOT=/data/swift-sandbox`
- [ ] Pastikan sandbox `/health` mengandung `runtime.storage`
- [ ] Cek `/api/health?refreshProvider=true`
- [ ] Replay dead-letter queue
- [ ] Jalankan ulang prompt

## Kriteria Selesai

Production dianggap siap kalau:

- `/api/health?refreshProvider=true` HTTP `200`
- `blockingFailures` kosong
- `workerHeartbeatFresh=true`
- `workerRuntime.ok=true`
- `sandboxRuntime.ok=true`
- `sandboxRuntime.detail.runtime.storage.ok=true`
- draft files muncul di editor
- preview validation berjalan terhadap file nyata

## Referensi Platform

- Railway variables: https://docs.railway.com/variables
- Railway volumes: https://docs.railway.com/deploy/volumes
- Railway healthchecks: https://docs.railway.com/reference/healthchecks
- Vercel environment variables: https://vercel.com/docs/environment-variables
- Vercel CLI env: https://vercel.com/docs/cli/env
