# Perbaiki Swift AI Generation Pipeline

Tanggal: 2026-06-02

Tujuan:

```txt
Swift AI harus bisa menerima prompt user, membuat website full-stack secara bertahap, menampilkan hasil di preview/sandbox, lalu siap deploy ke Vercel.
```

Status awal investigasi:

```txt
Repo HEAD: f9990c2c99db7dd4e30f2cbd3cc3a4162d788b72
Gejala production: generation gagal dengan SWIFT_AI_PROVIDER_FAILOVER_EXHAUSTED
Root cause terbaru yang sudah ditemukan: OpenRouter stream idle timeout 15 detik pada generation slice besar
Fix timeout sudah ada di commit sebelumnya: 649bcd0 Increase OpenRouter stream timeout
```

## 1. Alur Investigasi

Urutan pemeriksaan:

1. Pastikan source code lokal dan GitHub berada di commit yang benar.
2. Pastikan production runtime sehat: Vercel app, Railway worker, Redis queue, sandbox service, provider health.
3. Ambil bukti dari database production: recent generation jobs, attempts, events, failures.
4. Pastikan error provider bukan auth/key/quota/model-down sebelum mengubah model chain.
5. Pastikan pipeline tidak berhenti sebelum artifact final, preview validation, atau sandbox verification.
6. Pastikan deploy readiness tidak diblokir oleh env/sandbox/worker.
7. Patch kode atau env template yang terbukti menjadi blocker.
8. Jalankan regression dan production audit.
9. Jika semua gate pass, jalankan prompt kecil baru setelah runtime production redeploy.

## 2. Kriteria Lolos

Generate dinyatakan pulih jika:

```txt
POST /api/generate/jobs menerima prompt dan membuat job
Worker mengambil job dari queue
Provider attempt selesai tanpa timeout/failover
Artifact final berisi file hasil prompt, bukan scaffold default
Preview validation lulus
Sandbox service bisa build dan serve preview
Deploy Vercel tidak diblokir oleh readiness gate
```

## 3. Perbaikan Yang Akan Dijalankan

Checklist eksekusi:

- [x] Audit status repo dan commit production.
- [x] Audit Vercel `/api/worker/health`.
- [x] Audit Railway worker `/health`.
- [x] Audit Vercel `/api/provider/health`.
- [x] Audit Vercel `/api/health?refreshProvider=true`.
- [x] Audit Vercel `/api/production/monitoring`.
- [x] Audit sandbox health dan endpoint sandbox app.
- [x] Query recent failed generation attempts dari database.
- [x] Patch kode/env template jika ada blocker.
- [x] Jalankan `npm run test:generation-runtime-contracts`.
- [x] Jalankan `npm run audit:production`.
- [x] Dokumentasikan env production yang harus diset.
- [x] Dokumentasikan langkah redeploy Railway worker dan Vercel.
- [x] Dokumentasikan prompt smoke test setelah deploy.

## 4. Temuan Sementara

### 4.1 Source Dan Deploy Runtime

```txt
Local/Git HEAD: f9990c2
Timeout fix commit: 649bcd0
Railway worker startedAt: 2026-06-02T13:45:50.763Z
Timeout fix commit time: 2026-06-02T14:04:45Z
```

Kesimpulan:

- Source Git sudah memuat fix timeout OpenRouter.
- Worker production yang aktif mulai sebelum commit timeout fix.
- Recent production job masih menulis `OpenRouter request timed out after 15 seconds`.
- Artinya Railway worker belum memakai image/source terbaru yang berisi timeout 60 detik.

### 4.2 Worker, Queue, Redis

Live check:

```txt
Vercel /api/worker/health: healthy
Railway /health: healthy
Queue waiting: 0
Queue active: 0
Queue failed: 9
Dead letter waiting: 23
Redis ping: PONG
Worker currentStage: idle
```

Kesimpulan:

- Queue tidak macet.
- Worker hidup dan heartbeat segar.
- Job gagal setelah diproses, bukan karena job tidak diambil.

### 4.3 Provider

Live provider health:

```txt
/api/provider/health
status: healthy
model: deepseek/deepseek-v4-pro
circuitBreaker: closed
```

Database recent attempts:

```txt
Latest job: cmpwq0m7l00034t431njtae6m
status: dead_lettered
attempt 1: failureReason=timeout, "OpenRouter request timed out after 15 seconds"
attempt 2: skipped, "Model is cooling down after repeated failures"
attempt 3: skipped, "Model is cooling down after repeated failures"
```

Kesimpulan:

- API key tidak terbukti bermasalah; provider health kecil bisa sukses.
- Generation besar masih memakai runtime lama dengan stream idle timeout 15 detik.
- Karena `SWIFT_AI_MODEL_CHAIN` production hanya berisi satu model, saat model timeout/cooldown tidak ada fallback paid yang dicoba.

### 4.4 Sandbox Runtime

Live sandbox health:

