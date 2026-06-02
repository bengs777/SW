# Update Investigasi Error Swift AI

Tanggal: 2026-06-02

Dokumen ini merangkum semua data investigasi terbaru dari screenshot dashboard, log Vercel, log Railway, dan console browser.

## 1. Error Utama Di UI

Pesan yang muncul di dashboard:

```txt
Swift AI sedang mengalami gangguan sementara. Saldo Rupiah kamu otomatis dikembalikan jika generate gagal. Coba lagi sebentar lagi.
```

Makna teknis:

```txt
SWIFT_AI_PROVIDER_FAILOVER_EXHAUSTED
```

Artinya worker sudah mencoba memanggil provider AI, tetapi semua attempt gagal sampai failover habis.

## 2. Data Dari Screenshot Dashboard

Yang terlihat:

```txt
Error Log: 2
Retry with repair
Retry prompt
Preview masih menampilkan scaffold
Draft sudah bisa diedit, tapi Push/Deploy final menunggu sandbox verified
```

Preview yang tampil:

```txt
Swift scaffold ready
Your app is ready for scoped generation.
```

Kesimpulan screenshot:

- Draft/generate sudah pernah berjalan sebagian.
- Preview belum menampilkan hasil landing page final.
- UI masih memakai scaffold awal.
- Deploy belum bisa final karena sandbox belum verified.
- Error utama tetap berasal dari provider/generation, bukan dari tombol UI.

## 3. Data Dari Log Vercel

Log Vercel menunjukkan sisi web/API sehat.

Bukti:

```txt
POST /api/generate/jobs -> 202
GET /api/generate/jobs/.../stream -> 200
GET /api/generate/jobs/.../draft -> 200
GET /api/models -> 200
GET /api/projects/... -> 200
GET /api/auth/session -> 200
```

Ada juga:

```txt
frontend_notified
ai_warmup_cycle
openRouterOk: true
consecutiveFailures: 0
```

Kesimpulan log Vercel:

- Vercel menerima request generate.
- Queue/draft/stream endpoint merespons.
- Session/auth tidak bermasalah.
- Dashboard tidak error 500.
- Masalah tidak berada di route Vercel utama.
- Log Vercel tidak cukup untuk melihat penyebab provider gagal, karena generate diproses di Railway worker.

## 4. Data Dari Log Railway Worker

Log Railway yang dikirim:

```txt
provider_attempt_failed
provider_failover_exhausted
generation_provider_failover_exhausted
```

Timestamp yang terlihat:

```txt
2026-06-02T11:29:47Z
2026-06-02T11:29:49Z
2026-06-02T11:34:56Z
2026-06-02T12:00:42Z
2026-06-02T12:01:13Z
2026-06-02T12:01:43Z
2026-06-02T12:02:27Z
2026-06-02T12:02:54Z
2026-06-02T12:03:29Z
```

Waktu `12:00-12:03Z` sama dengan sekitar `19:00-19:03 WIB`, cocok dengan waktu error di dashboard.

Kesimpulan log Railway:

- Worker `ingenious-appreciation` berjalan.
- Worker menerima job generate.
- Worker mencoba memanggil provider AI/OpenRouter.
- Setiap attempt provider gagal.
- Setelah semua attempt habis, muncul `provider_failover_exhausted`.
- Orchestrator lalu mencatat `generation_provider_failover_exhausted`.
- UI menampilkan pesan gangguan sementara.

Yang belum terlihat dari log Railway:

```txt
failureReason
statusCode
model
error
requestId
latencyMs
lastAttempt
attempts
```

Data ini masih perlu diambil dari full/raw log Railway, bukan hanya daftar event.

## 5. Data Dari Console Browser

Console browser berisi beberapa kategori.

### Noise Dari Browser Extension

```txt
contentscript.js MaxListenersExceededWarning
ObjectMultiplex - orphaned data
ObjectMultiplex - malformed chunk
Nightly Wallet Injected Successfully
```

Kesimpulan:

- Ini berasal dari extension/wallet browser.
- Bukan error utama Swift.
- Bisa diabaikan untuk investigasi generate.

### Warning Model Chain

Console menampilkan:

```txt
[swift-ai] SWIFT_AI_MODEL_CHAIN is empty; using default OpenRouter model chain.
```

Kemungkinan arti:

- Vercel Production belum punya env `SWIFT_AI_MODEL_CHAIN`, atau belum redeploy setelah env ditambah.
- Atau warning ini berasal dari client bundle yang tidak bisa membaca env server.

Tetap perlu dicek di Vercel:

```txt
SWIFT_AI_MODEL_CHAIN=openrouter:deepseek/deepseek-v4-pro
SWIFT_AI_FREE_MODE=false
```

### Draft Berhasil Dimuat

Console menunjukkan:

```txt
streamed_draft_fetch_requested
generation_draft_loaded
fileCount: 13
```

File yang terlihat di draft:

```txt
app/globals.css
app/layout.tsx
app/page.tsx
component-registry/dashboard-card.tsx
component-registry/feature-section.tsx
component-registry/footer.tsx
component-registry/hero.tsx
component-registry/navbar.tsx
component-registry/pricing.tsx
component-registry/testimonial.tsx
package.json
tailwind.config.ts
tsconfig.json
```

Kesimpulan:

- Draft artifact berhasil dibuat/dimuat.
- UI menerima 13 file.
- Generate tidak sepenuhnya kosong.

### Preview Masih Scaffold

Console juga menampilkan:

```txt
FINAL_EXECUTED_MODULE app/page.tsx
Swift scaffold ready
Your app is ready for scoped generation.
```

Kesimpulan:

- Preview yang dieksekusi masih scaffold default.
- Draft 13 file belum menggantikan preview final.
- Bisa terjadi karena provider failover membuat pipeline tidak sampai tahap final/sandbox verified.

### Warning Tailwind CDN

Console menampilkan:

```txt
cdn.tailwindcss.com should not be used in production
```

Kesimpulan:

- Ini warning dari preview/generated app.
- Bukan penyebab provider failover.
- Bisa diperbaiki belakangan setelah generate utama stabil.

## 6. Status Env Yang Sudah Disiapkan

File lokal acuan:

```txt
.env
.env.production
.env.railway.worker.production
.env.railway.production
```

Nilai penting yang sudah disiapkan:

```txt
SWIFT_AI_MODEL_CHAIN=openrouter:deepseek/deepseek-v4-pro
SWIFT_AI_FREE_MODE=false
SANDBOX_SERVICE_URL=https://sanbox.ai-swift.biz.id
SANDBOX_PUBLIC_BASE_URL=https://sanbox.ai-swift.biz.id
SWIFT_GENERATION_EXECUTION_MODE=queue
SWIFT_DISABLE_SERVERLESS_GENERATION_FALLBACK=true
```

Nilai yang tidak boleh dipakai dulu:

```txt
SWIFT_FALLBACK_MODEL_1
SWIFT_FALLBACK_MODEL_2
SWIFT_FALLBACK_MODEL_3
OPENROUTER_FREE_MODEL
```

Catatan:

- File env tidak boleh di-upload ke GitHub.
- `git ls-files -- .env*` harus kosong.

## 7. Kemungkinan Penyebab Berdasarkan Data

Paling mungkin:

```txt
OpenRouter/provider/model gagal saat worker menjalankan generation.
```

Kategori penyebab yang perlu dibuktikan dari full raw Railway log:

```txt
401/403 = API key OpenRouter salah, expired, atau akses ditolak
402/429 = credit/rate limit OpenRouter bermasalah
503/5xx = model/provider OpenRouter sedang down
timeout = model terlalu lama menjawab
invalid_output = model menjawab tetapi format output gagal diparse
```

Kemungkinan tambahan:

- Vercel belum redeploy setelah env `SWIFT_AI_MODEL_CHAIN` ditambahkan.
- Railway worker belum redeploy dari commit diagnostics terbaru.
- Concurrency worker terlalu tinggi untuk kondisi provider/limit saat ini.
- Preview masih scaffold karena pipeline gagal sebelum sandbox verified.

## 8. Commit Diagnostics Terbaru

Commit yang sudah dipush:

```txt
2558edc Add production provider diagnostics
```

Fungsi commit ini:

- Menambah log detail saat provider failover habis.
- Menambah audit env production.
- Memastikan env file tetap local-only dan tidak di-track Git.

Jika Railway worker belum memakai commit ini, log bisa terlihat hanya event name tanpa metadata detail.

## 9. Langkah Perbaikan Yang Disarankan

### Langkah 1: Pastikan Vercel Env Dan Redeploy

