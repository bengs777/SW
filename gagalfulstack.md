# Evaluasi Penyebab AI Gagal Membuat Web Full Stack di Swift

Tanggal evaluasi: 2026-06-04 21:22 WIB

Dokumen ini menjelaskan alasan teknis kenapa AI di Web Swift bisa gagal membuat web full-stack sampai status siap preview/deploy. Evaluasi dibuat dari kode lokal, health endpoint production, dan mekanisme runtime Swift.

## Ringkasan Singkat

AI full-stack di Swift tidak gagal karena satu titik saja. Alurnya panjang:

1. User kirim prompt.
2. API membuat generation job.
3. Billing menahan saldo.
4. Job masuk Redis/BullMQ.
5. Worker mengambil job.
6. Worker memanggil OpenRouter.
7. Output AI harus berupa JSON file yang valid.
8. File digabung dan divalidasi.
9. Sandbox menjalankan install, Prisma generate, typecheck, lint, build, dan preview smoke test.
10. File disimpan ke database/project filesystem.
11. Preview dan deploy baru boleh dianggap siap.

Jika salah satu tahap gagal, UI bisa menampilkan "AI gagal membuat web full stack" walaupun sebagian file sudah sempat dibuat.

Penyebab paling kuat dari kondisi live saat dicek:

- Provider OpenRouter free model sering gagal untuk beban full-stack besar.
- Fallback model `openrouter/owl-alpha` sempat timeout pada health check.
- Worker live masih menunjukkan timeout 500 detik, sementara kode terbaru sudah menargetkan 900 detik. Ini indikasi worker belum memakai build/env terbaru.
- Dead-letter queue masih berisi 8 job.
- Ada failure terbaru `SWIFT_AI_PROVIDER_FAILOVER_EXHAUSTED`, `Repair timeout`, dan `Generation timed out after 500s`.
- Sandbox sehat, tetapi `hasDatabaseUrl:false`, sehingga full-stack yang benar-benar butuh database runtime dapat gagal saat validasi/runtime.

## Bukti Kondisi Live Saat Dicek

Endpoint yang dicek:

- `https://www.ai-swift.biz.id/api/health?refreshProvider=true`
- `https://www.ai-swift.biz.id/api/provider/health`
- `https://www.ai-swift.biz.id/api/worker/health`
- `https://sandbox.ai-swift.biz.id/health`

Hasil penting:

- App utama: `status: healthy`
- Database: sehat
- Auth: sehat
- Queue: sehat, tetapi aktif 2 job dan worker utilization 100 persen
- Dead-letter queue: `waiting: 8`
- Worker heartbeat: fresh, tetapi `activeJobIds` masih ada
- Worker service direct probe: belum dikonfigurasi karena `SWIFT_WORKER_HEALTH_URL` kosong
- Provider primary: `poolside/laguna-xs.2:free` sehat
- Provider fallback: `openrouter/owl-alpha` degraded karena timeout pada health refresh
- Runtime failures terbaru:
  - `SWIFT_AI_PROVIDER_FAILOVER_EXHAUSTED`
  - `Repair timeout`
  - `Generation timed out after 500s`
  - `dead_lettered`
  - `worker_timeout`
- Sandbox: sehat, storage cukup, Railway false
- Sandbox DB: `hasDatabaseUrl:false`

Kesimpulan live:

Sistem dasar sudah menyala, tetapi generation full-stack belum stabil karena worker/provider/runtime masih punya bottleneck nyata.

## Peta Alur Generate Full Stack

File utama yang terlibat:

- `app/api/generate/jobs/route.ts`
  - Validasi request.
  - Auth.
  - Billing reserve.
  - Queue decision.
  - Enqueue job.
  - Optional serverless fallback.

- `lib/queue/generation-queue.ts`
  - Redis/BullMQ connection.
  - Queue health.
  - Dead-letter queue.
  - Worker heartbeat.
  - Saturation check.

- `lib/workers/generation-worker.ts`
  - Worker process.
  - Lease job.
  - Timeout job.
  - Execute orchestrator.
  - Refund billing jika gagal.
  - Dead-letter jika worker gagal.

- `lib/services/generation-orchestrator.service.ts`
  - Planning.
  - Full-stack mode detection.
  - OpenRouter call.
  - Parse AI output.
  - Validate files.
  - Repair.
  - Sandbox build.
  - Persist result.

