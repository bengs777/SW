# Analisis Kenapa AI Swift Gagal Membuat Web Full Stack

Tanggal analisis: 2026-06-04 21:31 WIB

## Kesimpulan Utama

AI Swift gagal membuat web full-stack bukan karena database, auth, atau sandbox utama mati. Saat dicek, app production, database, auth, Redis queue, provider primary, dan sandbox dalam kondisi hidup.

Masalah paling kuat ada pada 4 titik:

1. Provider AI OpenRouter free model tidak stabil untuk beban full-stack besar.
2. Worker yang aktif masih memakai timeout lama `500000 ms`, sementara kode terbaru menargetkan `900000 ms`.
3. Queue dead-letter terus bertambah, dari 8 menjadi 13 job.
4. Ada error race condition di logging event generation: `Unique constraint failed on the fields: (jobId, sequence)`.

Dengan kata lain, sistem dasarnya sudah menyala, tetapi pipeline generate full-stack masih gagal di lapisan provider, worker, retry/dead-letter, dan pencatatan event.

## Bukti Live Production

Endpoint yang dicek:

```text
https://www.ai-swift.biz.id/api/health?refreshProvider=true
https://www.ai-swift.biz.id/api/provider/health
https://www.ai-swift.biz.id/api/worker/health
https://sandbox.ai-swift.biz.id/health
```

Hasil penting:

```text
App status       : healthy
Database         : healthy
Auth             : healthy
Queue            : healthy
Provider primary : healthy
Sandbox          : healthy
```

Tetapi ada masalah penting:

```text
Dead-letter waiting       : 13
Worker idleTimeoutMs      : 500000
Worker stalled detected   : true
Worker activeJobIds       : cmpzfi6zn0003r5xge1t3j3n6, cmpzhnyia000356jdpkmcgmf3
SWIFT_WORKER_HEALTH_URL   : missing
Sandbox hasDatabaseUrl    : false
Fallback model owl-alpha  : degraded timeout
```

Failure terbaru:

```text
SWIFT_AI_PROVIDER_FAILOVER_EXHAUSTED
Repair timeout
Generation timed out after 500s
Unique constraint failed on the fields: (jobId, sequence)
dead_lettered
worker_failed
worker_timeout
```

## Alur Generate Full Stack di Swift

Pipeline full-stack berjalan seperti ini:

1. User kirim prompt dari editor.
2. `app/api/generate/jobs/route.ts` validasi auth, payload, saldo, rate limit, project ownership.
3. Billing reserve saldo.
4. Job masuk Redis/BullMQ.
5. Dedicated generation worker mengambil job.
6. Worker memanggil OpenRouter lewat provider router.
7. Output AI harus berupa JSON valid berisi daftar file.
8. Orchestrator parse, normalize, dan validasi file.
9. Full-stack validator memastikan ada frontend, API, data layer, dan config.
10. Repair dijalankan jika file gagal.
11. Sandbox VPS menjalankan install, Prisma generate, typecheck, lint, build, dan preview.
12. File disimpan ke project filesystem dan history.

Jika satu tahap gagal, user hanya melihat generate gagal meskipun sebagian proses sudah berjalan.

## Akar Masalah 1 - Provider OpenRouter Free Model Tidak Kuat Untuk Full Stack Besar

Model aktif:

```text
poolside/laguna-xs.2:free
```

Fallback:

```text
openrouter/owl-alpha
```

Masalah:

- Full-stack butuh output besar: UI, API route, service layer, Prisma schema, config, state, dan package.
- Free model bisa lambat, limit, overloaded, atau output JSON terpotong.
- Health menunjukkan fallback `openrouter/owl-alpha` timeout.
- Runtime failure terbaru menunjukkan `SWIFT_AI_PROVIDER_FAILOVER_EXHAUSTED`.

Dampak:

- AI gagal sebelum file lengkap terbentuk.
- Repair tidak punya bahan cukup.
- Job masuk failed atau dead-letter.

Indikasi di UI:

```text
Swift AI sedang mengalami gangguan sementara...
Generation failed
Retry with repair
```

## Akar Masalah 2 - Worker Aktif Masih Timeout 500 Detik

Kode terbaru sudah punya target timeout minimal:

```text
MIN_GENERATION_JOB_TIMEOUT_MS = 900000
```

Tetapi worker live masih melaporkan:

```text
idleTimeoutMs: 500000
Generation timed out after 500s
```

Ini menunjukkan worker yang hidup belum memakai versi/env terbaru, atau env worker masih override timeout lama.

Dampak:

- Full-stack generation dipaksa mati sebelum selesai.
- Repair juga ikut mati.
- Worker menandai job sebagai timeout.
- Retry bisa habis dan masuk dead-letter.

