# Plan Perbaikan Alur Pembuatan Web Swift AI

Tanggal: Kamis, 4 Juni 2026

## Ringkasan Masalah

Alur pembuatan web Swift AI belum berjalan end-to-end.

Yang sudah lulus:

```txt
Database
Auth
Redis queue
Worker queue heartbeat
Job creation
Queue dispatch ke worker
```

Yang masih gagal:

```txt
OpenRouter provider
Worker VPS
Sandbox VPS runtime
Production health
Preview sandbox
Deploy final
```

Evidence utama:

```txt
/api/provider/health = 503
OpenRouter API error (403): Key limit exceeded (total limit)

/api/health?refreshProvider=true = 503
blockingFailures = SANDBOX_RUNTIME_HEALTH

http://8.215.40.119:4000/health = timeout

http://8.215.40.119:3001/health = 200
{"ok":true,"service":"sandbox","port":"3001"}

GET /sandbox/test-project = 404 Cannot GET
POST /sandbox/test-project = 404 Cannot POST
```

Job terbaru:

```txt
provider_called
generation_failed
reason = SWIFT_AI_PROVIDER_FAILOVER_EXHAUSTED
```

Artinya:

```txt
Prompt -> Queue -> Worker sudah bergerak.
Alur berhenti di provider OpenRouter.
Preview dan deploy juga belum bisa valid karena sandbox VPS belum menjalankan runtime Swift yang benar.
```

## Target Akhir

```txt
Prompt user
-> Generation job created
-> Redis queue accepted
-> Worker VPS mengambil job
-> OpenRouter generate artifact
-> Artifact persisted
-> Sandbox VPS build preview
-> Preview validated
-> Deploy Vercel berhasil
```

## 1. Perbaiki OpenRouter

Masalah:

```txt
OpenRouter API error (403): Key limit exceeded (total limit)
```

Dampak:

```txt
AI tidak bisa generate kode final.
Job gagal di stage provider_called.
User melihat gangguan sementara atau loading lama.
```

Langkah:

```txt
1. Buka OpenRouter dashboard.
2. Masuk ke workspace swift-ai.
3. Cek key yang dipakai production.
4. Naikkan total limit key atau isi credit.
5. Jika key sudah tidak valid, buat key baru.
6. Update OPENROUTER_API_KEY di Vercel production.
7. Update OPENROUTER_API_KEY di worker VPS.
8. Restart worker.
9. Redeploy Vercel jika env Vercel berubah.
```

Kriteria lulus:

```txt
https://www.ai-swift.biz.id/api/provider/health = HTTP 200
status = healthy
Tidak ada Key limit exceeded
Tidak ada 401/402/403
```

## 2. Jalankan Sandbox Runtime Swift Di VPS

## 2. Rencana Ubah Model OpenRouter Agar Bisa Pakai Model Gratis

Tujuan:

```txt
Tetap memakai OpenRouter API.
Tidak hardcode model berbayar.
Semua fitur generate membaca model dari environment variable.
Default model memakai model gratis jika env kosong.
Perubahan minimal dan tidak merusak auth, database, sandbox, worker, atau dashboard.
```

Env target:

```env
OPENROUTER_API_KEY=sk-or-v1-xxxx
OPENROUTER_MODEL=poolside/laguna-m.1:free
SWIFT_AI_PROVIDER_NAME=openrouter
```

Default model:

```txt
process.env.OPENROUTER_MODEL || "poolside/laguna-m.1:free"
```

Fallback model opsional:

```txt
openrouter/owl-alpha
poolside/laguna-xs.2:free
```

Aturan pemanggilan OpenRouter:

```txt
Authorization: Bearer process.env.OPENROUTER_API_KEY
Content-Type: application/json
model: process.env.OPENROUTER_MODEL || "poolside/laguna-m.1:free"
```

Batasan perubahan:

```txt
Jangan ganti provider selain OpenRouter.
Jangan hapus kode yang tidak terkait.
Jangan upgrade Prisma.
Jangan ubah schema database.
Jangan ubah NextAuth.
Jangan ubah konfigurasi sandbox selain memastikan env sandbox tetap terbaca.
Jangan log API key.
Tambahkan logging ringan hanya untuk provider dan model.
Pastikan npm run build tetap lulus.
```

Folder yang harus dicek:

```txt
app
lib
services
workers
scripts
```

Cari semua hardcode model berikut:

```txt
openai/gpt-4o
anthropic/claude
gpt-4
gpt-5
openrouter/auto
deepseek/deepseek-v4-pro
OPENROUTER_DEEPSEEK_V4_PRO_MODEL
SWIFT_PRIMARY_MODEL
SWIFT_AI_MODEL_CHAIN
```

