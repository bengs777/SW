# Rencana Perbaikan Production Swift AI

Tanggal audit: 2026-06-04

Tujuan dokumen ini adalah menjadi checklist perbaikan agar Swift AI layak dibuka untuk publik production, bukan hanya berhasil deploy.

## Status Implementasi 2026-06-04

Sudah dikerjakan di codebase:

- Endpoint internal `/api/metrics`, `/api/production/monitoring`, dan `/api/worker/health` sekarang membutuhkan bearer token `SWIFT_METRICS_TOKEN` atau akses developer yang valid.
- `/api/health` publik sekarang hanya mengembalikan status ringkas. Detail internal hanya dibuka untuk request dengan token observability.
- `refreshProvider=true` pada health endpoint hanya diproses untuk request internal.
- Production CSP ditambahkan melalui `proxy.ts`.
- Runtime preview iframe tidak lagi selalu memakai sandbox permisif. `allow-same-origin` hanya diberikan saat preview berasal dari origin yang berbeda dari dashboard, dan `allow-popups`/`allow-downloads` dicabut.
- `npm run audit:production` sudah diperbaiki sampai lolos penuh.
- Dependency production audit sudah bersih dengan upgrade `viem` dan override `ws`.
- Deploy readiness dan runtime health sekarang membedakan sinyal utama dan optional: Redis/BullMQ worker heartbeat menjadi sinyal utama, sedangkan `SWIFT_WORKER_HEALTH_URL` hanya direct probe optional.
- `.env.example` sudah ditambah contoh `SWIFT_METRICS_TOKEN` dan worker health URL production.

Verifikasi yang sudah lolos:

- `npm run typecheck`
- `npm run test:hardening`
- `npm run test:generation-runtime-contracts`
- `npm run test:regression`
- `npm run test:resilience`
- `npm audit --omit=dev`
- `npm run audit:production`
- Browser smoke lokal untuk `/` dan `/login`

Yang masih harus dilakukan di deployment production:

- Set `SWIFT_METRICS_TOKEN` dengan token acak 32+ karakter di environment production.
- Opsional tetapi disarankan: set `SWIFT_WORKER_HEALTH_URL` ke endpoint health worker production yang benar untuk direct probe admin.
- Pastikan worker production tidak memakai identitas `generation:local:*`.
- Deploy ulang app, worker, dan sandbox runtime.
- Jalankan ulang `NODE_ENV=production DEPLOY_ENV_FILE=.env.production npm run deploy:readiness`.
- Jalankan live E2E generation dari prompt sampai file persisted, refresh project, preview, dan deploy.
- Bersihkan atau replay dead-letter queue setelah pipeline generation stabil.

## Ringkasan Status

Kesimpulan saat ini: codebase sudah jauh lebih siap, tetapi deployment production belum boleh dibuka untuk public launch penuh sampai env worker/observability diset dan live E2E generation terbukti stabil.

Beberapa gate dasar sudah lolos:

- `npm run audit:production-env` lolos.
- `npm run lint`, `npm run typecheck`, dan `npm run build` lolos.
- `npm run deploy:readiness` lolos untuk required checks.
- `npm run postdeploy:health:prod` lolos.
- Auth guard utama untuk dashboard dan endpoint admin/debug sudah bekerja.

Namun masih ada blocker production:

- Reliability generation di production masih buruk.
- Endpoint internal monitoring masih terbuka publik.
- Official production audit masih gagal.
- Preview runtime masih terlalu permisif untuk multi-tenant public.
- Direct worker health belum dikonfigurasi.
- Dependency audit masih menemukan vulnerability moderate.
- CSP belum aktif di response production.

## P0 - Blocker Sebelum Public Launch

### 1. Stabilkan AI generation pipeline

Masalah:

- Telemetry production menunjukkan `generationSuccess` 24 jam masih 0%.
- Ada job gagal dengan error seperti `SWIFT_AI_PROVIDER_FAILOVER_EXHAUSTED`.
- Dead-letter queue masih berisi banyak job.
- Ada indikasi stalled generation.
- Kasus file hilang setelah refresh terjadi karena file yang tampil masih draft artifact, belum masuk `ProjectFile` dan `GenerationHistory`.

Plan perbaikan:

- Freeze public launch sampai generation berhasil stabil secara end-to-end.
- Audit semua job `dead_lettered`, `failed`, `running` terlalu lama, dan stalled.
- Kelompokkan error berdasarkan penyebab: provider failover, timeout worker, parsing gagal, missing file/operation, patch terlalu besar, sandbox/runtime error.
- Perbaiki provider failover supaya tidak langsung habis saat satu provider lambat atau degraded.
- Tambahkan guard agar generation tidak dianggap sukses sebelum event `job.files.persisted` terjadi.
- Pastikan hasil yang sudah tampil sebagai draft bisa dipulihkan setelah refresh, minimal dengan recovery dari artifact/job draft jika persist resmi belum selesai.
- Untuk error `Missing required operation/file`, perketat validasi output model dan repair flow sebelum job masuk dead-letter.
- Bersihkan atau replay dead-letter queue setelah akar masalah diperbaiki.
- Jalankan test prompt nyata beberapa kali dengan skenario kecil, sedang, dan kompleks.

Kriteria selesai:

- Prompt baru berhasil sampai status completed.
- `ProjectFile` terisi setelah generation selesai.
- `GenerationHistory` terisi dan `resultHistoryId` tidak null.
- Setelah refresh, file project tetap muncul.
- Dead-letter queue tidak bertambah untuk prompt normal.
- Success rate generation production minimal stabil di atas 95% untuk batch uji internal.

### 2. Tutup endpoint internal dari akses publik

Masalah:

Endpoint berikut masih bisa diakses tanpa auth/token:

- `/api/metrics`
- `/api/production/monitoring`
- `/api/worker/health`

Risiko:

- Membocorkan worker ID.
- Membocorkan active job ID.
- Membocorkan queue count, dead-letter count, provider chain, dan failure detail.
- Memudahkan pihak luar membaca kondisi internal sistem.

Plan perbaikan:

- Set `SWIFT_METRICS_TOKEN` di environment production.
- Wajibkan bearer token atau admin auth untuk `/api/metrics`.
- Wajibkan admin auth untuk `/api/production/monitoring`.
- Proteksi `/api/worker/health`, atau pindahkan menjadi endpoint internal-only.
- Update `proxy.ts` agar prefix internal seperti `/api/metrics`, `/api/production`, dan `/api/worker` tidak jatuh ke public route.
- Pisahkan public health endpoint menjadi versi minimal, misalnya hanya `status`, `timestamp`, dan request id.

Kriteria selesai:

- Akses tanpa auth ke `/api/metrics` menghasilkan 401 atau 403.
- Akses tanpa auth ke `/api/production/monitoring` menghasilkan 401 atau 403.
- Akses tanpa auth ke `/api/worker/health` menghasilkan 401 atau 403, atau endpoint tidak tersedia publik.
- Public `/api/health` tidak membocorkan job ID, worker ID, provider internal, atau stack detail.

### 3. Konfigurasi dedicated worker health

Masalah:

- `SWIFT_WORKER_HEALTH_URL` bisa belum diset, tetapi ini tidak boleh membuat engine unhealthy jika Redis/BullMQ worker heartbeat fresh.
- Readiness menganggap ini recommended, tetapi checklist launch production memperlakukannya sebagai hal penting.
- Live health masih menunjukkan worker heartbeat dengan identitas lokal seperti `generation:local:*`.
- Ada indikasi stalled generation.

Plan perbaikan:

- Deploy dedicated worker service production.
- Pastikan Redis/BullMQ worker heartbeat production fresh dan queue connected.
- Opsional: set `SWIFT_WORKER_HEALTH_URL` ke endpoint worker production yang benar untuk direct probe.
- Pastikan worker production punya identity yang jelas, bukan `local`.
- Tambahkan alert jika heartbeat stale.
- Tambahkan alert jika active job terlalu lama berada di stage yang sama.
- Pastikan hanya worker production yang consume queue production.

Kriteria selesai:

- Missing `SWIFT_WORKER_HEALTH_URL` hanya tampil sebagai optional/recommended, bukan blocker engine.
- `/api/health` internal menunjukkan worker runtime configured.
- Worker ID production tidak memakai label local.
- Tidak ada stalled generation pada batch uji.

### 4. Hardening preview iframe dan sandbox generated app

Masalah:

- Runtime preview masih memakai kombinasi sandbox permisif seperti `allow-scripts` dan `allow-same-origin`.
- Ada permission tambahan seperti forms, popups, dan downloads.
- Untuk public multi-tenant, generated app harus dianggap untrusted.

Plan perbaikan:

- Hapus `allow-same-origin` dari preview iframe jika memungkinkan.
- Jika generated app butuh origin sendiri, host preview di isolated domain/subdomain yang berbeda dari app utama.
- Batasi `allow-popups`, `allow-forms`, dan `allow-downloads` hanya jika benar-benar dibutuhkan.
- Tambahkan CSP khusus untuk preview.
- Pastikan komunikasi parent-preview hanya lewat `postMessage` dengan origin validation yang ketat.
- Tambahkan test browser untuk memastikan preview tetap jalan setelah sandbox diperketat.

Kriteria selesai:

- Preview generated app tidak berbagi origin dengan dashboard utama.
- Script generated app tidak bisa mengakses storage/cookie app utama.
- Preview tetap bisa render app hasil generation.
- Tidak ada warning internal terkait `allow-scripts allow-same-origin` untuk public multi-tenant.

### 5. Bereskan official production audit

Masalah:

- `npm run audit:production` gagal pada check `ai.single-orchestrator-model`.
- Walaupun build/lint/typecheck lolos, production gate resmi masih merah.

Plan perbaikan:

- Audit `scripts/production-audit.js`.
- Cocokkan ekspektasi audit dengan implementasi aktual di `lib/ai/swift-tiers.ts` dan `lib/ai/openrouter-config.ts`.
- Jika implementasi benar tetapi audit stale, update audit agar mengecek source of truth yang benar.
- Jika implementasi belum sesuai, rapikan model routing supaya hanya satu public builder orchestrator yang digunakan.
- Jalankan ulang audit production sampai 100% lolos.

Kriteria selesai:

- `npm run audit:production` lolos tanpa fail.
- Tidak ada legacy model path yang masih aktif untuk runtime public builder.
- Audit menjadi gate CI/CD sebelum deploy production.

### 6. Selesaikan dependency vulnerability

Masalah:

- `npm audit --omit=dev` masih menemukan vulnerability moderate pada dependency `ws` melalui `ethers` atau `viem`.

Plan perbaikan:

- Jangan langsung menjalankan `npm audit fix --force` tanpa review, karena bisa membawa breaking change.
- Cek versi terbaru `viem`, `ethers`, dan dependency terkait.
- Pilih upgrade minor/patch yang aman jika tersedia.
- Jika perlu pakai override package manager, pastikan kompatibilitas dites.
- Jalankan build, typecheck, test hardening, dan smoke test setelah upgrade.

Kriteria selesai:

- `npm audit --omit=dev` tidak menemukan vulnerability production dependency, atau ada risk acceptance tertulis dengan alasan jelas.
- Fitur billing/wallet/provider yang memakai dependency terkait tetap lolos smoke test.

### 7. Tambahkan Content Security Policy

Masalah:

- Response production sudah punya HSTS, `X-Frame-Options`, `nosniff`, `Referrer-Policy`, dan `Permissions-Policy`.
- Namun belum ada `Content-Security-Policy`.