```txt
https://sanbox.ai-swift.biz.id/health
HTTP 502
message: Application failed to respond
```

Readiness Vercel:

```txt
blockingFailures: ["SANDBOX_RUNTIME_HEALTH"]
sandboxRuntime.ok: false
sandboxRuntime.httpStatus: 502
error: Sandbox health endpoint is missing runtime.storage; redeploy the sandbox runtime service and ensure it exposes storage health.
```

Local sandbox smoke:

```txt
node services/sandbox-runtime/server.mjs
GET http://127.0.0.1:8099/health
status: healthy
ok: true
service: swift-sandbox-runtime
runtime.storage: present
storage.ok: true
```

Kesimpulan:

- Kode sandbox runtime di repo benar dan health contract valid.
- Production sandbox service tidak merespons di Railway/proxy.
- Selama sandbox 502, preview verified dan deploy final akan tetap tertahan walaupun provider sudah pulih.

### 4.5 Monitoring Production

```txt
Generation window 24h:
total: 13
completed: 0
failed: 13
successRate: 0
```

Kesimpulan:

- Ini bukan kasus satu user/job.
- Pipeline production belum pernah sukses dalam window monitoring terakhir.

## 5. Patch Yang Diterapkan

Patch kode yang sudah ada di Git:

```txt
649bcd0 Increase OpenRouter stream timeout
```

Isi patch:

```txt
OPENROUTER_STREAM_IDLE_TIMEOUT_MS / OPENROUTER_STREAM_TOKEN_WATCHDOG_MS
default: 60_000 ms

OPENROUTER_HARD_TIMEOUT_MS / AI_PROVIDER_REQUEST_BUDGET_MS
default: 180_000 ms
```

Patch baru pada runbook ini:

```txt
perbaiki.md
```

Belum ada patch kode tambahan yang diperlukan dari hasil audit saat ini. Blocker utama berada di runtime deployment:

- Railway generation worker perlu redeploy ke commit `f9990c2`.
- Railway sandbox runtime perlu restart/redeploy sampai `/health` mengembalikan `runtime.storage`.

## 6. Verifikasi

Sudah dijalankan:

```txt
npm run audit:production-env
PASS

npm run test:generation-runtime-contracts
PASS

npm run audit:production
PASS
- command gates: lint, typecheck, build
- static checks: 52/52

Local sandbox /health smoke
PASS
```

Belum bisa diselesaikan dari shell lokal saat ini karena membutuhkan akses redeploy Railway production:

```txt
Redeploy Railway generation worker
Redeploy Railway sandbox runtime
Confirm worker startedAt berubah
Production prompt smoke test
Sandbox preview verification
Deploy readiness check
```

## 7. Langkah Runtime Setelah Patch

Urutan eksekusi runtime:

1. Redeploy Railway generation worker dari Git commit `f9990c2`.
2. Pastikan worker `/health` `startedAt` berubah setelah redeploy.
3. Restart atau redeploy Railway sandbox runtime dari `services/sandbox-runtime/Dockerfile`.
4. Pastikan sandbox env:

```env
NODE_ENV=production
PORT=8080
SANDBOX_PUBLIC_BASE_URL=https://sanbox.ai-swift.biz.id
SANDBOX_SERVICE_TOKEN=<same token as Vercel/Railway worker>
SWIFT_SANDBOX_ROOT=/data/swift-sandbox
```

5. Pastikan sandbox `/health` mengembalikan:

```txt
status=healthy
ok=true
service=swift-sandbox-runtime
runtime.storage.ok=true
```

6. Pastikan worker/app env:

```env
OPENROUTER_STREAM_IDLE_TIMEOUT_MS=60000
OPENROUTER_HARD_TIMEOUT_MS=180000
AI_PROVIDER_REQUEST_BUDGET_MS=180000
AI_MAX_CONCURRENT_GENERATIONS=1
SWIFT_GENERATION_WORKER_CONCURRENCY=1
SWIFT_AI_MODEL_CHAIN=openrouter:deepseek/deepseek-v4-pro
SWIFT_AI_FREE_MODE=false
SANDBOX_SERVICE_URL=https://sanbox.ai-swift.biz.id
```

7. Redeploy Vercel production jika env Vercel berubah.
8. Jalankan health checks:

```txt
https://www.ai-swift.biz.id/api/health?refreshProvider=true
https://www.ai-swift.biz.id/api/worker/health
https://www.ai-swift.biz.id/api/provider/health
https://sanbox.ai-swift.biz.id/health
```

9. Jalankan prompt smoke kecil:

```txt
Buat dashboard inventory toko baju full-stack sederhana dengan halaman produk, ringkasan penjualan, tabel stok, API route produk, dan tampilan preview yang rapi.
```

Kriteria smoke test:

```txt
Generation job status completed
PreviewUrl tidak null
Preview bukan scaffold default
Sandbox session status ready/running
Deploy button tidak lagi terkunci oleh "Verify first"
```