- `lib/ai/provider-router.ts`
  - Routing provider/model.
  - Fallback.
  - Retry.
  - Prompt kontrak output JSON.

- `lib/ai/openrouter-client.ts`
  - Header OpenRouter.
  - Fetch API OpenRouter.
  - Stream/non-stream.
  - Provider timeout.

- `lib/sandbox/runtime.ts`
  - Runtime sandbox lokal.
  - Install dependencies.
  - Prisma generate.
  - Typecheck.
  - Lint.
  - Build.
  - Preview smoke.

- `services/sandbox-runtime/server.mjs`
  - Runtime sandbox eksternal di VPS.
  - Health endpoint.
  - Preview proxy.
  - Build generated app.

## Penyebab Utama Kegagalan

### 1. Model OpenRouter gratis tidak cukup stabil untuk full-stack besar

Swift sekarang memakai OpenRouter dengan model utama:

```text
poolside/laguna-xs.2:free
```

Fallback:

```text
openrouter/owl-alpha
```

Masalahnya:

- Full-stack butuh output besar: UI, API, service, Prisma schema, config, validasi, dan package.
- Free model bisa lambat, limit, overloaded, atau output terpotong.
- Output harus valid JSON, bukan markdown atau penjelasan biasa.
- Jika model mengembalikan JSON tidak lengkap, parser akan gagal.
- Jika model tidak menghasilkan kategori full-stack lengkap, validator akan menolak.

Bukti live:

- Recent failure menunjukkan `SWIFT_AI_PROVIDER_FAILOVER_EXHAUSTED`.
- Health provider primary sehat, tetapi fallback `openrouter/owl-alpha` sempat timeout.

Dampak:

- Job gagal sebelum file valid terbentuk.
- Repair tidak sempat memperbaiki karena provider sudah habis.
- Saldo direfund, tetapi user melihat generate gagal.

### 2. Worker production tampak belum memakai timeout terbaru

Kode lokal sudah memiliki:

```text
MIN_GENERATION_JOB_TIMEOUT_MS = 900_000
```

Tetapi health live masih menunjukkan:

```text
idleTimeoutMs: 500000
Generation timed out after 500s
```

Masalahnya:

- Ini indikasi worker yang sedang hidup belum restart/redeploy dengan kode/env terbaru.
- Full-stack generation sering butuh lebih dari 500 detik saat memakai model gratis.
- Worker lama akan membunuh job sebelum proses selesai.

Dampak:

- Job masuk `worker_timeout`.
- Setelah retry habis, masuk dead-letter.
- UI terlihat berhenti/gagal walaupun app utama sehat.

Prioritas:

- Restart worker VPS.
- Pastikan worker memakai commit terbaru.
- Pastikan env worker punya timeout minimal 900000 ms.
- Pastikan health worker setelah restart tidak lagi menampilkan `idleTimeoutMs: 500000`.

### 3. Dead-letter queue belum bersih

Health live menunjukkan:

```text
deadLetter.waiting: 8
```

Masalahnya:

- Dead-letter berarti job sudah gagal setelah retry/worker failure.
- Jika tidak dibersihkan atau dianalisis, status sistem terlihat sehat tetapi ada kegagalan generation nyata.
- Dead-letter lama bisa membingungkan diagnosis karena UI/user melihat riwayat gagal terus.

Dampak:

- Banyak job gagal tersimpan.
- Retry manual bisa mengulang kegagalan yang sama jika root cause belum diperbaiki.

Prioritas:

- Ambil detail job dead-letter.
- Kelompokkan reason: provider, timeout, sandbox, parse, build.
- Replay hanya setelah worker/provider fix.

### 4. Worker direct health belum dikonfigurasi

Health live menunjukkan:

```text
SWIFT_WORKER_HEALTH_URL: missing
workerService.configured: false
```

Masalahnya:

- App hanya melihat heartbeat Redis.
- Heartbeat Redis cukup untuk sinyal dasar, tetapi tidak membuktikan endpoint worker VPS benar-benar bisa diprobe.
- Jika ada worker lama, stale, atau service yang salah, lebih sulit dibedakan.

Dampak:

- Production readiness degraded.
- Diagnosis worker kurang pasti.

Prioritas:

- Jalankan worker dengan endpoint health.
- Set di Vercel:

```env
SWIFT_WORKER_HEALTH_URL=https://worker-domain-kamu/health
```