Command pencarian:

```bash
rg -n "openai/gpt-4o|anthropic/claude|gpt-4|gpt-5|openrouter/auto|deepseek/deepseek-v4-pro|OPENROUTER_DEEPSEEK_V4_PRO_MODEL|SWIFT_PRIMARY_MODEL|SWIFT_AI_MODEL_CHAIN" app lib services workers scripts
rg -n "OPENROUTER_API_KEY|OpenRouter|openrouter|model:" app lib services workers scripts
```

Strategi perubahan:

```txt
1. Cari konfigurasi provider/model terpusat.
2. Jika ada, ubah di konfigurasi terpusat saja.
3. Tambahkan helper model:
   const OPENROUTER_DEFAULT_MODEL = "poolside/laguna-m.1:free"
   const openRouterModel = process.env.OPENROUTER_MODEL || OPENROUTER_DEFAULT_MODEL
4. Pastikan semua generate memakai helper tersebut.
5. Pastikan fallback sederhana hanya aktif jika request model utama gagal karena limit/rate/auth/provider.
6. Logging hanya mencatat provider=openrouter dan model=<model>, tanpa API key.
```

Fallback handling aman:

```txt
Model utama:
poolside/laguna-m.1:free

Fallback 1:
openrouter/owl-alpha

Fallback 2:
poolside/laguna-xs.2:free
```

Fallback rule:

```txt
Jika model utama gagal karena limit/rate/provider unavailable, coba fallback berikutnya.
Jika semua gagal, return error existing tanpa merusak refund/job flow.
Jangan retry tanpa batas.
Jangan mengubah billing/refund flow.
Jangan mengubah queue flow.
```

Env final Vercel:

```env
OPENROUTER_API_KEY=sk-or-v1-xxxx
OPENROUTER_MODEL=poolside/laguna-m.1:free
SWIFT_AI_PROVIDER_NAME=openrouter

SANDBOX_SERVICE_URL=https://sandbox.ai-swift.biz.id
SANDBOX_PUBLIC_BASE_URL=https://sandbox.ai-swift.biz.id
SANDBOX_SERVICE_TOKEN=token_sandbox_saya
```

Catatan sandbox:

```txt
Sandbox tetap memakai:
SANDBOX_SERVICE_URL=https://sandbox.ai-swift.biz.id
SANDBOX_PUBLIC_BASE_URL=https://sandbox.ai-swift.biz.id
SANDBOX_SERVICE_TOKEN dari env.

Jangan hardcode token sandbox.
Jangan hardcode localhost untuk production.
```

File yang kemungkinan perlu diubah:

```txt
lib/ai/models.ts
lib/ai/generation-pipeline.ts
lib/ai/provider-health.ts atau file health provider jika ada
lib/services/generation-orchestrator.service.ts
lib/workers/generation-worker.ts
workers/generation-worker.ts
app/api/models/route.ts
app/api/provider/health/route.ts
scripts yang melakukan provider smoke test
```

Daftar final file harus dikonfirmasi setelah pencarian `rg`, bukan ditebak.

Output yang diminta setelah implementasi:

```txt
1. Daftar file yang diubah.
2. Patch/kode final untuk setiap file.
3. Command test:
   npm run build
4. Hasil build.
5. Catatan fallback model jika model free kena limit.
```

Kriteria lulus:

```txt
OPENROUTER_MODEL terbaca dari env.
Jika OPENROUTER_MODEL kosong, default ke poolside/laguna-m.1:free.
Tidak ada hardcode model berbayar di jalur generate utama.
OpenRouter request memakai Authorization Bearer dari env.
OpenRouter request memakai Content-Type application/json.
Provider health membaca model env.
Worker membaca model env.
Dashboard model list tidak memaksa model berbayar.
npm run build lulus.
```

## 3. Jalankan Sandbox Runtime Swift Di VPS

Masalah:

```txt
VPS 8.215.40.119:3001 hidup, tapi hanya menjalankan service health sederhana.
Endpoint /sandbox/:projectId belum ada.
```

Runtime yang harus dipakai:

```txt
services/sandbox-runtime/server.mjs
```

Env minimal di VPS sandbox:

```env
NODE_ENV=production
PORT=3001
HOST=0.0.0.0
SANDBOX_PUBLIC_BASE_URL=https://sanbox.ai-swift.biz.id
SANDBOX_SERVICE_TOKEN=<sama dengan Vercel dan worker>
SWIFT_SANDBOX_ROOT=/data/swift-sandbox
SWIFT_SANDBOX_BASE_PORT=4300
SWIFT_SANDBOX_DATABASE_URL=<database url jika dibutuhkan>
SWIFT_SANDBOX_DIRECT_DATABASE_URL=<direct database url jika dibutuhkan>
SWIFT_SANDBOX_MAX_PROJECTS=12
SWIFT_SANDBOX_MAX_FILES=240
SWIFT_SANDBOX_MAX_TOTAL_BYTES=6291456
SWIFT_SANDBOX_MAX_FILE_BYTES=524288
SWIFT_SANDBOX_PROJECT_IDLE_TTL_MS=1800000
SWIFT_SANDBOX_PROCESS_MAX_UPTIME_MS=1200000
SWIFT_SANDBOX_MIN_FREE_BYTES=268435456
SWIFT_SANDBOX_INSTALL_MIN_FREE_BYTES=268435456
SWIFT_SANDBOX_BUILD_MIN_FREE_BYTES=268435456
SWIFT_SANDBOX_ALLOW_UNSAFE_PACKAGE_INSTALL=0
```

Command contoh di VPS:

```bash
cd /path/to/SW
npm ci
NODE_ENV=production PORT=3001 node services/sandbox-runtime/server.mjs
```

Dengan PM2:

```bash
pm2 start services/sandbox-runtime/server.mjs --name swift-sandbox-runtime
pm2 save
```

Kriteria lulus health:

```txt
http://8.215.40.119:3001/health = HTTP 200
service = swift-sandbox-runtime
status = healthy
runtime.rootReady = true
runtime.storage.ok = true
```

Kriteria lulus kontrak:

```bash
curl -H "Authorization: Bearer TOKEN" http://8.215.40.119:3001/sandbox/test-project
```

Hasil boleh:

```txt
status idle/error valid
```

Tidak boleh:

```txt
404 Cannot GET /sandbox/test-project
```

Test POST:

```bash
curl -X POST http://8.215.40.119:3001/sandbox/test-project \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"files":[]}'
```

Hasil boleh:

```txt
400 karena files kosong
```

Tidak boleh:

```txt
404 Cannot POST /sandbox/test-project
```

## 4. Jalankan Worker Generation Di VPS

Masalah:

```txt
Worker health production masih menunjuk Railway:
https://ingenious-appreciation-production.up.railway.app/health

Worker VPS belum hidup:
http://8.215.40.119:4000/health timeout
```

Env minimal worker VPS:

```env
NODE_ENV=production
PORT=4000
SWIFT_WORKER_HEALTH_PORT=4000
SWIFT_WORKER_TYPE=generation
SWIFT_GENERATION_EXECUTION_MODE=queue
SWIFT_DISABLE_SERVERLESS_GENERATION_FALLBACK=true
SWIFT_ENABLE_GENERATION_WORKER=true
SWIFT_GENERATION_WORKER_CONCURRENCY=1
REDIS_URL=<native redis url>
DATABASE_URL=<neon pooled database url>
DIRECT_DATABASE_URL=<neon direct database url>
OPENROUTER_API_KEY=<openrouter key aktif>
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_SITE_URL=https://www.ai-swift.biz.id
OPENROUTER_APP_NAME=Swift AI
SWIFT_AI_MODEL_CHAIN=openrouter:deepseek/deepseek-v4-pro
SWIFT_PRIMARY_MODEL=deepseek/deepseek-v4-pro
SANDBOX_SERVICE_URL=http://127.0.0.1:3001
SANDBOX_PUBLIC_BASE_URL=https://sanbox.ai-swift.biz.id
SANDBOX_SERVICE_TOKEN=<sama dengan Vercel dan sandbox>
SANDBOX_SERVICE_TIMEOUT_MS=300000
NEXT_PUBLIC_SUPABASE_URL=<supabase url>
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=<supabase publishable key>
SUPABASE_SERVICE_ROLE_KEY=<supabase service role key>
SUPABASE_STORAGE_BUCKET=repelit
```

Command:

```bash
cd /path/to/SW
npm ci
npm run build
pm2 start npm --name swift-generation-worker -- run worker:generation
pm2 save
```

Cek dari dalam VPS:

```bash
curl http://127.0.0.1:4000/health
```

Cek dari luar:

```bash
curl http://8.215.40.119:4000/health
```

Kriteria lulus:

```txt
HTTP 200
status = healthy
worker.workerType = generation
worker.ready = true
queue.status = healthy
redis.ping = PONG
```

## 5. Update Vercel Env Ke VPS

Masalah:

```txt
Production masih memeriksa worker Railway.
```

Ubah Vercel production env:

```env
SWIFT_WORKER_HEALTH_URL=http://8.215.40.119:4000/health
SANDBOX_SERVICE_URL=http://8.215.40.119:3001
SANDBOX_SERVICE_TOKEN=<sama dengan worker dan sandbox>
SWIFT_GENERATION_EXECUTION_MODE=queue
SWIFT_DISABLE_SERVERLESS_GENERATION_FALLBACK=true
```

