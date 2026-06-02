# Perbaikan Alur Monaco Dulu Baru Sandbox

Tanggal audit: 2026-06-02, timezone Asia/Jakarta.

Dokumen ini dibuat untuk memperbaiki masalah dashboard Swift:

- Explorer menampilkan `No files yet`
- tab Code/Monaco kosong
- preview tidak muncul
- generation gagal dengan pesan `Sandbox storage penuh`
- user mengharapkan hasil AI masuk dulu ke editor Monaco, lalu kalau bisa jalan baru diteruskan ke sandbox

## Kesimpulan Singkat

Status implementasi 2026-06-02:

- draft artifact store sudah ditambahkan lewat `lib/services/generation-draft-artifact.service.ts`
- endpoint draft sudah tersedia di `app/api/generate/jobs/[jobId]/draft/route.ts`
- orchestrator sekarang menyimpan draft setiap `job.files.updated` non-persisted
- dashboard sekarang memuat draft ke Explorer/Monaco sebelum sandbox persist
- browser preview lokal memakai draft jika runtime sandbox belum siap
- autosave resmi, Push GitHub, dan Deploy Vercel ditahan saat status masih `Draft`
- command center dan header menampilkan status `Draft`
- regression guard `generation draft-first editor before sandbox` sudah ditambahkan

Sebelum implementasi ini, Swift memakai alur `production-gate-first`:

1. AI generate artifact/file.
2. Orchestrator validasi syntax, static checks, build, dan runtime smoke.
3. Remote sandbox dipanggil untuk install dependency dan build.
4. Jika semua lolos, file baru dipersist ke database.
5. Dashboard refresh Project API.
6. Monaco/Explorer baru menampilkan file.

Akibatnya, kalau sandbox gagal sebelum persist, Monaco tetap kosong walaupun AI sebenarnya sudah sempat menghasilkan draft file.

Alur yang diinginkan untuk produk seperti Replit/Lovable versi Indonesia adalah `draft-first`:

1. AI generate artifact/file.
2. File valid masuk dulu ke draft workspace.
3. Explorer dan Monaco langsung menampilkan draft.
4. Browser preview lokal mencoba render draft jika memungkinkan.
5. Sandbox install/build/runtime smoke berjalan setelah draft terlihat.
6. Jika sandbox lolos, draft dipromosikan menjadi snapshot/version resmi.
7. Jika sandbox gagal, user tetap bisa melihat dan memperbaiki kode di Monaco.

## Bukti Dari Kode

### Monaco hanya muncul kalau sudah ada file

File:

`components/editor/preview-panel.tsx`

Temuan:

- Monaco di-load dengan `@monaco-editor/react`
- tab Code dan Explorer hanya render editor jika `files.length > 0`
- jika `files.length === 0`, UI menampilkan `No code generated` atau `No files yet`

Artinya Monaco tidak rusak. Monaco hanya belum mendapat file.

### Dashboard mengambil file dari Project API

File:

`app/dashboard/project/[id]/page.tsx`

Temuan:

- `setGeneratedFiles(files)` dipanggil setelah `refreshProjectState(...)`
- sumber file utama adalah API `/api/projects/:id`
- API itu membaca file dari `ProjectFilesystemService.readFiles(id)`

Artinya Explorer/Monaco saat ini bergantung pada file yang sudah dipersist.

### Event file sementara sengaja diabaikan

File:

`app/dashboard/project/[id]/page.tsx`

Temuan:

Client menerima event:

- `job.files.updated`
- `job.files.persisted`
- `files_written`

Tetapi event `job.files.updated` dengan source selain `persisted` diabaikan:

`reason: "explorer_uses_project_api_as_source_of_truth"`

Artinya file hasil slice/repair tidak langsung masuk Monaco. UI menunggu persist resmi.

### Persist terjadi setelah compile gate dan sandbox

File:

`lib/services/generation-orchestrator.service.ts`

Temuan:

- `runValidationLifecycle(...)` menjalankan validasi dan sandbox.
- remote sandbox dipanggil lewat `startConfiguredSandboxService(...)`.
- jika sandbox gagal, validation menjadi gagal.
- `assertCompileGatePassed(validation)` dipanggil sebelum `ProjectFilePersistenceService.saveBufferedArtifacts(...)`.
- jika validation gagal, orchestrator throw sebelum file tersimpan.

Artinya sandbox yang gagal bisa membuat seluruh file tidak pernah muncul di editor.

## Akar Masalah Saat Ini

Root cause langsung dari screenshot:

`Sandbox storage exhausted before installing dependencies: available 0B, required 256MB.`

