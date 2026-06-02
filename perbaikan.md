# Rencana Perbaikan Error Generate Swift AI

Tanggal audit: 2026-06-02 18:10 WIB

Dokumen ini fokus pada error UI terbaru:

```txt
Swift AI sedang mengalami gangguan sementara. Saldo Rupiah kamu otomatis dikembalikan jika generate gagal. Coba lagi sebentar lagi.
```

Error internal yang terlihat:

```txt
SWIFT_AI_PROVIDER_FAILOVER_EXHAUSTED
```

## Kesimpulan Singkat

Masalah sekarang bukan lagi Railway worker, Redis queue, sandbox runtime, database, auth, atau Vercel deploy.

Masalah sekarang ada di bagian:

```txt
AI Provider / OpenRouter model chain
```

Flow yang terjadi:

```txt
UI submit prompt
-> POST /api/generate/jobs sukses 202
-> job masuk queue
-> worker Railway mengambil job
-> worker memanggil OpenRouter/model chain
-> semua attempt provider gagal
-> job masuk dead-letter
-> UI menampilkan pesan gangguan sementara
```

## Status Infrastruktur

Production health sudah hijau dari sisi infrastruktur:

```txt
https://www.ai-swift.biz.id/api/health?refreshProvider=true
```

Target yang sudah tercapai:

- `status: healthy`
- `deployment: ok`
- `worker: ok`
- `queue: ok`
- `blockingFailures: []`
- `workerRuntime.ok: true`
- `workerHeartbeatFresh: true`
- `sandboxRuntime.ok: true`

Worker Railway sehat:

```txt
https://ingenious-appreciation-production.up.railway.app/health
```

Sandbox Railway sehat:

```txt
https://sanbox.ai-swift.biz.id/health
```

## Bukti Error Saat Ini

Vercel logs menunjukkan request generate berhasil diterima:

```txt
POST /api/generate/jobs -> 202
GET /api/generate/jobs/.../stream -> 200
frontend_notified
```

Runtime health menunjukkan job gagal di provider AI:

```txt
eventType: generation_failed
eventType: worker_failed
eventType: dead_lettered
reason: SWIFT_AI_PROVIDER_FAILOVER_EXHAUSTED
```

Provider health terakhir:

```txt
deepseek/deepseek-v4-pro = healthy
openai/gpt-oss-120b:free = degraded, 503 Provider returned error
```

Artinya fallback gratis sedang tidak stabil atau tidak tersedia untuk request ini.

## Area Yang Perlu Diperbaiki

### 1. Samakan Model Chain Di Vercel Dan Railway Worker

Karena generate berjalan di Railway worker, env AI harus benar di **dua tempat**:

```txt
Vercel Production
Railway service ingenious-appreciation
```

Cek variable berikut di Vercel dan Railway worker:

```txt
OPENROUTER_API_KEY
OPENROUTER_BASE_URL
SWIFT_AI_MODEL_CHAIN
SWIFT_PRIMARY_MODEL
SWIFT_FALLBACK_MODEL_1
SWIFT_FALLBACK_MODEL_2
SWIFT_FALLBACK_MODEL_3
OPENROUTER_MAX_TOKENS
AI_MAX_OUTPUT_TOKENS
AI_TIMEOUT_MS
AI_QUEUE_TIMEOUT_MS
SWIFT_GENERATION_JOB_TIMEOUT_MS
```

Prioritas:

- `OPENROUTER_API_KEY` harus aktif dan punya kuota.
- Jangan jadikan model yang sedang `503` sebagai fallback utama.
- Model chain di Vercel dan Railway worker harus sama.
- Setelah env berubah, redeploy Vercel dan restart/redeploy Railway worker.

### 2. Hapus Fallback Yang Sedang Bermasalah

Saat audit, model ini terdeteksi degraded:

```txt
openai/gpt-oss-120b:free
```

Untuk stabilisasi awal, jangan pakai model itu sebagai fallback production.

Opsi sementara:

```txt
SWIFT_AI_MODEL_CHAIN=openrouter:deepseek/deepseek-v4-pro
```

Atau gunakan beberapa model berbayar/stabil yang sudah kamu pastikan tersedia di OpenRouter dashboard.

Catatan:

- Satu model sehat lebih baik untuk test daripada chain panjang yang berisi fallback rusak.
- Setelah test berhasil, baru tambahkan fallback lain satu per satu.

### 3. Cek OpenRouter Dashboard

Masuk ke OpenRouter dashboard dan cek:

- API key aktif
- credit/limit masih cukup
- tidak kena rate limit
- model utama tersedia
- fallback model tersedia
- tidak ada pembatasan provider untuk model yang dipilih

Jika ada error quota/rate limit/provider unavailable, perbaiki di OpenRouter dulu sebelum replay job.

### 4. Cek Railway Worker Logs

Di Railway service:

```txt
ingenious-appreciation
```

Buka:

```txt
Deployments -> Deploy Logs
```

Cari log:

```txt
provider_attempt
provider_attempt_failed
provider_failover_exhausted
generation_provider_failover_exhausted
OpenRouter API error
rate_limit
timeout
server_error
invalid_output
```