Setelah env berubah:

```txt
Redeploy Vercel production.
```

Kriteria lulus:

```txt
/api/worker/health menunjukkan workerService.endpoint = http://8.215.40.119:4000/health
workerService.status = healthy
```

## 6. Cek Production Health

Endpoint:

```txt
https://www.ai-swift.biz.id/api/health?refreshProvider=true
```

Kriteria lulus:

```txt
HTTP 200
status = healthy
database = ok
auth = ok
worker = ok
queue = ok
blockingFailures = []
```

Jika masih gagal, cek:

```txt
blockingFailures
degradedServices
providerHealth.message
sandboxRuntime.error
workerRuntime.endpoint
```

## 7. Test Prompt Kecil

Jalankan hanya setelah:

```txt
OpenRouter healthy
Worker VPS healthy
Sandbox Swift runtime healthy
Production health tidak blocked
```

Prompt test:

```txt
Buat landing page sederhana untuk toko kopi dengan hero, daftar menu, testimoni, dan tombol WhatsApp.
```

Kriteria lulus:

```txt
Job created
queueJobId ada
status queued -> running -> completed
Tidak SYSTEM_SATURATED
Tidak SWIFT_AI_PROVIDER_FAILOVER_EXHAUSTED
Tidak dead_lettered
```

## 8. Cek Artifact

Setelah job completed, cek:

```txt
Project files bertambah
Ada package.json
Ada app/layout.tsx
Ada app/page.tsx
Ada app/globals.css
Hasil bukan scaffold default
Artifact persisted
```

Kriteria lulus:

```txt
fileCount > 0
artifactStatus = persisted
previewFiles tersedia
```

## 9. Cek Preview Sandbox

Endpoint internal:

```txt
/api/projects/:id/sandbox
```

Kriteria lulus:

```txt
status = running atau ready
previewUrl ada
logs tidak berisi npm/build fatal
iframe preview tampil
```

Jika gagal:

```txt
Cek PM2 logs swift-sandbox-runtime
Cek disk space VPS
Cek npm install timeout
Cek build log sandbox
Cek auth token sama antara Vercel, worker, sandbox
```

## 10. Cek Preview Validation

Endpoint:

```txt
/api/projects/:id/validate-preview
```

Kriteria lulus:

```txt
status = passed
diagnosticsCount rendah atau 0
Tidak ada blocking error
```

## 11. Cek Deploy Vercel

Jalankan setelah preview valid.

Cek env:

```env
VERPRO_ACCES_TOKEN
VERDI_TEAM
DEPLOY_PROVIDER=vercel
```

Kriteria lulus:

```txt
GitHub status = ready
Vercel status = ready
Deployment URL muncul
Deployment bisa dibuka
```

## 12. Bersihkan Dead Letter Setelah Sistem Stabil

Saat ini monitoring menunjukkan:

```txt
failed = 20
deadLetter.waiting = 60
completed = 1
```

Jangan bersihkan dulu sebelum:

```txt
OpenRouter healthy
Worker VPS healthy
Sandbox runtime healthy
Prompt test completed minimal 1x
```

Setelah stabil:

```txt
Review dead-letter jobs
Replay yang masih relevan
Buang yang sudah lama / duplicate / test gagal
```

## Checklist Eksekusi

```txt
[ ] OpenRouter key limit diperbaiki
[ ] /api/provider/health HTTP 200
[ ] Sandbox VPS menjalankan services/sandbox-runtime/server.mjs
[ ] /health sandbox service = swift-sandbox-runtime
[ ] GET /sandbox/test-project bukan 404
[ ] POST /sandbox/test-project bukan 404
[ ] Worker generation VPS hidup di port 4000
[ ] /health worker VPS HTTP 200
[ ] Vercel env worker pindah dari Railway ke VPS
[ ] Vercel redeploy production
[ ] /api/health?refreshProvider=true HTTP 200
[ ] Prompt test completed
[ ] Artifact persisted
[ ] Preview URL muncul
[ ] Preview validation passed
[ ] Deploy Vercel berhasil
```

## Urutan Paling Aman

```txt
1. Perbaiki OpenRouter.
2. Deploy sandbox-runtime Swift di VPS port 3001.
3. Deploy worker generation di VPS port 4000.
4. Update Vercel env ke VPS.
5. Redeploy Vercel.
6. Cek production health.
7. Jalankan prompt test.
8. Cek artifact.
9. Cek preview.
10. Cek deploy.
11. Bersihkan dead-letter.
```