Root cause produk:

Pipeline terlalu ketat untuk pengalaman builder. File tidak ditampilkan di Monaco sebelum sandbox berhasil.

Root cause operasional:

Railway sandbox runtime storage penuh atau mount volume belum benar.

Health production juga masih menunjukkan blocker:

- `SANDBOX_RUNTIME_HEALTH`
- `GENERATION_WORKER_HEARTBEAT`
- `SWIFT_WORKER_HEALTH_URL` belum diset
- dead-letter queue masih berisi failed jobs
- sandbox health endpoint live masih minimal dan belum expose `runtime.storage`

## Target Perbaikan Produk

Swift harus punya dua level state:

### 1. Draft Workspace

Draft workspace adalah file hasil AI yang sudah lolos kontrak minimum:

- JSON artifact valid
- path aman
- file tidak kosong
- tidak ada `.env`, `.git`, `node_modules`, path absolut, atau traversal

Draft boleh belum lolos sandbox.

Draft harus langsung bisa dilihat di:

- Explorer
- Monaco editor
- browser preview lokal jika memungkinkan
- diagnostics panel

### 2. Verified Snapshot

Verified snapshot adalah file yang sudah lolos:

- syntax validation
- static invariant
- preview compile bila mode browser-only
- typecheck
- build
- runtime smoke
- sandbox validation

Verified snapshot baru boleh dipakai untuk:

- version history resmi
- deploy Vercel
- push GitHub final
- production preview URL

## Checklist Implementasi

### 1. Jangan abaikan `job.files.updated` non-persisted

File:

`app/dashboard/project/[id]/page.tsx`

Perubahan yang dibutuhkan:

- Saat event `job.files.updated` datang dengan source `slice`, `repair`, `seed`, atau scaffold, client harus bisa membaca daftar file draft.
- Jika event hanya membawa paths tanpa content, server harus menyediakan endpoint untuk mengambil draft files.
- Explorer boleh menampilkan badge `Draft`.
- Monaco boleh read/write draft.
- Jangan langsung menganggap draft sebagai snapshot final.

Risiko:

- SSE payload bisa besar jika content file dikirim langsung.

Pilihan aman:

- Event hanya membawa `draftId`, `fileCount`, `manifest`, dan `changedPaths`.
- Client fetch draft dari endpoint khusus.

### 2. Tambahkan endpoint draft generation

Endpoint yang disarankan:

`GET /api/generate/jobs/:jobId/draft`

Response:

```json
{
  "ok": true,
  "jobId": "job-id",
  "status": "draft",
  "files": [
    {
      "path": "app/page.tsx",
      "language": "tsx",
      "content": "..."
    }
  ],
  "manifest": {
    "count": 12,
    "sha256": "..."
  }
}
```

Sumber data bisa dari:

- GenerationJob context/metrics jika ukuran aman
- Redis draft cache dengan TTL
- database table khusus draft artifact

Rekomendasi production:

- Redis untuk draft cepat dengan TTL 30-60 menit
- DB untuk failed generation artifact yang perlu audit

### 3. Simpan draft sebelum sandbox

File:

`lib/services/generation-orchestrator.service.ts`

Titik yang tepat:

- setelah artifact parsed
- setelah path policy valid
- setelah deterministic repair/normalization
- sebelum remote sandbox install/build

Event yang disarankan:

- `job.files.draft_ready`
- `job.files.draft_updated`
- `job.files.draft_failed`

Data event:

- `jobId`
- `projectId`
- `draftId`
- `fileCount`
- `changedPaths`
- `manifest`
- `source`
- `validationStage`

### 4. Pisahkan tab Preview menjadi browser preview dan runtime sandbox

File:

`components/editor/preview-panel.tsx`

Perilaku baru:

- Jika `runtimePreviewUrl` ada, tampilkan iframe sandbox.
- Jika belum ada tapi draft files ada, tampilkan `SandboxPreview` browser-local.
- Jika sandbox gagal, jangan kosongkan file.
- Tampilkan status: `Draft preview`, `Sandbox building`, `Sandbox failed`, atau `Verified`.

Tujuan:

User tetap melihat hasil AI dan bisa edit walaupun sandbox storage sedang penuh.

### 5. Tambahkan status draft di UI

UI perlu membedakan:

- `Draft`
- `Validating`
- `Sandbox failed`
- `Verified`
- `Persisted`
- `Ready to deploy`

Tombol deploy harus disabled jika status belum `Verified` atau `Persisted`.

Tombol save/manual edit boleh aktif untuk draft.

### 6. Ubah persist policy