Plan perbaikan:

- Mulai dari `Content-Security-Policy-Report-Only`.
- Catat domain yang memang dibutuhkan: app domain, auth, payment, analytics, provider asset, sandbox/preview domain.
- Setelah violation bersih, aktifkan CSP enforce.
- Gunakan nonce atau hash jika ada inline script yang memang dibutuhkan.
- Pisahkan CSP dashboard utama dan preview generated app.

Kriteria selesai:

- Header `Content-Security-Policy` aktif di production.
- Tidak ada fitur utama yang rusak karena CSP.
- Preview generated app tetap isolated.

### 8. Rapikan environment sandbox production

Masalah:

- Health live menunjukkan sandbox runtime sehat, tetapi database URL sandbox bisa belum terkonfigurasi di runtime tertentu.
- Jika Swift AI ingin mendukung generated full-stack app, sandbox perlu database/runtime env yang jelas.

Plan perbaikan:

- Pastikan `SWIFT_SANDBOX_DATABASE_URL` dan direct URL terkait tersedia di runtime sandbox production jika fitur full-stack preview membutuhkan database.
- Pastikan sandbox custom domain benar.
- Verifikasi storage sandbox cukup dan cleanup berjalan.
- Tambahkan limit CPU, memory, duration, storage, dan network sesuai profil production.

Kriteria selesai:

- Sandbox health menunjukkan konfigurasi yang dibutuhkan lengkap.
- Generated app dengan route server/database bisa preview tanpa error env.
- Cleanup sandbox berjalan dan terpantau.

## P1 - Perbaikan Penting Setelah P0

### 1. Redaksi public health endpoint

Plan:

- Buat `/api/health` public hanya menampilkan status ringkas.
- Buat `/api/health/internal` atau endpoint admin untuk detail lengkap.
- Sembunyikan job ID, worker ID, provider key, queue internals, dan error detail dari public.

### 2. Monitoring dan alerting production

Plan:

- Tambahkan alert untuk success rate generation turun.
- Tambahkan alert untuk dead-letter queue bertambah.
- Tambahkan alert untuk worker heartbeat stale.
- Tambahkan alert untuk provider degraded terlalu lama.
- Tambahkan alert untuk DB pool mendekati limit.

### 3. Runbook dead-letter dan stalled jobs

Plan:

- Buat command internal untuk inspect DLQ.
- Buat prosedur replay job yang aman.
- Buat prosedur cancel job stuck.
- Simpan alasan dead-letter dengan format yang mudah dicari.

### 4. Abuse prevention untuk public traffic

Plan:

- Review rate limit prompt per menit, generation per jam, dan quota harian.
- Pastikan limit berbeda untuk anonymous, free, dan paid user.
- Tambahkan proteksi abuse pada endpoint generation.
- Pastikan billing/credit tidak bisa double-spend saat retry.

### 5. Legal dan trust page

Plan:

- Pastikan ada Terms of Service.
- Pastikan ada Privacy Policy.
- Pastikan ada refund/payment policy jika ada billing.
- Pastikan kontak support jelas.

## P2 - Penyempurnaan Operasional

### 1. CI/CD gate

Plan:

- Jadikan command berikut sebagai gate sebelum deploy production:
  - `npm run audit:production-env`
  - `npm run audit:production`
  - `npm run typecheck`
  - `npm run build`
  - `npm audit --omit=dev`
  - `npm run test:hardening`
  - `npm run test:resilience`

### 2. Backup dan restore

Plan:

- Pastikan backup database aktif.
- Uji restore database ke environment staging.
- Dokumentasikan RPO dan RTO.

### 3. Observability historis

Plan:

- Simpan metrik generation success per hari.
- Simpan failure reason per provider/model.
- Buat dashboard untuk queue, worker, provider, database, dan billing.