Yang perlu dicatat:

- model mana yang gagal
- status code berapa
- alasan `failureReason`
- apakah gagal karena `503`, `timeout`, `rate_limit`, `auth`, atau `invalid_output`

### 5. Jangan Replay Dead-Letter Dulu

Saat audit terakhir ada job lama di dead-letter.

Jangan replay dulu selama provider/model chain belum stabil, karena job lama akan gagal ulang.

Urutan aman:

1. Benarkan model chain.
2. Restart/redeploy Railway worker.
3. Redeploy Vercel production.
4. Cek health production.
5. Jalankan prompt baru yang kecil.
6. Kalau prompt baru sukses, baru pertimbangkan replay dead-letter.

## Langkah Eksekusi Pelan-Pelan

### Langkah 1: Update Railway Worker Env

Buka Railway:

```txt
Project miraculous-caring -> service ingenious-appreciation -> Variables
```

Update atau tambahkan:

```txt
SWIFT_AI_MODEL_CHAIN=openrouter:deepseek/deepseek-v4-pro
```

Untuk sementara kosongkan/hapus fallback yang sedang bermasalah jika ada:

```txt
SWIFT_FALLBACK_MODEL_1
SWIFT_FALLBACK_MODEL_2
SWIFT_FALLBACK_MODEL_3
```

Pastikan tetap ada:

```txt
OPENROUTER_API_KEY
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
AI_TIMEOUT_MS=500000
AI_QUEUE_TIMEOUT_MS=500000
SWIFT_GENERATION_JOB_TIMEOUT_MS=500000
OPENROUTER_MAX_TOKENS=16000
AI_MAX_OUTPUT_TOKENS=16000
```

Lalu redeploy/restart worker.

### Langkah 2: Update Vercel Env

Buka Vercel:

```txt
Project sw -> Settings -> Environment Variables -> Production
```

Samakan:

```txt
SWIFT_AI_MODEL_CHAIN=openrouter:deepseek/deepseek-v4-pro
```

Pastikan:

```txt
SWIFT_WORKER_HEALTH_URL=https://ingenious-appreciation-production.up.railway.app/health
SANDBOX_SERVICE_URL=https://sanbox.ai-swift.biz.id
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
```

Lalu redeploy production.

### Langkah 3: Cek Health

Buka:

```txt
https://www.ai-swift.biz.id/api/health?refreshProvider=true
```

Target:

```txt
status=healthy
blockingFailures=[]
workerRuntime.ok=true
sandboxRuntime.ok=true
providers.status=healthy
```

Jika provider masih degraded, jangan lanjut ke replay dead-letter.

### Langkah 4: Test Prompt Baru

Jangan pakai job lama. Buat prompt kecil:

```txt
Buat landing page toko sepatu dengan hero, produk unggulan, dan CTA checkout sederhana.
```

Target sukses:

- draft files muncul di editor
- preview tidak hanya scaffold kosong
- error log tidak menampilkan `SWIFT_AI_PROVIDER_FAILOVER_EXHAUSTED`
- preview validation bisa jalan setelah file tersedia

### Langkah 5: Jika Masih Gagal

Jika prompt baru masih gagal, ambil log dari Railway worker:

```txt
Deploy Logs -> cari provider_attempt_failed
```

Lalu catat:

```txt
model
failureReason
statusCode
message
```

Kemungkinan perbaikan lanjutan:

- jika `auth`: rotasi/perbaiki `OPENROUTER_API_KEY`
- jika `rate_limit`: tambah credit/limit atau turunkan concurrency
- jika `server_error` atau `503`: ganti model/fallback
- jika `timeout`: kurangi ukuran output atau tambah timeout
- jika `invalid_output`: perlu patch prompt/validator agar output model lebih mudah diparse

## Checklist

- [x] Worker Railway online
- [x] Worker `/health` healthy
- [x] Worker heartbeat fresh
- [x] Queue Redis healthy
- [x] Sandbox `/health` healthy
- [x] Production health tidak blocked
- [x] Template `.env.railway.worker.production` diisi dengan model chain stabil
- [x] Template `.env.railway.production` diisi dengan custom domain sandbox sehat
- [x] Template `.env.example` diisi sebagai checklist Vercel Production
- [x] File env lokal ignored diselaraskan agar tidak memakai fallback gratis bermasalah
- [ ] Set model chain stabil di Railway worker
- [ ] Set model chain stabil di Vercel production
- [ ] Redeploy/restart Railway worker
- [ ] Redeploy Vercel production
- [ ] Cek provider health
- [ ] Test prompt baru
- [ ] Audit Railway worker logs jika provider masih failover
- [ ] Replay dead-letter hanya setelah prompt baru sukses

## Catatan Keamanan

Beberapa secret pernah terlihat di layar/chat. Setelah production stabil, rotasi:

- OpenRouter API key
- Redis password
- Neon database password
- Supabase service role key
- Sandbox service token

Jangan commit file lokal berisi secret:

```txt
.env
.env.production
.env.railway.production.local
.env.railway.worker.production.local
```
