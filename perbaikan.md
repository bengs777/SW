# Rencana Perbaikan Swift AI

Tanggal eksekusi: Kamis, 4 Juni 2026

Tujuan utama:

```txt
Memindahkan generation worker Swift dari Railway ke VPS dengan PM2, memakai Redis queue yang sama, memakai sandbox executor VPS di 127.0.0.1:3001, lalu memulihkan jalur Prompt -> Queue -> Worker -> Provider -> Artifact -> Preview -> Deploy.
```

Status live terakhir:

```txt
Vercel app masih hidup.
Database healthy.
Auth healthy.
Redis queue healthy.
Worker heartbeat masih terdeteksi dari runtime lama/Railway.
OpenRouter provider offline karena key limit exceeded.
Sandbox VPS http://8.215.30.46:3001 timeout pada /health saat dicek terakhir.
Sandbox VPS sebelumnya hanya punya /health sederhana dan /execute, belum punya kontrak Swift /sandbox/:projectId.
Production health masih 503 karena provider dan/atau sandbox belum siap.
Railway tidak akan dipakai lagi karena credit habis.
```

## 1. Target Arsitektur

```txt
Vercel web/API producer
-> Redis BullMQ queue
-> VPS generation worker dengan PM2
-> VPS sandbox executor http://127.0.0.1:3001
-> Preview public base https://sanbox.ai-swift.biz.id
-> Deploy Vercel untuk project hasil generate
```

## 2. Blocker Saat Ini

### 2.1 OpenRouter Key Limit

Gejala:

```txt
/api/provider/health = 503
OpenRouter API error (403): Key limit exceeded (total limit)
```

Dampak:

```txt
AI tidak bisa generate artifact final.
Job akan gagal walaupun worker dan Redis hidup.
User hanya melihat baseline scaffold/draft.
```

Perbaikan:

- [ ] Naikkan total limit key OpenRouter atau isi credit.
- [ ] Pastikan key yang dipakai production sama dengan key aktif.
- [ ] Setelah limit diperbaiki, cek:

```txt
https://www.ai-swift.biz.id/api/provider/health
```

Kriteria lulus:

```txt
HTTP 200
status=healthy
model=deepseek/deepseek-v4-pro
```

### 2.2 Sandbox VPS Belum Kompatibel Kontrak Swift

Swift membutuhkan endpoint:

```txt
GET    /health
GET    /sandbox/:projectId
POST   /sandbox/:projectId
DELETE /sandbox/:projectId
```

Status VPS terakhir:

```txt
POST /execute bisa menjalankan kode sederhana.
GET /sandbox/status-check pernah 404.
GET /health terakhir timeout.
```

Dampak:

```txt
Compile gate dan preview validation tetap gagal.
Deploy readiness tetap blocked pada SANDBOX_RUNTIME_HEALTH.
Tombol verify/deploy bisa tetap terkunci.
```

Perbaikan:

- [ ] Jalankan runtime kompatibel Swift di VPS, idealnya dari file:

```txt
services/sandbox-runtime/server.mjs
```

- [ ] Pastikan sandbox VPS memakai env:

```env
NODE_ENV=production
PORT=3001
SANDBOX_PUBLIC_BASE_URL=https://sanbox.ai-swift.biz.id
SANDBOX_SERVICE_TOKEN=<same token as Vercel and worker>
SWIFT_SANDBOX_ROOT=/data/swift-sandbox
```

- [ ] Cek dari dalam VPS:

```bash
curl http://127.0.0.1:3001/health
curl -H "Authorization: Bearer $SANDBOX_SERVICE_TOKEN" http://127.0.0.1:3001/sandbox/status-check
```

- [ ] Cek dari luar VPS:

```bash
curl http://8.215.30.46:3001/health
```

Kriteria lulus:

```txt
/health HTTP 200
response punya runtime.storage.ok=true
GET /sandbox/:projectId tidak 404
POST /sandbox/:projectId menerima payload files
```

### 2.3 Worker Masih Mengarah ke Railway