Prioritas:

```bash
pm2 restart <generation-worker>
pm2 env <id-worker> | grep -E "TIMEOUT|SWIFT|OPENROUTER|REDIS|SANDBOX"
```

Pastikan env worker:

```env
AI_QUEUE_TIMEOUT_MS=900000
SWIFT_GENERATION_JOB_TIMEOUT_MS=900000
AI_PROVIDER_REQUEST_BUDGET_MS=240000
OPENROUTER_HARD_TIMEOUT_MS=240000
```

## Akar Masalah 3 - Dead-letter Queue Bertambah

Health terbaru:

```text
deadLetter.waiting: 13
```

Sebelumnya sempat 8. Berarti ada job yang terus gagal dan masuk dead-letter.

Masalah:

- Dead-letter adalah tanda job sudah gagal setelah retry/worker failure.
- Kalau root cause belum diperbaiki, replay akan gagal lagi.
- Dead-letter membuat riwayat generate tampak buruk dan bisa mengganggu diagnosis.

Prioritas:

1. Ambil daftar dead-letter.
2. Kelompokkan reason.
3. Jangan replay sebelum provider/worker/event race diperbaiki.
4. Setelah fix, replay job yang masih layak.

## Akar Masalah 4 - Race Condition di GenerationEvent Sequence

Error production terbaru:

```text
Invalid prisma.generationEvent.create() invocation:
Unique constraint failed on the fields: (jobId, sequence)
```

Kode terkait:

```text
lib/services/generation-job.service.ts
```

Pola saat ini:

1. Ambil `_max.sequence` untuk job.
2. Tambah 1.
3. Insert event baru.

Masalahnya:

- Jika dua proses/event berjalan paralel untuk `jobId` yang sama, keduanya bisa membaca max sequence yang sama.
- Keduanya mencoba insert sequence yang sama.
- Prisma gagal karena schema punya unique constraint:

```text
@@unique([jobId, sequence])
```

Dampak:

- Job yang seharusnya hanya mencatat event bisa gagal total.
- Failure ini muncul sebagai `worker_failed`.
- Bisa memperbanyak dead-letter.

Perbaikan yang disarankan:

- Gunakan advisory lock per `jobId` saat append event.
- Atau pakai retry khusus jika kena P2002 unique constraint.
- Atau ubah sequence menjadi atomic counter di row `GenerationJob`.

Prioritas minimal:

- Tambah retry 3 kali di `appendEvent` ketika Prisma error P2002 pada `(jobId, sequence)`.
- Pada retry, baca ulang max sequence lalu insert lagi.

## Akar Masalah 5 - Worker Health URL Belum Ada

Health menunjukkan:

```text
SWIFT_WORKER_HEALTH_URL: missing
workerService.configured: false
```

Masalah:

- App hanya tahu worker dari Redis heartbeat.
- Redis heartbeat fresh tidak selalu membuktikan worker service VPS benar-benar benar, terbaru, dan bisa diprobe.
- Dalam kasus ini heartbeat worker masih membawa timeout lama `500000`, jadi direct worker health sangat penting.

Prioritas:

```env
SWIFT_WORKER_HEALTH_URL=https://domain-worker-kamu/health
```

Jika worker tidak punya domain publik, minimal buat health endpoint internal yang bisa diprobe dari Vercel atau dari script deploy readiness.

## Akar Masalah 6 - Sandbox Tidak Punya Database URL

Sandbox health:

```text
hasDatabaseUrl: false
```

Masalah:

- Frontend-only masih bisa jalan.
- Full-stack dengan Prisma/API/database tidak bisa diuji penuh.
- Build mungkin lolos, tetapi API route yang memakai database bisa gagal runtime.

Prioritas:

Set di VPS sandbox:

```env
SWIFT_SANDBOX_DATABASE_URL=postgresql://...
SWIFT_SANDBOX_DIRECT_DATABASE_URL=postgresql://...
```

Gunakan database sandbox terpisah dari database production utama.

## Akar Masalah 7 - Full-stack Validator Sangat Ketat

Full-stack dianggap valid hanya jika ada:

- Frontend
- API route
- Data layer
- Config

File terkait:

```text
lib/ai/fullstack-validator.ts
lib/services/generation-orchestrator.service.ts
```

Masalah:

- Jika AI hanya membuat landing page bagus, tetap gagal full-stack.
- Jika AI membuat UI dan Prisma tetapi tidak ada API route, gagal.
- Jika AI membuat API route tetapi tidak ada service/Prisma, gagal.
- Jika AI membuat semua tetapi `package.json`/config kurang, gagal.

Dampak:

- Output terlihat ada di editor, tetapi tidak boleh masuk status ready.