Di Vercel Production, pastikan:

```txt
SWIFT_AI_MODEL_CHAIN=openrouter:deepseek/deepseek-v4-pro
SWIFT_AI_FREE_MODE=false
SANDBOX_SERVICE_URL=https://sanbox.ai-swift.biz.id
SWIFT_WORKER_HEALTH_URL=https://ingenious-appreciation-production.up.railway.app/health
```

Lalu redeploy Vercel Production.

### Langkah 2: Turunkan Concurrency Worker Sementara

Di Railway `ingenious-appreciation`, ubah sementara:

```txt
SWIFT_GENERATION_WORKER_CONCURRENCY=1
AI_MAX_CONCURRENT_GENERATIONS=1
```

Lalu redeploy worker.

Alasan:

- Jika penyebabnya rate limit/credit pressure, concurrency lebih rendah membuat diagnosis lebih bersih.
- Setelah stabil, nilai bisa dinaikkan lagi.

### Langkah 3: Pastikan Worker Memakai Commit Terbaru

Di Railway `ingenious-appreciation`:

```txt
Deployments -> cek commit/source terbaru
```

Pastikan sudah memakai commit:

```txt
2558edc
```

Atau commit yang lebih baru.

### Langkah 4: Test Prompt Baru

Jangan retry job lama dulu.

Gunakan prompt kecil:

```txt
Buat landing page toko sepatu dengan hero, produk unggulan, dan CTA checkout sederhana.
```

Target:

- Tidak ada error log baru.
- Preview bukan scaffold.
- Draft file muncul.
- Sandbox validation berjalan.

### Langkah 5: Jika Masih Gagal, Ambil Full Raw Log Railway

Ambil full/raw log dari:

```txt
Railway -> ingenious-appreciation -> Deployments -> Deploy Logs
```

Cari:

```txt
provider_attempt_failed
provider_failover_exhausted
```

Kirim baris lengkap yang berisi:

```txt
failureReason
statusCode
model
error
requestId
latencyMs
lastAttempt
attempts
```

## 10. Checklist Lanjutan

- [ ] Pastikan Vercel Production punya `SWIFT_AI_MODEL_CHAIN`
- [ ] Redeploy Vercel Production
- [ ] Turunkan worker concurrency ke `1`
- [ ] Redeploy Railway `ingenious-appreciation`
- [ ] Pastikan Railway worker memakai commit `2558edc` atau lebih baru
- [ ] Test prompt baru kecil
- [ ] Ambil full raw log provider jika masih gagal
- [ ] Jangan replay dead-letter lama sampai prompt baru sukses
- [ ] Setelah stabil, rotasi semua secret yang pernah terlihat

## 11. Audit Lanjutan Dari Kode Lokal

Waktu audit lokal: `2026-06-02`.

Status repo lokal:

```txt
HEAD = 2558edc Add production provider diagnostics
```

Artinya source lokal memang sudah berada di commit diagnostics yang disebut di bagian sebelumnya.

### Hasil Command Lokal

Audit env production:

```txt
npm run audit:production-env
```

Hasil:

```txt
PASS semua check
```

Yang terkonfirmasi:

- `.env`, `.env.production`, `.env.railway.worker.production`, dan `.env.railway.production` ada.
- Tidak ada duplicate env key.
- `.env.production` memakai queue mode.
- Serverless generation fallback disabled.
- Worker health URL mengarah ke Railway worker.
- Sandbox URL memakai domain `https://sanbox.ai-swift.biz.id`.
- Vercel env lokal memakai `SWIFT_AI_MODEL_CHAIN=openrouter:deepseek/deepseek-v4-pro`.
- Railway worker env lokal memakai `SWIFT_AI_MODEL_CHAIN=openrouter:deepseek/deepseek-v4-pro`.
- `SWIFT_AI_FREE_MODE=false`.
- Fallback/free degraded variables tidak dikonfigurasi.
- `.gitignore` memblokir `.env*`.
- `git ls-files -- .env*` kosong.

Regression contract:

```txt
npm run test:generation-runtime-contracts
```

Hasil:

```txt
PASS semua check
```

Yang terkonfirmasi:

- Worker standalone bisa berjalan tanpa `next start`.
- Railway worker config menunjuk `workers/Dockerfile` dan `/health`.
- Worker health endpoint tersedia.
- Queue health menyertakan worker heartbeat, dead-letter queue, dan runtime detail.
- Dashboard sudah punya status UX untuk queue, worker, fallback, sandbox, dan retry.
- Failed generation artifact/reporting contract masih aktif.
- Compile gate dan sandbox runtime contract masih aktif.

Live health check:

```txt
Invoke-RestMethod https://ingenious-appreciation-production.up.railway.app/health
Invoke-RestMethod https://www.ai-swift.biz.id/api/worker/health
Invoke-RestMethod https://www.ai-swift.biz.id/api/health?coldStart=true
```

Waktu respons endpoint sekitar `2026-06-02 13:02-13:03 UTC` atau `2026-06-02 20:02-20:03 WIB`.

Hasil Railway worker `/health`:

```txt
status=healthy
mode=queue
worker.workerType=generation
worker.healthy=True
worker.ready=True
queue.status=healthy
```

Hasil Vercel `/api/worker/health`:

```txt
status=healthy
mode=queue
worker=healthy
queue=healthy
heartbeat.ageMs=1104
redis.ping=PONG
redis.latencyMs=72
workerService.ok=True
workerService.httpStatus=200
workerService.latencyMs=717
```

Hasil Vercel `/api/health?coldStart=true`:

```txt
status=healthy
environment=production
database=skipped
worker=skipped
queue=skipped
```

Catatan:

- Worker dan queue sedang sehat saat live check.
- Cold-start health memang melewati database/worker/queue, jadi itu hanya membuktikan startup route sehat.
- Provider health live tidak dites lewat `refreshProvider=true` agar tidak memicu panggilan model tambahan.
- Karena worker/queue sehat, fokus investigasi berikutnya tetap raw provider log dari Railway saat job generate gagal.

Command yang sudah ditutup:

```txt
npm run audit:production
```

Status awal:

```txt
TIMEOUT setelah sekitar 124 detik pada run pertama
```

Run ulang dengan timeout lebih panjang menemukan:

```txt
PASS npm run lint
PASS npm run typecheck
FAIL npm run build
```

Build failure awal:

```txt
TypeError: Cannot read properties of null (reading 'useContext')
Error occurred prerendering page "/_not-found"
Error occurred prerendering page "/auth/error"
Error occurred prerendering page "/dashboard/admin"
```

Root cause lokal:

```txt
scripts/vercel-build.js
```

Build wrapper memanggil `loadEnvConfig(process.cwd())` lalu sebelumnya hanya mengisi `NODE_ENV` jika kosong:

```txt
env.NODE_ENV = env.NODE_ENV || "production"
```

Karena `.env` dan `.env.local` lokal berisi `NODE_ENV=development`, `next build` bisa berjalan dengan mode env yang salah. Ini memicu error prerender React/Next internal seperti `LayoutRouterContext/useContext`.

Fix yang diterapkan:

```txt
env.NODE_ENV = "production"
```

Hasil final setelah fix dan Sentry config dikembalikan normal:

```txt
npm run audit:production
PASS npm run lint
PASS npm run typecheck
PASS npm run build
Static checks: 52/52 passed, 0 warning(s)
Commands: 3/3 passed
```

Audit production juga diulang lagi dari state akhir setelah pembersihan diff sementara, dan hasilnya tetap pass:

```txt
Commands: 3/3 passed
Static checks: 52/52 passed, 0 warning(s)
```

Kesimpulan:

- Build blocker ini terpisah dari error provider/OpenRouter.
- Root cause build lokal adalah build wrapper mewarisi `NODE_ENV=development`.
- Sentry App Directory instrumentation tidak perlu dimatikan setelah `NODE_ENV` dipaksa `production`.
- Audit produksi penuh sekarang lulus.

### Audit Logging Provider

Kode `lib/ai/provider-router.ts` sudah menyimpan metadata detail di attempt provider:

```txt
failureReason
statusCode
latencyMs
requestId
error
attempts
lastAttempt
```

Event yang membawa metadata detail:

```txt
provider_attempt_failed
provider_failover_exhausted
Swift AI OpenRouter request exhausted
```

Kode `lib/services/generation-orchestrator.service.ts` juga meneruskan metadata provider saat error:

```txt
generation_provider_failover_exhausted
providerAttempts
lastProviderAttempt
```

Kesimpulan penting:

- Jika raw Railway log dari worker terbaru hanya menampilkan nama event tanpa `attempts` / `lastAttempt`, kemungkinan besar:
  - Railway worker belum redeploy ke commit `2558edc`, atau
  - Log viewer Railway sedang menampilkan ringkasan, bukan full raw JSON/event payload.
- Kalau worker sudah benar-benar memakai commit `2558edc`, full/raw log seharusnya bisa menunjukkan `failureReason`, `statusCode`, `model`, `requestId`, dan `latencyMs`.

### Audit Mapping Error OpenRouter

Mapping status code di kode:

```txt
401/403 -> auth
408     -> timeout
402/429 -> rate_limit
500+    -> server_error
lainnya -> unknown
```

Mapping tambahan dari runtime:

```txt
empty_response
invalid_output
network
cancelled
config
overloaded
```

Interpretasi:

- `auth` berarti API key OpenRouter salah, expired, revoked, atau belum masuk ke environment worker yang aktif.
- `rate_limit` berarti credit, quota, atau rate limit provider/OpenRouter bermasalah.
- `timeout` berarti request terlalu lama, termasuk stream tidak memberi token dalam window watchdog.
- `server_error` berarti provider/model upstream gagal.
- `invalid_output` berarti provider menjawab, tetapi bentuk output tidak sesuai kontrak Swift.
- `config` berarti model chain kosong atau API key tidak tersedia pada runtime tersebut.
- `overloaded` bisa muncul saat circuit breaker/cooldown provider sedang aktif.

### Audit Env Lokal Vs Rekomendasi Throttle

Env lokal saat audit:

```txt
.env.production:
AI_MAX_CONCURRENT_GENERATIONS=2
SWIFT_GENERATION_WORKER_CONCURRENCY=2

.env.railway.worker.production:
AI_MAX_CONCURRENT_GENERATIONS=2
SWIFT_GENERATION_WORKER_CONCURRENCY=2
```

Catatan:

- Bagian sebelumnya menyarankan turunkan sementara ke `1`.
- File env lokal belum diturunkan ke `1`; nilainya masih `2`.
- Jika perubahan sudah dilakukan langsung di Railway UI, file lokal memang tidak otomatis ikut berubah.
- Untuk diagnosis provider/rate limit yang bersih, nilai production runtime sebaiknya sementara:

```txt
AI_MAX_CONCURRENT_GENERATIONS=1
SWIFT_GENERATION_WORKER_CONCURRENCY=1
```

Perbedaan fungsi:

- `AI_MAX_CONCURRENT_GENERATIONS` membatasi jumlah job aktif per user di endpoint `POST /api/generate/jobs`.
- `SWIFT_GENERATION_WORKER_CONCURRENCY` mengatur jumlah job BullMQ yang diproses paralel oleh worker.

### Audit Worker Health

Worker standalone expose:

```txt
/health
/api/worker/health
```

Response worker health berisi:

```txt
status
mode=queue
worker
queue
checkedAt
```

Queue health memakai heartbeat Redis:

```txt
swift:generation:worker:heartbeat
TTL 120000ms
```

Status heartbeat:

- `healthy` jika heartbeat masih segar.
- `stale` jika heartbeat lebih dari `90000ms`.
- `degraded` jika heartbeat hilang, queue heavy, atau Redis/memory policy bermasalah.

Implikasi:

- Vercel log yang sehat belum membuktikan worker sehat.
- Cek langsung worker:

```txt
https://ingenious-appreciation-production.up.railway.app/health
```

Target minimal:

```txt
status=healthy
mode=queue
worker.ready=true
worker.healthy=true
```

### Audit Model Chain

Kode `lib/ai/swift-tiers.ts` membaca:

```txt
SWIFT_AI_MODEL_CHAIN
```

Jika kosong, kode memberi warning:

```txt
[swift-ai] SWIFT_AI_MODEL_CHAIN is empty; using default OpenRouter model chain.
```

Default chain lokal:

```txt
openrouter:deepseek/deepseek-v4-pro
openrouter:anthropic/claude-sonnet-4
openrouter:openai/gpt-4.1-mini
```

Kesimpulan:

- Warning di console berarti runtime yang mengeksekusi kode itu tidak melihat `SWIFT_AI_MODEL_CHAIN`.
- Karena audit env lokal sudah pass, penyebab paling mungkin adalah env production di Vercel/Railway belum sama dengan file lokal, atau belum redeploy setelah env diset.
- `SWIFT_AI_FREE_MODE=false` sudah benar, tetapi flag ini bukan pengganti `SWIFT_AI_MODEL_CHAIN`.

### Decision Tree Untuk Raw Log Berikutnya

Jika raw Railway log menunjukkan:

```txt
failureReason=auth
statusCode=401/403
```

Tindakan:

- Re-apply `OPENROUTER_API_KEY` di Railway worker.
- Re-apply juga di Vercel Production jika health provider dari Vercel ikut gagal.
- Redeploy worker setelah env disimpan.
- Jalankan prompt kecil baru, bukan retry job lama.

Jika raw Railway log menunjukkan:

```txt
failureReason=rate_limit
statusCode=402/429
```

Tindakan:

- Cek credit/quota/rate limit OpenRouter.
- Turunkan `AI_MAX_CONCURRENT_GENERATIONS` dan `SWIFT_GENERATION_WORKER_CONCURRENCY` ke `1`.
- Jalankan satu prompt kecil.
- Jangan replay dead-letter sampai prompt baru sukses.

Jika raw Railway log menunjukkan:

```txt
failureReason=timeout
```

Tindakan:

- Pertahankan concurrency `1`.
- Cek apakah `first_token_received` pernah muncul.
- Jika tidak ada first token, model lambat/down sebelum mulai streaming.
- Jika ada first token lalu timeout, kemungkinan stream berhenti di tengah.

Jika raw Railway log menunjukkan:

```txt
failureReason=server_error
statusCode=5xx
```

Tindakan:

- Anggap upstream OpenRouter/model sedang gagal.
- Jangan langsung hidupkan fallback free/degraded.
- Jika perlu pindah model, ubah `SWIFT_AI_MODEL_CHAIN` secara eksplisit ke model paid yang sehat, lalu redeploy worker dan Vercel.

Jika raw Railway log menunjukkan:

```txt
failureReason=invalid_output
```

Tindakan:

- Provider menjawab, tetapi kontrak artifact gagal.
- Ambil failed artifact/report dari storage lokal runtime atau dashboard diagnostic.
- Fokus ke repair/output schema, bukan API key.

Jika raw Railway log menunjukkan:

```txt
reason=provider_circuit_open
```

Tindakan:

- Tunggu cooldown provider/model.
- Pastikan tidak ada retry massal dari dead-letter.
- Restart worker hanya jika health/circuit snapshot macet setelah provider sehat.

## 12. Prioritas Berikutnya Setelah Audit Lokal

Urutan paling hemat waktu:

1. Cek Railway worker deployment benar-benar commit `2558edc`.
2. Worker health sudah sehat saat audit, tetapi cek ulang jika error generate muncul lagi.
3. Di Railway, pastikan runtime env aktif punya:

```txt
SWIFT_AI_MODEL_CHAIN=openrouter:deepseek/deepseek-v4-pro
SWIFT_AI_FREE_MODE=false
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
SWIFT_GENERATION_WORKER_CONCURRENCY=1
AI_MAX_CONCURRENT_GENERATIONS=1
```

4. Redeploy Railway worker.
5. Redeploy Vercel Production jika env Vercel baru diubah.
6. Jalankan prompt kecil baru.
7. Jika gagal, ambil full raw log `provider_failover_exhausted` dan `generation_provider_failover_exhausted`.

Checklist audit tambahan:

- [x] Local HEAD terkonfirmasi `2558edc`
- [x] `npm run audit:production-env` pass
- [x] `npm run test:generation-runtime-contracts` pass
- [x] `git ls-files -- .env*` kosong
- [x] Railway worker health live `healthy`
- [x] Vercel `/api/worker/health` live `healthy`
- [x] `npm run audit:production` pass (`lint`, `typecheck`, `build`)
- [x] `scripts/vercel-build.js` memaksa `NODE_ENV=production`
- [ ] Railway worker deployment terkonfirmasi memakai commit `2558edc`
- [ ] Runtime env Railway worker diturunkan sementara ke concurrency `1`
- [ ] Runtime env Vercel/Railway terbukti punya `SWIFT_AI_MODEL_CHAIN`
- [ ] Prompt kecil baru sukses sampai preview bukan scaffold
