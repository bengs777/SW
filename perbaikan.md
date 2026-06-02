# Rencana Perbaikan Swift AI Production

Tanggal audit: 2026-06-02

Dokumen ini merangkum error yang terlihat di dashboard Swift, log yang sudah dikirim, dan langkah perbaikan sampai production siap dites ulang.

## Ringkasan Kondisi

Error utama di UI:

```txt
Swift AI sedang mengalami gangguan sementara. Saldo Rupiah kamu otomatis dikembalikan jika generate gagal. Coba lagi sebentar lagi.
```

Pesan ini biasanya muncul ketika worker gagal menyelesaikan request AI sampai semua percobaan provider habis:

```txt
SWIFT_AI_PROVIDER_FAILOVER_EXHAUSTED
```

Log yang terakhir dikirim bukan log Railway, tetapi log Vercel. Dari log Vercel, sisi web/API terlihat sehat:

```txt
POST /api/generate/jobs -> 202
GET /api/generate/jobs/.../stream -> 200
GET /api/generate/jobs/.../draft -> 200
GET /api/models -> 200
GET /api/projects/... -> 200
GET /api/auth/session -> 200
```

Artinya tombol generate, API Vercel, session, stream, dan draft endpoint berjalan. Masalah tersisa paling mungkin ada di worker Railway saat memanggil OpenRouter/model AI.

## Daftar Hal Yang Perlu Diperbaiki

### 1. Ambil Log Railway Worker Yang Benar

Status: belum selesai.

Yang dibutuhkan sekarang adalah log dari service:

```txt
Railway -> ingenious-appreciation -> Deployments -> Deploy Logs
```

Cari kata berikut:

```txt
provider_attempt_failed
provider_failover_exhausted
generation_provider_failover_exhausted
OpenRouter API error
rate_limit
timeout
server_error
invalid_output
```

Kemungkinan arti error:

- `401` atau `403`: OpenRouter API key salah, expired, atau tidak punya akses.
- `429`: rate limit atau credit OpenRouter habis.
- `503`: model/provider OpenRouter sedang down.
- `timeout`: model terlalu lama menjawab.
- `invalid_output`: model menjawab, tetapi format output tidak valid untuk parser Swift.

### 2. Pastikan Env Worker Railway Sudah Benar

Status: perlu dicek ulang di dashboard Railway.

Service:

```txt
ingenious-appreciation
```

File lokal acuan:

```txt
.env.railway.worker.production
```

Nilai penting yang harus ada:

```txt
SWIFT_AI_MODEL_CHAIN=openrouter:deepseek/deepseek-v4-pro
SWIFT_PRIMARY_MODEL=deepseek/deepseek-v4-pro
SWIFT_AI_FREE_MODE=false
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
SANDBOX_SERVICE_URL=https://sanbox.ai-swift.biz.id
SANDBOX_PUBLIC_BASE_URL=https://sanbox.ai-swift.biz.id
```

Nilai yang jangan dipakai dulu:

```txt
SWIFT_FALLBACK_MODEL_1
SWIFT_FALLBACK_MODEL_2
SWIFT_FALLBACK_MODEL_3
OPENROUTER_FREE_MODEL
```

Kenapa:

- Fallback free model sebelumnya pernah terdeteksi `503`.
- Untuk stabilisasi, gunakan satu model yang sehat dulu.
- Setelah prompt kecil sukses, fallback bisa ditambahkan satu per satu.

### 3. Pastikan Env Sandbox Railway Sudah Benar

Status: perlu dicek ulang di dashboard Railway.

Service:

```txt
SW
```

File lokal acuan:

```txt
.env.railway.production
```

Nilai penting:

```txt
PORT=8080
SANDBOX_PUBLIC_BASE_URL=https://sanbox.ai-swift.biz.id
SWIFT_SANDBOX_ROOT=/data/swift-sandbox
SWIFT_SANDBOX_BASE_PORT=4300
```

Cek health:

```txt
https://sanbox.ai-swift.biz.id/health
```

Target:

```txt
healthy
storage ok
rootReady true
```

### 4. Pastikan Env Vercel Production Sudah Benar

Status: perlu dicek ulang di dashboard Vercel.

File lokal acuan:

```txt
.env.production
```

Nilai penting:

```txt
SWIFT_GENERATION_EXECUTION_MODE=queue
SWIFT_DISABLE_SERVERLESS_GENERATION_FALLBACK=true
SWIFT_WORKER_HEALTH_URL=https://ingenious-appreciation-production.up.railway.app/health
SANDBOX_SERVICE_URL=https://sanbox.ai-swift.biz.id
SWIFT_AI_MODEL_CHAIN=openrouter:deepseek/deepseek-v4-pro
SWIFT_AI_FREE_MODE=false
```

Cek health:

```txt
https://www.ai-swift.biz.id/api/health?refreshProvider=true
```

Target:

```txt
status: healthy
blockingFailures: []
workerRuntime.ok: true
sandboxRuntime.ok: true
```

### 5. Investigasi Badge Warning Di Railway Worker

Status: perlu dicek.

Di screenshot Railway, service `ingenious-appreciation` online tetapi ada badge warning `1`.

Yang harus dibuka:

```txt
Railway -> ingenious-appreciation -> Deployments / Metrics / Logs
```

Kemungkinan penyebab:

- Healthcheck pernah gagal saat deploy.
- Service punya failed job/dead-letter.
- Env berubah tetapi belum redeploy.
- Runtime warning dari worker.
- Resource/plan warning.

Catat isi warning sebelum melakukan replay job lama.

### 6. Jangan Replay Dead-Letter Sebelum Prompt Baru Sukses

Status: wajib diikuti.

Jika ada job lama di dead-letter, jangan replay dulu.

Urutan aman:

1. Betulkan env.
2. Redeploy worker.
3. Redeploy sandbox jika env sandbox berubah.
4. Redeploy Vercel.
5. Test prompt baru kecil.
6. Jika prompt baru sukses, baru urus dead-letter.

Kenapa:

- Job lama bisa gagal ulang karena memakai kondisi provider/env lama.
- Replay sebelum provider stabil akan menambah noise di log.

### 7. Cek OpenRouter Dashboard

Status: perlu dicek jika worker log menunjukkan provider error.

Cek:

- API key aktif.
- Credit cukup.
- Tidak kena rate limit.
- Model `deepseek/deepseek-v4-pro` tersedia.
- Tidak ada pembatasan provider.

Jika worker log menunjukkan:

```txt
rate_limit
quota
insufficient credits
provider unavailable
```

Maka perbaikan dilakukan di OpenRouter, bukan di kode.

### 8. Security Cleanup Setelah Stabil

Status: setelah production sukses.

Beberapa secret pernah terlihat di file/chat/screenshot. Setelah production stabil, rotasi:

- OpenRouter API key
- Redis password
- Neon database password
- Supabase service role key
- Sandbox service token
- Token deploy Vercel jika masih dipakai

Pastikan file env tetap tidak masuk Git:

```txt
git ls-files -- .env*
```

Output harus kosong.

## Rencana Eksekusi Berurutan

### Langkah 1: Redeploy Dengan Env Terbaru

Lakukan:

1. Paste `.env.railway.worker.production` ke Railway `ingenious-appreciation`.
2. Paste `.env.railway.production` ke Railway `SW`.
3. Paste `.env.production` ke Vercel Production.
4. Apply changes / redeploy semua service.

Urutan redeploy:

```txt
Railway ingenious-appreciation
Railway SW
Vercel Production
```

### Langkah 2: Cek Health

Buka:

```txt
https://ingenious-appreciation-production.up.railway.app/health
https://sanbox.ai-swift.biz.id/health
https://www.ai-swift.biz.id/api/health?refreshProvider=true
```

Target:

```txt
worker healthy
sandbox healthy
production blockingFailures kosong
```

### Langkah 3: Test Prompt Baru Kecil

Gunakan prompt baru, jangan retry job lama:

```txt
Buat landing page toko sepatu dengan hero, produk unggulan, dan CTA checkout sederhana.
```

Target sukses:

- Error log tidak bertambah.
- File hasil generate muncul.
- Preview bukan hanya scaffold.
- Sandbox validation bisa berjalan.

### Langkah 4: Jika Masih Gagal, Ambil Log Worker

Ambil dari:

```txt
Railway -> ingenious-appreciation -> Deployments -> Deploy Logs
```

Kirim bagian yang mengandung:

```txt
provider_attempt_failed
provider_failover_exhausted
OpenRouter API error
```

Catat:

```txt
model
statusCode
failureReason
message
jobId
traceId
```

### Langkah 5: Perbaiki Berdasarkan Kategori Error

Jika `auth` / `401` / `403`:

- Rotasi OpenRouter key.
- Update key di Vercel dan Railway worker.
- Redeploy worker.

Jika `rate_limit` / `429`:

- Tambah credit/limit OpenRouter.
- Turunkan `SWIFT_GENERATION_WORKER_CONCURRENCY` ke `1` sementara.

Jika `server_error` / `503`:

- Model sedang bermasalah.
- Tunggu atau ganti model chain ke model OpenRouter yang sehat.
- Jangan pakai fallback free yang sedang degraded.

Jika `timeout`:

- Kurangi output request.
- Turunkan concurrency.
- Pertahankan timeout besar.

Jika `invalid_output`:

- Perlu patch prompt/parser/validator.
- Simpan raw output dan failure artifact untuk audit.

## Checklist

- [x] Tambahkan audit env lokal/Vercel/Railway tanpa mencetak secret
- [x] Tambahkan log detail saat provider failover habis
- [x] Sesuaikan regression contract agar file `.env*` tetap local-only dan tidak wajib di-track Git
- [ ] Ambil log Railway worker yang benar dari `ingenious-appreciation`
- [ ] Pastikan env worker Railway sudah sama dengan `.env.railway.worker.production`
- [ ] Pastikan env sandbox Railway sudah sama dengan `.env.railway.production`
- [ ] Pastikan env Vercel Production sudah sama dengan `.env.production`
- [ ] Redeploy Railway worker
- [ ] Redeploy Railway sandbox
- [ ] Redeploy Vercel Production
- [ ] Cek `/health` worker
- [ ] Cek `/health` sandbox
- [ ] Cek `/api/health?refreshProvider=true`
- [ ] Test prompt baru kecil
- [ ] Jika masih gagal, audit `provider_attempt_failed` dari Railway worker
- [ ] Setelah sukses, baru urus dead-letter lama
- [ ] Setelah stabil, rotasi semua secret yang pernah terlihat