## Urutan Eksekusi Yang Disarankan

### Fase 1 - Tutup risiko exposure

Target: 1 hari.

- Set `SWIFT_METRICS_TOKEN`.
- Proteksi `/api/metrics`.
- Proteksi `/api/production/monitoring`.
- Proteksi `/api/worker/health`.
- Redaksi `/api/health` public.
- Verifikasi unauthenticated request menghasilkan 401 atau 403.

### Fase 2 - Stabilkan generation

Target: 2 sampai 4 hari.

- Audit failed jobs dan dead-letter.
- Perbaiki provider failover.
- Perbaiki timeout/stalled worker.
- Perbaiki draft artifact recovery/persistence.
- Replay atau bersihkan DLQ.
- Jalankan batch prompt internal sampai success rate stabil.

### Fase 3 - Worker dan sandbox production

Target: 1 sampai 2 hari.

- Pastikan worker heartbeat fresh di Redis/BullMQ.
- Opsional: set `SWIFT_WORKER_HEALTH_URL`.
- Pastikan worker production bukan worker local.
- Verifikasi sandbox domain, storage, database env, dan cleanup.
- Tambahkan alert heartbeat dan stalled job.

### Fase 4 - Security hardening

Target: 2 sampai 3 hari.

- Perketat iframe sandbox.
- Tambahkan CSP report-only.
- Resolve dependency audit.
- Jalankan test hardening dan browser smoke test.

### Fase 5 - Final release gate

Target: 1 hari.

- Jalankan semua command verifikasi.
- Jalankan real E2E prompt dari login sampai refresh project.
- Pastikan file tetap muncul setelah refresh.
- Pastikan deploy/preview/upload jika fitur tersebut termasuk public flow.
- Baru buka public traffic bertahap.

## Command Verifikasi

Jalankan sebelum public launch:

```bash
npm run audit:production-env
npm run audit:production
npm run typecheck
npm run build
npm audit --omit=dev
npm run test:hardening
npm run test:resilience
NODE_ENV=production DEPLOY_ENV_FILE=.env.production npm run deploy:readiness
npm run postdeploy:health:prod
```

Verifikasi endpoint public:

```bash
curl -i https://www.ai-swift.biz.id/api/metrics
curl -i https://www.ai-swift.biz.id/api/production/monitoring
curl -i https://www.ai-swift.biz.id/api/worker/health
curl -i https://www.ai-swift.biz.id/api/health
```

Hasil yang diharapkan:

- `/api/metrics` tanpa token harus 401 atau 403.
- `/api/production/monitoring` tanpa admin auth harus 401 atau 403.
- `/api/worker/health` tanpa auth harus 401 atau 403.
- `/api/health` boleh 200, tetapi hanya berisi status ringkas.

## Definition of Production Ready

Swift AI baru layak dibuka publik jika semua kondisi ini terpenuhi:

- Semua P0 selesai.
- `npm run audit:production` lolos.
- `npm audit --omit=dev` bersih atau risk acceptance sudah disetujui.
- Endpoint internal tidak bisa diakses publik.
- Generation end-to-end berhasil dan persist setelah refresh.
- Dead-letter queue tidak bertambah pada prompt normal.
- Worker production terpantau via direct health URL.
- Preview generated app isolated dari dashboard utama.
- CSP aktif.
- Ada monitoring dan alert untuk generation, worker, queue, provider, database, dan billing.

## Catatan Penting

- Jangan membuka public launch penuh hanya karena deploy readiness lolos. Deploy-ready tidak sama dengan public production-ready.
- Jangan menyembunyikan error generation tanpa memperbaiki persist dan dead-letter.
- Jangan commit file `.env*`.
- Jika file environment pernah dibagikan ke pihak luar atau masuk log publik, lakukan rotasi secret.
- Public beta terbatas masih memungkinkan setelah endpoint internal ditutup, tetapi public launch penuh harus menunggu P0 selesai.
