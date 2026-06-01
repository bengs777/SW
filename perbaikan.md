# Perbaikan Lengkap Error Dedicated Worker Swift

Dokumen ini dibuat untuk memperbaiki error seperti:

- `Production generation must run in queue mode with a dedicated worker.`
- `Swift production sedang menunggu dedicated worker.`
- `Generation queue unavailable`
- `Redis/BullMQ generation queue is unavailable or rejected the job.`

Dokumen ini fokus ke akar masalah produksi Swift saat user membuat web, tetapi preview tidak jalan karena worker generasi, queue, atau sandbox belum sehat.

---

## 1. Ringkasan Masalah

Saat user klik generate, app utama tidak langsung membangun web di proses Next.js biasa. Swift production menggunakan arsitektur:

- App dashboard/API di Vercel
- Queue BullMQ di Redis
- Dedicated generation worker sebagai proses terpisah
- Sandbox runtime di Railway untuk install, build, dan preview

Kalau salah satu bagian ini tidak sehat, UI akan berhenti di status:

- menunggu worker,
- queue unavailable,
- preview kosong,
- atau retry terus tanpa hasil.

---

## 2. Diagnosis Paling Mungkin Untuk Error Ini

Berdasarkan struktur repo saat ini, akar error paling mungkin adalah kombinasi berikut:

### A. Production masih berjalan di mode yang salah

Swift production harus memakai:

```env
SWIFT_GENERATION_EXECUTION_MODE=queue
```

Kalau production masih memakai `serverless`, route generate akan menolak request dan memunculkan error dedicated worker.

### B. Dedicated worker belum benar-benar hidup

Repo ini memang sudah menyiapkan worker terpisah:

- script: `npm run worker:generation`
- entry: `workers/index.ts`
- Dockerfile: `workers/Dockerfile`
- Railway config: `railway.worker.json`

Tetapi kalau worker belum dideploy, crash saat boot, atau tidak bisa connect ke Redis, app tetap akan menganggap worker tidak sehat.

### C. Redis ada, tapi worker tidak bisa memakainya

BullMQ hanya bisa memakai Redis native:

```env
REDIS_URL=redis://... atau rediss://...
```

REST Redis saja tidak cukup untuk worker BullMQ.

### D. Sandbox Railway belum sehat atau belum tersambung

Walau queue sehat, Swift tetap butuh sandbox runtime untuk compile gate, build, dan preview. Jika sandbox mati, generate bisa tersimpan tetapi preview tidak jadi.

### E. App URL production masih belum benar

Untuk production, nilai seperti ini tidak boleh dipakai:

