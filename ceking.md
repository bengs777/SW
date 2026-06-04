# Planning Pengecekan Alur Pembuatan Web Swift AI

Target akhir:

```txt
User kirim prompt
-> Job dibuat
-> Masuk Redis queue
-> Worker VPS ambil job
-> OpenRouter generate kode
-> Artifact tersimpan
-> Sandbox VPS build dan preview
-> Preview valid
-> Deploy Vercel berhasil
```

## 1. Cek Env Production

Cek di Vercel dan VPS:

```env
OPENROUTER_API_KEY
REDIS_URL
SWIFT_GENERATION_EXECUTION_MODE=queue
SWIFT_DISABLE_SERVERLESS_GENERATION_FALLBACK=true
SWIFT_WORKER_HEALTH_URL=http://8.215.40.119:4000/health
SANDBOX_SERVICE_URL=http://8.215.40.119:3001
SANDBOX_SERVICE_TOKEN
NEXT_PUBLIC_SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
SUPABASE_STORAGE_BUCKET
VERDI_TEAM
```

Kriteria lulus:

```txt
Tidak ada dummy
Tidak ada localhost untuk production Vercel
Worker health mengarah ke VPS, bukan Railway
Sandbox service mengarah ke 8.215.40.119:3001
```

## 2. Cek OpenRouter

Endpoint:

```txt
https://www.ai-swift.biz.id/api/provider/health
```

Kriteria lulus:

```txt
HTTP 200
status = healthy
Tidak ada "Key limit exceeded"
Tidak ada 401/403/402
```

Kalau gagal:

```txt
Top up credit OpenRouter
Naikkan total limit key
Ganti OPENROUTER_API_KEY dengan key aktif
Redeploy Vercel + restart worker
```

## 3. Cek Redis Queue

Endpoint:

```txt
https://www.ai-swift.biz.id/api/worker/health
https://www.ai-swift.biz.id/api/production/monitoring
```

Kriteria lulus:

```txt
queue = healthy
redis.ping = PONG
waiting tidak naik terus
active tidak stuck lama
failed tidak bertambah saat test baru
```

Catat:

```txt
waiting
active
failed
completed
deadLetter.waiting
workerHeartbeat.ageMs
```

## 4. Cek Worker VPS

Cek dari luar:

```txt
http://8.215.40.119:4000/health
```

Cek dari dalam VPS:

```bash
pm2 status
pm2 logs swift-generation-worker
curl http://127.0.0.1:4000/health
```

Kriteria lulus:

```txt
HTTP 200
status = healthy
worker.workerType = generation
queue.status = healthy
worker ready = true
```

Kalau belum:

```bash
cd /path/to/SW
npm ci
npm run build
pm2 start npm --name swift-generation-worker -- run worker:generation
pm2 save
```

## 5. Cek Sandbox VPS

Cek health:

```txt
http://8.215.40.119:3001/health
```

Kriteria lulus yang benar:

```json
{
  "status": "healthy",
  "ok": true,
  "service": "swift-sandbox-runtime",
  "runtime": {
    "rootReady": true,
    "storage": {}
  }
}
```

Kalau yang muncul cuma:

```json
{"ok":true,"service":"sandbox","port":"3001"}
```

berarti salah service, belum runtime Swift.

Cek kontrak endpoint:

```bash
curl -H "Authorization: Bearer TOKEN" http://8.215.40.119:3001/sandbox/test-project
curl -X POST http://8.215.40.119:3001/sandbox/test-project \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"files":[]}'
```

Kriteria lulus:

```txt
GET /sandbox/:projectId tidak 404
POST /sandbox/:projectId tidak 404
Jika payload kosong, boleh error validasi, tapi bukan Cannot POST
```

## 6. Cek Production Health

Endpoint:

```txt
https://www.ai-swift.biz.id/api/health?refreshProvider=true
```

Kriteria lulus:

```txt
HTTP 200
status = healthy atau ready
database = ok
auth = ok
worker = ok
queue = ok
blockingFailures = []
```

Jika masih gagal, lihat:

```txt
blockingFailures
degradedServices
providerHealth.message
sandboxRuntime.error
workerRuntime.endpoint
```

## 7. Cek Job Creation

Dari UI Swift:

```txt
Login
Buka dashboard
Buat project baru
Kirim prompt kecil
```

Prompt test:

```txt
Buat landing page sederhana untuk toko kopi dengan hero, daftar menu, testimoni, dan tombol WhatsApp.
```

Kriteria lulus awal:

```txt
Job dibuat
Status masuk queued/running
Tidak langsung failed
Tidak stuck "SYSTEM_SATURATED"
Tidak stuck active > 5 menit
```

## 8. Cek Event Job

Di database, cek job terbaru:

```txt
status
stage
orchestrationState
queueJobId
error
createdAt
updatedAt
failedAt
completedAt
```

Kriteria lulus:

```txt
Ada queueJobId
Event sampai provider_called
Setelah provider_called lanjut files.updated / artifact saved
Tidak berhenti di SWIFT_AI_PROVIDER_FAILOVER_EXHAUSTED
```

## 9. Cek Artifact / Files

Setelah job completed, cek:

```txt
Project files bertambah
Ada package.json
Ada app/layout.tsx
Ada app/page.tsx
Ada app/globals.css
Hasil bukan scaffold default
```

Kriteria lulus:

```txt
fileCount > 0
artifactStatus = persisted
previewFiles tersedia
```

## 10. Cek Preview Sandbox

Dari UI klik atau lihat preview.

Endpoint internal app:

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

Kalau gagal:

```txt
Cek POST /sandbox/:projectId ke VPS
Cek logs sandbox PM2
Cek disk space VPS
Cek npm install/build timeout
```

## 11. Cek Preview Validation

Klik validasi preview atau endpoint:

```txt
/api/projects/:id/validate-preview
```

Kriteria lulus:

```txt
status = passed
diagnosticsCount rendah atau 0
Tidak ada blocking error
```

## 12. Cek Deploy GitHub / Vercel

Setelah preview valid:

```txt
Push GitHub
Deploy Vercel
```

Kriteria lulus:

```txt
GitHub status = ready
Vercel status = ready
Deployment URL muncul
Deployment bisa dibuka
```

Cek env deploy:

```env
VERPRO_ACCES_TOKEN
VERDI_TEAM
DEPLOY_PROVIDER=vercel
```

## 13. Cek UX Loading

Saat job gagal, UI harus jelas menampilkan error.

Kriteria lulus:

```txt
Tidak loading selamanya
Kalau provider gagal, tampil pesan jelas
Kalau sandbox gagal, tampil alasan jelas
Tombol retry muncul
Saldo/refund jelas
```

## Urutan Eksekusi Yang Disarankan

```txt
1. OpenRouter sehat dulu
2. Sandbox VPS ganti ke swift-sandbox-runtime
3. Worker VPS hidup di port 4000
4. Vercel env arahkan worker ke VPS
5. Production health harus hilang blockingFailures
6. Test prompt kecil
7. Cek artifact
8. Cek preview
9. Cek deploy
10. Bersihkan dead-letter lama setelah sistem stabil
```

## Checklist Cepat

```txt
[ ] /api/provider/health HTTP 200
[ ] /api/worker/health worker endpoint sudah VPS
[ ] http://8.215.40.119:4000/health HTTP 200
[ ] http://8.215.40.119:3001/health service swift-sandbox-runtime
[ ] GET /sandbox/test-project bukan 404
[ ] POST /sandbox/test-project bukan 404
[ ] /api/health?refreshProvider=true tidak ada blockingFailures
[ ] Prompt test completed
[ ] Artifact persisted
[ ] Preview URL muncul
[ ] Deploy Vercel berhasil
```