## Akar Masalah 8 - Repair Terlalu Sempit Untuk Kerusakan Full Stack

Konfigurasi repair:

```text
MAX_REPAIR_ATTEMPTS = 3
MAX_FILES_PER_REPAIR = 3
```

Masalah:

- Full-stack failure sering menyentuh banyak file.
- Repair 3 file cukup untuk syntax kecil, tetapi tidak cukup untuk arsitektur backend/frontend yang kurang.
- Provider free lambat membuat repair timeout.

Bukti:

```text
Repair timeout
```

Dampak:

- Job berhenti walau sebenarnya bisa diperbaiki jika repair lebih luas atau bertahap.

## Akar Masalah 9 - Prompt Full Stack Terlalu Besar Untuk Sekali Generate

Prompt seperti ini sangat berisiko:

```text
Buat marketplace full-stack lengkap dengan login, admin, payment, order, dashboard, database, upload, dan deploy.
```

Masalah:

- Terlalu banyak domain dalam satu job.
- Butuh banyak file.
- Output JSON mudah terpotong.
- Free model cenderung membuat mock atau setengah jadi.

Solusi:

Pecah menjadi beberapa tahap:

1. Full-stack minimal dengan Prisma + CRUD inti.
2. UI dashboard.
3. Auth dan role.
4. Payment.
5. Upload/storage.
6. Deploy polish.

## Urutan Prioritas Perbaikan

### 1. Restart dan update worker

Target:

- Worker memakai commit terbaru.
- Worker timeout menjadi 900000.
- `stalledGenerationDetected` false.

### 2. Perbaiki race condition GenerationEvent

Target:

- Tidak ada lagi error `(jobId, sequence)`.
- Event logging tidak membuat job gagal.

### 3. Audit dead-letter queue

Target:

- Dead-letter tidak terus bertambah.
- Reason dipisah antara provider, timeout, event sequence, sandbox, dan build.

### 4. Tambahkan database sandbox

Target:

- Sandbox bisa menguji API/database generated app.
- `hasDatabaseUrl: true`.

### 5. Tambahkan worker health URL

Target:

- Production readiness bisa memprobe worker langsung.
- Tidak hanya mengandalkan Redis heartbeat.

### 6. Stabilkan provider model

Target:

- Primary tetap OpenRouter.
- Pakai model/fallback yang lebih stabil untuk full-stack.
- Free model boleh untuk test, tetapi production full-stack perlu model yang tahan output besar.

### 7. Ubah strategi generate full-stack menjadi bertahap

Target:

- Prompt besar tidak dipaksa sekali jalan.
- Scaffold minimal harus lolos dulu.
- Fitur kompleks ditambahkan setelah baseline valid.

## Smoke Test Setelah Perbaikan

### Test 1 - Frontend sederhana

```text
Buat landing page toko kopi modern dengan navbar, hero, produk unggulan, testimoni, CTA, dan footer.
```

Harus lolos tanpa database.

### Test 2 - Full-stack minimal

```text
Buat aplikasi full-stack todo sederhana dengan Prisma schema, API route CRUD, halaman UI untuk list/create/delete todo, dan .env.example.
```

Harus menghasilkan:

```text
app/page.tsx
app/api/.../route.ts
prisma/schema.prisma
package.json atau config
.env.example
```

### Test 3 - Cek health setelah smoke

```bash
curl https://www.ai-swift.biz.id/api/health?refreshProvider=true
curl https://www.ai-swift.biz.id/api/worker/health
curl https://sandbox.ai-swift.biz.id/health
```

Target:

```text
deadLetter.waiting tidak bertambah
worker idleTimeoutMs >= 900000
stalledGenerationDetected false
sandbox.hasDatabaseUrl true
tidak ada SWIFT_AI_PROVIDER_FAILOVER_EXHAUSTED baru
tidak ada Unique constraint failed pada GenerationEvent
```

## Kesimpulan Final

AI Swift gagal full-stack karena pipeline production masih tersandung di runtime generate, bukan karena halaman/dashboard utama mati.

Penyebab paling konkret dari bukti terbaru:

1. OpenRouter free/fallback gagal untuk beban full-stack.
2. Worker masih timeout 500 detik.
3. Dead-letter queue bertambah menjadi 13.
4. Event logging punya race condition sequence.
5. Sandbox belum punya database URL.
6. Worker direct health belum dikonfigurasi.

Perbaikan paling mendesak:

1. Restart/update worker.
2. Patch `GenerationJobService.appendEvent` agar aman dari duplicate sequence.
3. Bersihkan dead-letter setelah root cause selesai.
4. Tambah database sandbox.
5. Jalankan smoke test full-stack minimal.