Status terakhir:

```txt
SWIFT_WORKER_HEALTH_URL production masih menunjuk:
https://ingenious-appreciation-production.up.railway.app/health
```

Dampak:

```txt
Production health masih menganggap Railway sebagai worker runtime.
Jika Railway mati total, health akan berubah jadi failed.
```

Perbaikan:

- [ ] Jalankan worker generation di VPS dengan PM2.
- [ ] Buka/allow port worker health 4000 jika ingin diprobe Vercel langsung.
- [ ] Ubah Vercel env:

```env
SWIFT_WORKER_HEALTH_URL=http://<VPS_PUBLIC_IP>:4000/health
```

Catatan:

```txt
Worker VPS sendiri harus memakai SANDBOX_SERVICE_URL=http://127.0.0.1:3001 karena sandbox ada di mesin yang sama.
Vercel boleh memakai SANDBOX_SERVICE_URL=http://<VPS_PUBLIC_IP>:3001 jika Vercel perlu proxy preview langsung.
```

## 3. File Worker Yang Dipakai

Script package:

```json
{
  "worker:generation": "node scripts/run-ts-script.js workers/index.ts --type=generation",
  "worker:health": "node scripts/worker-health-smoke.js",
  "build": "node scripts/vercel-build.js"
}
```

File terkait:

```txt
workers/index.ts
workers/generation-worker.ts
lib/workers/generation-worker.ts
lib/queue/generation-queue.ts
scripts/run-ts-script.js
```

Queue:

```txt
swift-generation-v2
```

Health worker:

```txt
GET /health
GET /api/worker/health
```

## 4. Command VPS Worker

### 4.1 Install

```bash
git clone https://github.com/bengs777/SW.git
cd SW
npm ci
```

Jika repo sudah ada:

```bash
cd SW
git pull origin main
npm ci
```

### 4.2 Build

```bash
npm run build
```

### 4.3 Start Worker Manual

```bash
NODE_ENV=production npm run worker:generation
```

Cek:

```bash
curl http://127.0.0.1:4000/health
```

## 5. Env Worker VPS

Buat file env khusus worker di VPS, misalnya:

```txt
/opt/swift/SW/.env.production
```

Contoh:

```env
NODE_ENV=production
PORT=4000
SWIFT_WORKER_HEALTH_PORT=4000
SWIFT_WORKER_TYPE=generation

SWIFT_GENERATION_EXECUTION_MODE=queue
SWIFT_ALLOW_SERVERLESS_GENERATION_FALLBACK=false
SWIFT_DISABLE_SERVERLESS_GENERATION_FALLBACK=true
SWIFT_ENABLE_GENERATION_WORKER=true
SWIFT_GENERATION_WORKER_CONCURRENCY=1
SWIFT_WORKER_HEARTBEAT_INTERVAL_MS=15000
SWIFT_WORKER_RECOVERY_INTERVAL_MS=60000
SWIFT_GENERATION_JOB_TIMEOUT_MS=500000
SWIFT_STALE_GENERATION_TIMEOUT_MS=500000

DATABASE_URL=postgresql://...
DIRECT_DATABASE_URL=postgresql://...
REDIS_URL=redis://...

OPENROUTER_API_KEY=...
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_SITE_URL=https://www.ai-swift.biz.id
OPENROUTER_APP_NAME=Swift AI
SWIFT_AI_MODEL_CHAIN=openrouter:deepseek/deepseek-v4-pro
SWIFT_PRIMARY_MODEL=deepseek/deepseek-v4-pro
OPENROUTER_DEEPSEEK_V4_PRO_MODEL=deepseek/deepseek-v4-pro
SWIFT_AI_FREE_MODE=false
OPENROUTER_MAX_TOKENS=6000
AI_MAX_OUTPUT_TOKENS=6000
AI_TIMEOUT_MS=500000
AI_MAX_RETRIES=5
AI_MAX_CONCURRENT_GENERATIONS=1
AI_QUEUE_TIMEOUT_MS=500000
PROVIDER_STATUS_CACHE_TTL_MS=86400000

SANDBOX_SERVICE_URL=http://127.0.0.1:3001
SANDBOX_PUBLIC_BASE_URL=https://sanbox.ai-swift.biz.id
SANDBOX_SERVICE_TOKEN=<same token as Vercel and sandbox>
SANDBOX_SERVICE_TIMEOUT_MS=300000

NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_STORAGE_BUCKET=repelit
```