Jika worker tidak punya domain publik, minimal pastikan heartbeat Redis fresh dan worker restart tiap deploy.

### 5. Queue saturasi saat concurrency penuh

Health live menunjukkan:

```text
activeJobs: 2
workerUtilizationPct: 100
```

Konfigurasi app menunjukkan `aiMaxConcurrentGenerations: 2`.

Masalahnya:

- Dua job aktif sudah membuat worker penuh.
- Prompt berikutnya bisa kena limit active/queued/cooldown.
- Jika dua job itu stuck, user baru ikut terblokir.

Dampak:

- Generate terasa menunggu lama.
- Bisa muncul retry, orphaned, stalled, atau dead-letter.

Prioritas:

- Pastikan active job bukan stuck.
- Naikkan worker concurrency hanya jika CPU/RAM VPS cukup.
- Tambahkan cleanup/recovery untuk active job yang sudah terlalu lama.

### 6. Sandbox sehat, tetapi belum punya database sandbox

Sandbox health live:

```text
status: healthy
hasDatabaseUrl: false
```

Masalahnya:

- Untuk frontend-only, ini tidak masalah.
- Untuk full-stack dengan Prisma/API/database, build bisa lolos dalam beberapa kasus, tetapi runtime API yang menyentuh database bisa gagal.
- Generated app biasanya perlu `DATABASE_URL` di sandbox jika diminta CRUD, auth, dashboard, payment, atau admin.

Dampak:

- Preview UI bisa muncul, tetapi API full-stack tidak benar-benar jalan.
- Runtime smoke bisa gagal jika halaman memanggil API yang butuh DB.
- User merasa "web full-stack gagal" karena backend tidak berfungsi.

Prioritas:

- Set di VPS sandbox:

```env
SWIFT_SANDBOX_DATABASE_URL=postgresql://...
```

Gunakan database sandbox terpisah dari production utama.

### 7. Validasi full-stack memang ketat

Validator full-stack mewajibkan kategori:

- frontend
- api
- data
- config

File terkait:

- `lib/ai/fullstack-validator.ts`
- `lib/services/generation-orchestrator.service.ts`

Masalahnya:

- Jika AI hanya membuat UI, gagal kategori `api` dan `data`.
- Jika AI membuat API tapi tanpa service/Prisma, gagal kategori `data`.
- Jika AI membuat Prisma dan API tapi tanpa `package.json`/config, gagal kategori `config`.
- Jika prompt ambigu, sistem bisa salah memilih frontend-only atau production full-stack.

Dampak:

- Output yang terlihat bagus di editor tetap gagal validasi production.
- Repair harus menambah kategori yang hilang, tetapi repair dibatasi.

### 8. Frontend completeness gate juga ketat

Full frontend mode memiliki validasi:

- Minimal 8 file.
- Harus ada `app/page.tsx`.
- Harus ada `app/layout.tsx`.
- Harus ada `app/globals.css`.
- Harus ada header/navbar.
- Harus ada footer.
- Harus ada CTA.
- Harus responsive.
- Harus ada loading/empty state.
- Harus ada section domain-specific.

File terkait:

- `lib/ai/frontend-completeness-validator.ts`

Masalahnya:

- Model gratis sering membuat single-file demo.
- Single-file demo ditolak karena dianggap bukan web production-like.

Dampak:

- AI "berhasil" membuat halaman, tetapi Swift menolak karena belum layak.

### 9. Output AI harus strict JSON

Provider prompt mengharuskan:

```json
{"files":[{"path":"app/page.tsx","content":"..."}]}
```

Masalah umum:

- AI membalas dengan markdown.
- AI menambahkan penjelasan sebelum JSON.
- JSON terpotong.
- String kode tidak di-escape dengan benar.
- Ada trailing comma.
- File kosong.
- Path tidak valid.
- Output berisi command atau metadata yang tidak diterima.

File terkait:

- `lib/ai/generated-artifact.ts`

Dampak:

- Stage parsing gagal.
- Repair bisa gagal jika repair output juga malformed.

### 10. Path policy membatasi file yang boleh dibuat

Path yang boleh biasanya:

- `app/`
- `components/`
- `sections/`
- `component-registry/`
- `lib/`
- `prisma/`
- root config tertentu seperti `package.json`, `tsconfig.json`, `.env.example`

Path yang diblokir:

- `.env`
- `.git`
- `node_modules`
- absolute path
- `..`
- lockfile seperti `package-lock.json`

Masalahnya:

- AI kadang membuat `src/app` padahal runtime berharap `app`.
- AI kadang membuat `.env`, lockfile, atau path absolut.
- AI kadang impor dari path yang tidak dibuat.

Dampak:

- File ditolak sebelum sandbox.
- Missing import muncul saat validation.

### 11. Dependency allowlist bisa menolak package yang diminta AI

Sandbox hanya mengizinkan package tertentu.

Masalahnya:

- AI membuat package di luar allowlist, misalnya library chart, auth, payment, database adapter, atau UI lain yang tidak ada.
- Sandbox akan memfilter dependency.
- Build kemudian gagal karena import package tidak ditemukan.

Dampak:

- `Module not found`.
- Build fail.
- Repair berulang.

Prioritas:

- Perlu policy: AI hanya boleh memakai stack yang tersedia.
- Tambah allowlist hanya untuk dependency yang memang aman dan dibutuhkan.

### 12. Build sandbox punya timeout dan limit resource

Sandbox command timeout:

- install: 120 detik
- Prisma generate: 90 detik
- typecheck: 90 detik
- lint: 90 detik
- build: 150 detik

Sandbox VPS limit:

- max active project: 12
- max files: 240
- max total payload: 6 MB
- storage minimal: 256 MB free

Masalahnya:

- Full-stack Next.js + Prisma bisa butuh install/build lama.
- Model bisa menghasilkan banyak file.
- Jika VPS sedang berat, build 150 detik bisa gagal.

Dampak:

- `npm run build failed`
- `Command timed out`
- preview tidak keluar.

### 13. Prisma/database boundary bisa salah

Full-stack sering butuh Prisma.

Masalah umum dari AI:

- Import Prisma client di Client Component.
- Lupa `prisma/schema.prisma`.
- API route tidak memakai `NextResponse`.
- Schema Prisma tidak valid.
- `@prisma/client` tidak digenerate.
- Query tidak user-scoped.
- API route tidak async atau salah signature.

Dampak:

- Typecheck gagal.
- Build gagal.
- Runtime API error.

### 14. Next.js App Router boundary bisa salah

Masalah umum:

- Komponen memakai `useState` tanpa `"use client"`.
- Server component memakai browser API.
- Client component import server-only service.
- Route handler salah export.
- Metadata diekspor dari client component.
- `next/image` dipakai tanpa konfigurasi remote domain.

Dampak:

- Build gagal.
- Preview blank.
- Hydration/runtime error.

### 15. Repair dibatasi

Konfigurasi repair:

- Maksimal repair attempts: 3
- Maksimal file per repair: 3

Masalahnya:

- Full-stack gagal sering butuh memperbaiki banyak file sekaligus.
- Jika root cause ada di arsitektur, repair 3 file tidak cukup.
- Jika provider lambat, repair bisa timeout.

Bukti live:

- Ada failure `Repair timeout`.

Dampak:

- Pipeline berhenti sebelum berhasil.
- Output parsial bisa ada di editor, tetapi job gagal.

### 16. Prompt terlalu besar untuk satu pass

Contoh prompt berisiko:

- "Buat marketplace lengkap dengan login, admin, payment, order, chat, dashboard, database, upload, deploy."
- "Buat SaaS full stack seperti Shopify."
- "Buat aplikasi rumah sakit lengkap BPJS, dokter, pasien, appointment, payment, report."

Masalahnya:

- Banyak domain dalam satu prompt.
- Butuh banyak file dan banyak logic.
- Model free cenderung memotong output atau membuat mock.

Dampak:

- Missing categories.
- Build gagal.
- Repair timeout.

Solusi praktis:

- Pecah menjadi tahap:
  1. Scaffold full-stack minimal.
  2. CRUD utama.
  3. Auth/role.
  4. Dashboard/admin.
  5. Payment/upload.
  6. Polishing UI.

### 17. Billing, saldo, rate limit, dan active job bisa memblokir

API generate mengecek:

- Auth.
- Project ownership.
- Balance.
- Active job limit.
- Queued job limit.
- Cooldown.
- Rate limit.

Masalahnya:

- Saldo kurang.
- Job lama masih active.
- Queue penuh.
- User terlalu cepat retry.

Dampak:

- Generate ditolak sebelum worker.
- UI bisa terasa gagal padahal provider belum dipanggil.

### 18. Persistence bisa gagal setelah AI berhasil

Setelah AI dan sandbox berhasil, Swift masih harus menyimpan:

- Project files.
- Generation history.
- Manifest/hash.
- Preview session.
- Runtime state.

Masalahnya:

- DB schema mismatch.
- Project state kosong.
- File path duplicate.
- Stale generation lebih lama mencoba menimpa generation baru.
- Supabase/storage/report adapter tidak siap.

Dampak:

- Editor tidak menampilkan file terbaru.
- Version history kosong.
- Preview validated tapi deploy tetap terblokir.

### 19. Env production dan env worker bisa tidak sama

App Vercel dan worker VPS harus punya env selaras:

- `DATABASE_URL`
- `REDIS_URL`
- `OPENROUTER_API_KEY`
- `OPENROUTER_MODEL`
- `SWIFT_AI_PROVIDER_NAME`
- `SANDBOX_SERVICE_URL`
- `SANDBOX_SERVICE_TOKEN`
- timeout AI/worker

Masalahnya:

- Vercel sudah update, worker belum.
- Worker memakai `.env.worker.production` lama.
- Sandbox memakai env berbeda.
- App health sehat, tetapi worker menjalankan config lama.

Bukti live:

- App health menampilkan generation timeout 900 detik.
- Worker heartbeat menampilkan idle timeout 500 detik pada failure live.

Dampak:

- Sulit debug karena app dan worker berbeda versi.

### 20. Deploy final berbeda dari preview

Preview sandbox berbeda dari deploy Vercel generated app.

Deploy membutuhkan:

- `VERDI_TEAM`
- `VERPRO_ACCES_TOKEN` jika deploy generated app memakai token.
- GitHub/Vercel integration.
- Env generated app.
- Build Vercel.

Masalahnya:

- Preview lolos tetapi deploy gagal karena token/domain/build env.
- Full-stack generated app butuh DATABASE_URL sendiri.

Dampak:

- User mengira AI gagal, padahal yang gagal adalah deploy final.

## Penyebab yang Paling Mungkin Saat Ini

Berdasarkan evidence live, urutan penyebab paling mungkin:

1. OpenRouter free model/fallback tidak stabil untuk full-stack besar.
2. Worker belum restart/redeploy dengan timeout terbaru, karena masih ada failure `500s`.
3. Dead-letter queue masih menyimpan job gagal.
4. Worker direct health URL belum ada, jadi verifikasi worker VPS belum kuat.
5. Sandbox tidak punya `SWIFT_SANDBOX_DATABASE_URL`, sehingga backend/database generated app belum benar-benar bisa diuji runtime.
6. Repair timeout karena full-stack failure butuh perbaikan banyak file dan model lambat.

## Checklist Verifikasi

Jalankan dari lokal atau VPS sesuai konteks.

### 1. Cek app production

```bash
curl https://www.ai-swift.biz.id/api/health?refreshProvider=true
curl https://www.ai-swift.biz.id/api/provider/health
curl https://www.ai-swift.biz.id/api/worker/health
```

Yang dicari:

- `status` healthy atau degraded, bukan unhealthy.
- `deadLetter.counts.waiting` harus 0 atau sudah dianalisis.
- `workerHeartbeat.ageMs` kurang dari 90 detik.
- `workerHeartbeat.stalledGenerationDetected` false.
- `idleTimeoutMs` minimal 900000.

### 2. Cek sandbox VPS

```bash
curl https://sandbox.ai-swift.biz.id/health
```

Yang dicari:

- `status: healthy`
- `runtime.storage.ok: true`
- `sandbox.hasDatabaseUrl: true` untuk full-stack database test

### 3. Cek worker VPS

```bash
pm2 status
pm2 logs --lines 200
pm2 env <id-worker> | grep -E "OPENROUTER|REDIS|SANDBOX|TIMEOUT|SWIFT"
```

Yang dicari:

- Worker generation online.
- Env sama dengan production.
- Tidak ada timeout 500 detik jika target 900 detik.
- Tidak ada provider failover exhausted berulang.

### 4. Cek queue dan dead-letter

Gunakan endpoint admin atau script queue jika tersedia.

Yang dicari:

- waiting normal.
- active tidak stuck.
- dead-letter kosong setelah root cause diperbaiki.