```env
NEXTAUTH_URL=http://localhost:3000
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

Kalau masih localhost, auth dan callback production bisa bermasalah walau bukan akar utama error worker.

---

## 3. Fakta Penting Dari Repo Saat Ini

Repo ini sebenarnya sudah siap untuk arsitektur yang benar:

- `app/api/generate/jobs/route.ts` sudah memaksa production memakai queue mode.
- `lib/queue/generation-queue.ts` sudah membaca health Redis, heartbeat worker, dan saturation queue.
- `workers/index.ts` sudah membuka endpoint health di `/health`.
- `workers/Dockerfile` memang dibuat khusus untuk worker queue.
- `railway.worker.json` sudah ada untuk deploy worker ke Railway.
- `services/sandbox-runtime/server.mjs` sudah punya endpoint `/health`.
- `app/api/worker/health/route.ts` sudah bisa membaca status queue dan heartbeat worker dari app utama.

Artinya, masalah ini bukan karena repo belum punya fondasi. Masalahnya lebih ke deploy dan konfigurasi runtime production.

---

## 4. Target Arsitektur Production Yang Benar

Swift production yang stabil harus dibagi seperti ini:

### Service 1 - App utama

- Platform: Vercel
- Fungsi: dashboard, auth, API, orchestration request

### Service 2 - Generation worker

- Platform: Railway atau VPS
- Fungsi: mengambil job BullMQ dari Redis dan menjalankan proses generasi

### Service 3 - Sandbox runtime

- Platform: Railway atau VPS
- Fungsi: install dependency, build, runtime smoke, dan preview app hasil generate

### Service 4 - Redis

- Platform: Redis Cloud, Upstash native Redis, atau provider Redis native lain
- Fungsi: queue BullMQ dan heartbeat worker

### Service 5 - Database

- Platform: Neon PostgreSQL
- Fungsi: persistence job, file, billing, dan history

---

## 5. Langkah Fix Lengkap

## Langkah 1 - Pastikan App Production Memakai Queue Mode

Di environment production app utama, set:

```env
NODE_ENV=production
SWIFT_GENERATION_EXECUTION_MODE=queue
SWIFT_DISABLE_SERVERLESS_GENERATION_FALLBACK=false
SWIFT_ALLOW_SERVERLESS_GENERATION_FALLBACK=true
```

Catatan:

- `SWIFT_GENERATION_EXECUTION_MODE=queue` adalah wajib.
- `SWIFT_ALLOW_SERVERLESS_GENERATION_FALLBACK=true` hanya berfungsi sebagai jaring pengaman, bukan mode utama.
- Jangan mengandalkan `SWIFT_ENABLE_GENERATION_WORKER=true` di Vercel. Repo ini sudah memberi warning bahwa worker BullMQ harus hidup sebagai proses terpisah, bukan di serverless runtime.

## Langkah 2 - Deploy Dedicated Worker Terpisah

Worker harus dijalankan sebagai service sendiri.

Pakai:

- `workers/Dockerfile`
- `railway.worker.json`
- command runtime: `npm run worker:generation`

Kalau deploy ke Railway:

1. Buat service baru dari repo yang sama.
2. Gunakan Dockerfile path `workers/Dockerfile`.
3. Gunakan health check `/health`.
4. Pastikan service restart otomatis saat gagal.

Environment minimum untuk worker:

```env
NODE_ENV=production
REDIS_URL=rediss://REPLACE_WITH_NATIVE_REDIS
DATABASE_URL=postgresql://REPLACE_WITH_POOLED_DB
DIRECT_DATABASE_URL=postgresql://REPLACE_WITH_DIRECT_DB
OPENROUTER_API_KEY=REPLACE_WITH_KEY
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_SITE_URL=https://your-domain.com
OPENROUTER_APP_NAME=Swift AI
SANDBOX_SERVICE_URL=https://your-sandbox-service.up.railway.app
SANDBOX_SERVICE_TOKEN=REPLACE_WITH_TOKEN
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=REPLACE_WITH_KEY
SUPABASE_SERVICE_ROLE_KEY=REPLACE_WITH_KEY
SUPABASE_STORAGE_BUCKET=REPLACE_WITH_BUCKET
SWIFT_GENERATION_EXECUTION_MODE=queue
SWIFT_DISABLE_SERVERLESS_GENERATION_FALLBACK=true
PORT=4000
```

Catatan:

- Worker tidak perlu jalan di Vercel.
- Worker harus bisa baca Redis, database, OpenRouter, dan sandbox service.
- Worker Dockerfile saat ini memang sudah memaksa `SWIFT_GENERATION_EXECUTION_MODE=queue`.

## Langkah 3 - Pastikan Redis Yang Dipakai Adalah Native Redis

Nilai yang benar:

```env
REDIS_URL=redis://... atau rediss://...
```

Yang salah untuk BullMQ:

```env
UPSTASH_REDIS_REST_URL=https://...
```

REST Redis boleh dipakai sebagai pelengkap, tetapi worker BullMQ tetap butuh `REDIS_URL` native.

Checklist Redis:

- URL pakai `redis://` atau `rediss://`
- bisa diakses dari Vercel app
- bisa diakses dari Railway worker
- tidak diblok firewall
- tidak memakai kredensial yang sudah lama atau salah

## Langkah 4 - Pastikan Sandbox Railway Hidup dan Bisa Diakses

App generate dan worker perlu sandbox service yang sehat.

Environment minimum sandbox:

```env
NODE_ENV=production
SANDBOX_SERVICE_TOKEN=REPLACE_WITH_TOKEN
SANDBOX_PUBLIC_BASE_URL=https://your-sandbox-service.up.railway.app
SWIFT_SANDBOX_ROOT=/tmp/swift-sandbox
SWIFT_SANDBOX_BASE_PORT=4300
SWIFT_SANDBOX_MAX_PROJECTS=12
SWIFT_SANDBOX_MAX_FILES=240
SWIFT_SANDBOX_MAX_TOTAL_BYTES=6291456
SWIFT_SANDBOX_MAX_FILE_BYTES=524288
SWIFT_SANDBOX_PROJECT_IDLE_TTL_MS=1800000
SWIFT_SANDBOX_PROCESS_MAX_UPTIME_MS=1200000
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=REPLACE_WITH_KEY
SUPABASE_SERVICE_ROLE_KEY=REPLACE_WITH_KEY
SUPABASE_STORAGE_BUCKET=REPLACE_WITH_BUCKET
```

Checklist sandbox:

- endpoint `/health` harus bisa diakses
- token sandbox cocok dengan app dan worker
- root sandbox bisa ditulis
- process build dan preview tidak crash saat install dependency

## Langkah 5 - Betulkan URL Production App

Untuk production, jangan biarkan:

```env
NEXTAUTH_URL=http://localhost:3000
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

Harus diganti ke domain production, contoh:

```env
NEXTAUTH_URL=https://ai-swift.biz.id
NEXT_PUBLIC_APP_URL=https://ai-swift.biz.id
```

Ini penting untuk:

- login
- callback auth
- link preview
- health readiness production

## Langkah 6 - Bersihkan Env Yang Berpotensi Membingungkan

Pastikan tidak ada env yang saling bertentangan.

Yang harus dicek:

- `SWIFT_GENERATION_EXECUTION_MODE` jangan `serverless`
- `SANDBOX_SERVICE_URL` jangan kosong
- `SANDBOX_SERVICE_TOKEN` harus cocok di app dan sandbox
- `REDIS_URL` jangan placeholder
- hapus baris sampah atau typo di file env

Kalau satu env salah, app bisa tetap boot tetapi generate akan gagal di tengah jalan.

---

## 6. Langkah Verifikasi Setelah Fix

Setelah env dan service dibetulkan, jalankan verifikasi ini.

### A. Verifikasi app utama

Jalankan:

```bash
npm run deploy:readiness
npm run audit:production
```

Target hasil:

- readiness tidak blokir env penting
- build, lint, typecheck hijau

### B. Verifikasi worker

Jalankan:

```bash
npm run worker:health
```

Atau akses endpoint:

```text
https://your-worker-service/health
```

Target hasil:

- status `healthy`
- mode `queue`
- endpoint merespons HTTP `200`

### C. Verifikasi dari app utama

Akses:

```text
https://your-app-domain/api/worker/health
https://your-app-domain/api/health?refreshProvider=true
```

Target hasil:

- worker tidak `missing`
- queue tidak `unhealthy`
- redis tidak error
- heartbeat worker masih fresh

### D. Verifikasi sandbox

Akses:

```text
https://your-sandbox-service/health
```

Target hasil:

- status `healthy` atau minimal `degraded` tanpa root error
- root sandbox ready
- service token dan runtime info valid

### E. Verifikasi generate end-to-end

Tes dengan prompt sederhana:

- landing page
- dashboard sederhana
- e-commerce sederhana

Target hasil:

- job masuk queue
- worker mengambil job
- preview tidak blank
- status pindah dari `queued` ke `preview_ready`

---

## 7. Matriks Error dan Tindakan

### Error: `Production generation must run in queue mode with a dedicated worker.`

Arti:

- production masih salah mode, atau
- sandbox/fallback tidak dianggap siap

Tindakan:

1. set `SWIFT_GENERATION_EXECUTION_MODE=queue`
2. redeploy app utama
3. pastikan dedicated worker hidup
4. pastikan `SANDBOX_SERVICE_URL` dan token terisi

### Error: `Generation queue unavailable`

Arti:

- Redis mati,
- kredensial Redis salah,
- atau queue tidak bisa enqueue

Tindakan:

1. cek `REDIS_URL`
2. cek koneksi worker ke Redis
3. cek health `api/worker/health`
4. restart worker setelah Redis sehat

### Error: `menunggu dedicated worker`

Arti:

- queue mode aktif,
- tetapi heartbeat worker belum sehat

Tindakan:

1. cek worker service Railway
2. cek log boot worker
3. cek endpoint `/health`
4. cek apakah worker crash saat load env, Prisma, atau Redis

### Error: preview kosong tetapi queue sukses

Arti:

- worker sudah memproses,
- tetapi sandbox build atau preview gagal

Tindakan:

1. cek sandbox `/health`
2. cek `SANDBOX_SERVICE_TOKEN`
3. cek build log sandbox
4. cek batas file, port, dan timeout sandbox

---

## 8. Urutan Deploy Yang Direkomendasikan

Supaya tidak bolak-balik error, deploy dengan urutan ini:

1. betulkan env app production
2. deploy sandbox Railway
3. deploy worker Railway
4. verifikasi worker health
5. verifikasi app health
6. verifikasi sandbox health
7. lakukan test generate end-to-end

Kalau app dideploy duluan tetapi worker belum hidup, UI akan tetap menunjukkan error dedicated worker walau kode sudah benar.

---

## 9. Checklist Selesai

Perbaikan dianggap selesai jika semua poin ini terpenuhi:

- `SWIFT_GENERATION_EXECUTION_MODE=queue` di production app
- dedicated worker hidup sebagai service terpisah
- `REDIS_URL` native Redis aktif
- sandbox Railway hidup dan sehat
- `SANDBOX_SERVICE_URL` dan token benar
- `NEXTAUTH_URL` dan `NEXT_PUBLIC_APP_URL` sudah domain production
- `/api/worker/health` tidak lagi menunjukkan worker missing
- generate prompt menghasilkan preview, bukan `No preview yet`

---

## 10. Catatan Penting Keamanan

Kalau credential production pernah tersebar di screenshot, chat, commit, atau file yang tidak aman, lakukan rotasi untuk:

- database
- Redis
- OpenRouter
- Supabase
- sandbox token
- Vercel deploy token
- auth secret

Ini tidak langsung memperbaiki error worker, tetapi wajib untuk production yang aman.

---

## 11. Kesimpulan Praktis

Error ini bukan berarti Swift tidak bisa generate web. Error ini berarti arsitektur production belum lengkap atau belum sinkron.

Fix utamanya adalah:

1. paksa production ke `queue mode`
2. hidupkan dedicated worker di Railway atau VPS
3. pastikan Redis native dan sandbox Railway sehat
4. verifikasi health endpoint sampai worker heartbeat kembali normal

Kalau empat hal ini benar, error dedicated worker akan hilang dan generate bisa kembali jalan normal.