Saat ini persist diblokir oleh compile gate. Untuk produk builder, perlu dua jenis persist:

#### Draft Persist

Boleh terjadi sebelum sandbox.

Digunakan untuk:

- Monaco
- Explorer
- temporary workspace
- failed job inspection

#### Verified Persist

Tetap harus setelah compile gate.

Digunakan untuk:

- project history official
- rollback
- deploy
- GitHub push final

### 7. Tambahkan guard agar draft tidak dianggap production ready

File terkait:

- `app/api/projects/[id]/deploy/route.ts`
- `app/api/projects/[id]/github/route.ts`
- `app/api/projects/[id]/validate-preview/route.ts`
- `lib/services/project-file-persistence.service.ts`

Guard:

- deploy harus menolak draft yang belum verified
- GitHub push boleh punya mode `draft push` jika user eksplisit memilih
- history official hanya dari verified snapshot
- rollback hanya ke verified snapshot atau draft yang sudah dipromosikan

### 8. Fix sandbox runtime provider

Railway sandbox tetap harus diperbaiki karena production readiness belum sehat.

Yang harus dilakukan di Railway:

- attach Volume
- set Mount Path: `/data`
- set `SWIFT_SANDBOX_ROOT=/data/swift-sandbox`
- redeploy sandbox runtime service dari commit terbaru
- pastikan `/health` mengembalikan `runtime.storage`

Health yang diharapkan:

```json
{
  "ok": true,
  "status": "healthy",
  "runtime": {
    "rootReady": true,
    "storage": {
      "ok": true,
      "availableBytes": 123456789,
      "minFreeBytes": 268435456
    }
  }
}
```

### 9. Fix dedicated worker production

Production queue mode butuh worker.

Yang harus ada:

- deploy service worker terpisah
- command: `npm run worker:generation`
- set `SWIFT_WORKER_HEALTH_URL=https://<worker-domain>/health`
- worker memakai env Redis, database, OpenRouter, sandbox yang sama
- health app tidak lagi menampilkan `GENERATION_WORKER_HEARTBEAT`

### 10. Bersihkan failed jobs setelah provider sehat

Setelah sandbox dan worker sehat:

- cek dead-letter queue
- replay job yang masih relevan
- hapus job gagal lama jika tidak perlu
- jalankan generation prompt ulang

## Prioritas Implementasi

Urutan aman:

1. Buat draft artifact store.
2. Buat endpoint `GET /api/generate/jobs/:jobId/draft`.
3. Ubah event stream agar draft tersedia ke UI.
4. Ubah dashboard agar `job.files.updated` non-persisted mengisi Explorer/Monaco sebagai draft.
5. Tambah status badge draft/verified.
6. Pastikan deploy/GitHub tetap hanya memakai verified snapshot.
7. Perbaiki Railway sandbox volume dan health.
8. Deploy dedicated worker dan set `SWIFT_WORKER_HEALTH_URL`.
9. Jalankan regression dan production health.

## Test Wajib Setelah Implementasi

```powershell
npm run test:artifact-schema
npm run test:generation-runtime-contracts
npm run test:workspace-builder
npm run test:regression
npm run test:hardening
npm run test:path-policy
npm run runtime-smoke
npm run typecheck
npm run lint
npm run build
npm run deploy:readiness
```

Ekspektasi:

- Jika sandbox storage penuh, Explorer tetap menampilkan draft files.
- Monaco bisa membuka dan edit file draft.
- Preview browser-local bisa mencoba render draft.
- Error sandbox muncul sebagai status sandbox, bukan menghapus file.
- Deploy tetap disabled sampai verified.
- Setelah sandbox sehat, draft bisa dipromosikan menjadi verified snapshot.

## Status Production Saat Audit

Belum production ready.

Alasan:

- sandbox storage live gagal dengan `available 0B`
- sandbox health endpoint live belum expose `runtime.storage`
- worker heartbeat belum sehat
- `SWIFT_WORKER_HEALTH_URL` belum tersedia di production
- generation gagal sebelum file persisted, sehingga Monaco kosong

## Definisi Selesai

Swift dianggap siap untuk pengalaman builder production jika:

- prompt baru langsung menghasilkan draft file di Explorer/Monaco
- sandbox gagal tidak membuat editor kosong
- user bisa memperbaiki draft secara manual
- sandbox sehat bisa mempromosikan draft menjadi verified snapshot
- deploy hanya bisa dari verified snapshot
- health endpoint production tidak lagi `503`
- Redis, worker, database, sandbox, OpenRouter, dan deploy provider semuanya healthy