### 5. Cek satu smoke prompt kecil

Prompt:

```text
Buat landing page toko kopi modern dengan halaman utama, navbar, hero, produk unggulan, testimoni, dan footer.
```

Target:

- Frontend-only harus berhasil.
- Jika ini gagal, masalah bukan full-stack, tetapi provider/worker/sandbox dasar.

### 6. Cek satu smoke prompt full-stack minimal

Prompt:

```text
Buat aplikasi full-stack todo sederhana dengan Prisma schema, API route CRUD, halaman UI untuk list/create/delete todo, dan .env.example.
```

Target:

- Ada `app/page.tsx`.
- Ada `app/api/.../route.ts`.
- Ada `prisma/schema.prisma`.
- Ada `package.json` atau config.
- Sandbox build lolos.

## Prioritas Perbaikan

### Prioritas 1 - Worker harus memakai build/env terbaru

Tindakan:

- Restart worker VPS.
- Pastikan worker memakai commit terbaru.
- Pastikan env timeout minimal:

```env
AI_QUEUE_TIMEOUT_MS=900000
SWIFT_GENERATION_JOB_TIMEOUT_MS=900000
AI_PROVIDER_REQUEST_BUDGET_MS=240000
OPENROUTER_HARD_TIMEOUT_MS=240000
```

Catatan:

Kode lokal sudah memaksa job timeout minimal 900 detik, tetapi worker live perlu restart agar memakai kode itu.

### Prioritas 2 - Bersihkan dan audit dead-letter

Tindakan:

- Export daftar dead-letter.
- Catat reason tiap job.
- Hapus/replay setelah root cause fix.

Jangan replay sebelum worker/provider diperbaiki, karena hanya akan menambah kegagalan.

### Prioritas 3 - Tambahkan database sandbox

Tindakan:

```env
SWIFT_SANDBOX_DATABASE_URL=postgresql://...
SWIFT_SANDBOX_DIRECT_DATABASE_URL=postgresql://...
```

Gunakan database terpisah khusus sandbox.

### Prioritas 4 - Tambahkan worker health URL

Tindakan:

- Expose `/health` worker via domain internal/publik aman.
- Set `SWIFT_WORKER_HEALTH_URL`.

Tujuan:

- App bisa membedakan worker benar-benar sehat atau hanya heartbeat Redis yang terlihat.

### Prioritas 5 - Kurangi beban model gratis

Tindakan:

- Full-stack besar dipaksa bertahap.
- Buat mode "full-stack minimal first".
- Setelah scaffold lolos, lanjutkan fitur.
- Jangan minta auth, payment, admin, upload, analytics, dan dashboard sekaligus dalam prompt pertama.

### Prioritas 6 - Perkuat fallback model

Jika tetap ingin OpenRouter gratis:

- Primary: `poolside/laguna-xs.2:free`
- Fallback 1: `poolside/laguna-m.1:free`
- Fallback 2: `openrouter/owl-alpha`

Namun kalau production harus stabil, model gratis tetap risiko utama. Full-stack production biasanya butuh model yang lebih stabil.

### Prioritas 7 - Tambahkan ringkasan error yang lebih jelas di UI

UI sebaiknya membedakan:

- Provider gagal.
- Worker timeout.
- Queue penuh.
- Sandbox build gagal.
- Missing full-stack category.
- Billing/rate limit.

Saat ini banyak kegagalan bisa terlihat sebagai pesan generik AI sedang gangguan.

## Kesimpulan

Swift sudah memiliki arsitektur yang benar untuk full-stack generation: queue, worker, validation, sandbox, repair, persistence, dan health checks. Masalahnya ada pada stabilitas operasional dan beban model:

- Full-stack terlalu berat untuk free model jika diminta sekali jalan.
- Worker live perlu dipastikan memakai timeout terbaru.
- Dead-letter perlu dibersihkan setelah akar masalah diperbaiki.
- Sandbox perlu database agar full-stack benar-benar bisa diuji.
- Worker health URL perlu ditambahkan agar production readiness tidak hanya mengandalkan Redis heartbeat.

Kondisi paling mendesak bukan UI, melainkan runtime generate:

1. Restart/update worker.
2. Bersihkan dead-letter.
3. Tambah database sandbox.
4. Naikkan provider hard timeout atau pakai fallback yang lebih stabil.
5. Uji smoke full-stack minimal.