## 6. PM2

Install PM2:

```bash
npm install -g pm2
```

Start worker:

```bash
cd /opt/swift/SW
pm2 start npm --name swift-generation-worker -- run worker:generation
```

Cek:

```bash
pm2 status
pm2 logs swift-generation-worker
curl http://127.0.0.1:4000/health
```

Auto-start:

```bash
pm2 save
pm2 startup
```

## 7. Env Vercel Setelah Worker VPS Hidup

Ubah Vercel production env:

```env
SWIFT_GENERATION_EXECUTION_MODE=queue
SWIFT_DISABLE_SERVERLESS_GENERATION_FALLBACK=true
SWIFT_WORKER_HEALTH_URL=http://<VPS_PUBLIC_IP>:4000/health
SANDBOX_SERVICE_URL=http://<VPS_PUBLIC_IP>:3001
SANDBOX_PUBLIC_BASE_URL=https://sanbox.ai-swift.biz.id
SANDBOX_SERVICE_TOKEN=<same token as worker and sandbox>
SANDBOX_SERVICE_TIMEOUT_MS=300000
```

Setelah env berubah:

```txt
Redeploy Vercel production.
```

## 8. Urutan Eksekusi Aman

1. Perbaiki OpenRouter key limit.
2. Jalankan sandbox runtime kompatibel Swift di VPS port 3001.
3. Cek `/health` dan `/sandbox/:projectId` sandbox VPS.
4. Pull repo terbaru di VPS.
5. Isi `.env.production` worker VPS.
6. Jalankan `npm ci`.
7. Jalankan `npm run build`.
8. Start worker manual dan cek `/health`.
9. Jika manual sehat, start dengan PM2.
10. Ubah Vercel env `SWIFT_WORKER_HEALTH_URL` ke VPS.
11. Redeploy Vercel.
12. Jalankan health check production.
13. Jalankan prompt smoke test kecil.

## 9. Health Check Setelah Migrasi

Jalankan:

```txt
https://www.ai-swift.biz.id/api/provider/health
https://www.ai-swift.biz.id/api/worker/health
https://www.ai-swift.biz.id/api/health?refreshProvider=true
https://www.ai-swift.biz.id/api/production/monitoring
http://<VPS_PUBLIC_IP>:4000/health
http://<VPS_PUBLIC_IP>:3001/health
```

Kriteria lulus:

```txt
Provider healthy
Worker health URL menunjuk VPS, bukan Railway
Worker heartbeat fresh
Queue healthy
Sandbox runtime healthy dengan runtime.storage.ok=true
Tidak ada blockingFailures
```

## 10. Prompt Smoke Test

Gunakan prompt:

```txt
Buat dashboard inventory toko baju full-stack sederhana dengan halaman produk, ringkasan penjualan, tabel stok, API route produk, dan tampilan preview yang rapi.
```

Kriteria lulus:

```txt
Job masuk queue
Worker VPS mengambil job
Provider tidak 403/402
Job completed
Artifact bukan scaffold default
Preview URL muncul
Sandbox session ready/running
Deploy Vercel tidak terkunci oleh Verify first
```

## 11. Catatan Risiko

```txt
Jangan buka SANDBOX_SERVICE_TOKEN ke publik.
Jika worker health port 4000 dibuka publik, batasi firewall jika memungkinkan.
Sandbox executor harus isolated karena menjalankan kode hasil AI.
Jangan aktifkan serverless fallback di Vercel production.
Jangan pakai Railway lagi sebagai dependency health.
```
