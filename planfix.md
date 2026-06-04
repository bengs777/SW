# Plan Perbaikan AI Full Stack Swift

Tanggal rencana: 2026-06-04

Sumber: `analisis.md`

## Tujuan

Membuat alur AI full-stack Swift kembali stabil sampai bisa:

- Generate project full-stack minimal.
- Menyimpan file ke project.
- Lolos validasi sandbox.
- Preview terbuka.
- Dead-letter tidak bertambah.
- Worker memakai runtime terbaru.

## Ringkasan Masalah

Berdasarkan `analisis.md`, penyebab utama kegagalan adalah:

1. OpenRouter free model/fallback tidak stabil untuk full-stack besar.
2. Worker live masih memakai timeout `500000 ms`, padahal target terbaru `900000 ms`.
3. Dead-letter queue bertambah sampai `13`.
4. Ada race condition `GenerationEvent` sequence:

```text
Unique constraint failed on the fields: (jobId, sequence)
```

5. `SWIFT_WORKER_HEALTH_URL` belum dikonfigurasi.
6. Sandbox sehat tetapi `hasDatabaseUrl:false`.
7. Repair terlalu sempit untuk kegagalan full-stack besar.

## Prinsip Pelaksanaan

- Jangan ubah schema database dulu.
- Jangan upgrade Prisma.
- Jangan ubah NextAuth.
- Jangan upload atau commit file `.env`.
- Jangan replay dead-letter sebelum root cause utama diperbaiki.
- Perbaikan kode harus minimal dan aman.
- Setelah setiap tahap, jalankan validasi.

## Tahap 1 - Patch Race Condition GenerationEvent

### Masalah

`GenerationJobService.appendEvent` memakai pola:

1. Baca max sequence.
2. Tambah 1.
3. Insert event.

Jika dua event untuk job yang sama terjadi paralel, keduanya bisa memakai sequence yang sama dan gagal karena:

```text
@@unique([jobId, sequence])
```

### File yang perlu diubah

```text
lib/services/generation-job.service.ts
```

### Rencana kode

Tambahkan retry khusus untuk Prisma `P2002` pada `appendEvent`.

Target behavior:

- Coba insert event.
- Jika gagal karena duplicate `(jobId, sequence)`, ulangi sampai 3 kali.
- Tiap retry baca ulang max sequence.
- Jika tetap gagal, baru throw error.

Pseudo implementasi:

```ts
static async appendEvent(input: AppendGenerationEventInput) {
  const maxAttempts = 3

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const sequence = await nextEventSequence(tx, input.jobId)
        return tx.generationEvent.create({ data: { ... } })
      })
    } catch (error) {
      if (!isDuplicateGenerationEventSequenceError(error) || attempt === maxAttempts) {
        throw error
      }
      await sleep(25 * attempt)
    }
  }
}
```

Tambahkan helper:

```ts
function isDuplicateGenerationEventSequenceError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002" &&
    Array.isArray(error.meta?.target) &&
    error.meta.target.includes("jobId") &&
    error.meta.target.includes("sequence")
}
```

### Test setelah patch

```bash
npm run lint
npm run typecheck
npm run build
```

Opsional regression:

```bash
npm run test:queue-reconciliation
npm run test:worker-crash
```

### Kriteria sukses

- Tidak ada TypeScript error.
- Build lolos.
- Error `Unique constraint failed on the fields: (jobId, sequence)` tidak muncul lagi di runtime failure baru.

## Tahap 2 - Update dan Restart Worker VPS

### Masalah

Worker live masih menunjukkan:

```text
idleTimeoutMs: 500000
stalledGenerationDetected: true
```

Padahal target runtime sekarang:

```text
900000 ms
```

### Langkah di VPS

Masuk VPS worker:

```bash
ssh root@8.215.40.119
```

Cek service:

```bash
pm2 status
pm2 logs --lines 100
```

Update repo worker:

```bash
cd /path/to/SW
git pull origin main
npm install
npm run db:generate
```

Pastikan env worker memuat timeout:

```bash
pm2 env <id-worker> | grep -E "TIMEOUT|SWIFT|OPENROUTER|REDIS|SANDBOX"
```

Target env worker:

```env
AI_QUEUE_TIMEOUT_MS=900000
SWIFT_GENERATION_JOB_TIMEOUT_MS=900000
AI_PROVIDER_REQUEST_BUDGET_MS=240000
OPENROUTER_HARD_TIMEOUT_MS=240000
SWIFT_GENERATION_EXECUTION_MODE=queue
SWIFT_DISABLE_SERVERLESS_GENERATION_FALLBACK=true
```

Restart worker:

```bash
pm2 restart <id-worker>
pm2 save
```

### Verifikasi

```bash
curl https://www.ai-swift.biz.id/api/worker/health
```

Target:

```text
idleTimeoutMs >= 900000
stalledGenerationDetected: false
worker heartbeat fresh
```

## Tahap 3 - Tambahkan Worker Health URL

### Masalah

Production readiness masih degraded karena:

```text
SWIFT_WORKER_HEALTH_URL: missing
```

### Rencana

Expose endpoint health worker yang bisa diprobe:

```text
https://worker.ai-swift.biz.id/health
```

Atau endpoint lain yang mengarah ke service worker.

Set di Vercel:

```env
SWIFT_WORKER_HEALTH_URL=https://worker.ai-swift.biz.id/health
```

### Verifikasi

```bash
curl https://worker.ai-swift.biz.id/health
curl https://www.ai-swift.biz.id/api/worker/health
```

Target:

```text
workerService.configured: true
workerService.ok: true
```

## Tahap 4 - Tambahkan Database Sandbox

### Masalah

Sandbox health:

```text
hasDatabaseUrl: false
```

Full-stack yang memakai Prisma/API/database tidak bisa diuji penuh.

### Rencana

Buat database sandbox terpisah dari production.

Set env di VPS sandbox:

```env
SWIFT_SANDBOX_DATABASE_URL=postgresql://USER:PASSWORD@HOST/neondb?sslmode=require
SWIFT_SANDBOX_DIRECT_DATABASE_URL=postgresql://USER:PASSWORD@HOST/neondb?sslmode=require
```

Restart sandbox runtime:

```bash
pm2 restart <id-sandbox>
pm2 save
```

### Verifikasi

```bash
curl https://sandbox.ai-swift.biz.id/health
```

Target:

```text
hasDatabaseUrl: true
status: healthy
storage.ok: true
```

## Tahap 5 - Audit dan Bersihkan Dead-letter Queue

### Masalah

Dead-letter queue sudah berisi:

```text
waiting: 13
```

### Rencana

Jangan langsung replay semua.

Urutan:

1. Export daftar dead-letter.
2. Kelompokkan berdasarkan error:
   - `SWIFT_AI_PROVIDER_FAILOVER_EXHAUSTED`
   - `Generation timed out`
   - `Repair timeout`
   - `Unique constraint failed`
   - sandbox/build error
3. Hapus job yang sudah tidak relevan.
4. Replay hanya job yang masih valid setelah worker dan event sequence fix.

### Endpoint/command kandidat

Jika endpoint admin tersedia:

```bash
curl https://www.ai-swift.biz.id/api/admin/jobs/dead-letter/replay
```

Jika ada script internal, pakai script queue/admin yang sudah ada di repo. Jika belum ada, buat script kecil khusus audit dead-letter tanpa menyentuh env.

### Kriteria sukses

```text
deadLetter.waiting: 0
```

Atau minimal semua job dead-letter sudah punya alasan yang jelas.

## Tahap 6 - Stabilkan Provider OpenRouter

### Masalah

Primary sehat untuk health kecil, tetapi full-stack besar gagal dengan:

```text
SWIFT_AI_PROVIDER_FAILOVER_EXHAUSTED
```

Fallback `openrouter/owl-alpha` timeout saat health refresh.

### Rencana Env

Tetap OpenRouter, tetapi pakai chain yang lebih masuk akal:

```env
OPENROUTER_MODEL=poolside/laguna-xs.2:free
SWIFT_FALLBACK_MODEL_1=poolside/laguna-m.1:free
SWIFT_AI_PROVIDER_NAME=openrouter
```

Jika `SWIFT_FALLBACK_MODEL_1` belum dibaca oleh `openrouter-config`, patch kecil agar fallback env ikut masuk chain.

### File kandidat jika perlu patch

```text
lib/ai/openrouter-config.ts
lib/ai/swift-tiers.ts
```

### Kriteria sukses

- Provider health primary healthy.
- Fallback tidak selalu timeout.
- Full-stack minimal tidak lagi langsung provider exhausted.

## Tahap 7 - Ubah Strategi Full-stack Menjadi Bertahap

### Masalah

Prompt full-stack besar terlalu berat jika diproses sekali jalan oleh free model.

### Rencana Product Flow

Untuk prompt besar, sistem harus membuat urutan:

1. Scaffold full-stack minimal.
2. Validasi sandbox.
3. Tambah CRUD utama.
4. Validasi lagi.
5. Tambah auth/role.
6. Validasi lagi.
7. Tambah payment/upload/admin jika diminta.

### File kandidat

```text
lib/services/generation-orchestrator.service.ts
lib/ai/software-orchestration.ts
lib/ai/architecture-intent.ts
```

### Perubahan minimal

- Jika `production_fullstack` dan prompt terlalu besar, batasi pass pertama ke scaffold minimal.
- Simpan `next_steps` di diagnostics/metadata.
- UI memberitahu user bahwa tahap pertama adalah baseline deployable.

### Kriteria sukses

Prompt besar tidak langsung gagal total.

## Tahap 8 - Perjelas Error di UI

### Masalah

User sering hanya melihat pesan generik:

```text
Swift AI sedang mengalami gangguan sementara...
```

Padahal penyebab bisa berbeda.

### Rencana

Pisahkan label error:

- Provider timeout.
- Provider exhausted.
- Worker timeout.
- Dead-lettered.
- Sandbox build failed.
- Missing full-stack category.
- Event log race.
- Insufficient balance/rate limit.

### File kandidat

```text
components/editor/chat-panel.tsx
components/editor/error-log-panel.tsx
app/api/generate/jobs/[jobId]/status/route.ts
lib/services/generation-job.service.ts
```

### Kriteria sukses

User tahu harus klik retry, tunggu worker, atau lapor sandbox/build issue.

## Tahap 9 - Smoke Test Setelah Semua Perbaikan

### Test A - Frontend ringan

Prompt:

```text
Buat landing page toko kopi modern dengan navbar, hero, produk unggulan, testimoni, CTA, dan footer.
```

Harus:

- Generate selesai.
- File muncul di editor.
- Preview valid.
- Tidak masuk dead-letter.

### Test B - Full-stack minimal

Prompt:

```text
Buat aplikasi full-stack todo sederhana dengan Prisma schema, API route CRUD, halaman UI untuk list/create/delete todo, dan .env.example.
```

Harus ada:

```text
app/page.tsx
app/api/.../route.ts
prisma/schema.prisma
package.json atau config
.env.example
```

Harus:

- Full-stack validator lolos.
- Sandbox build lolos.
- Preview terbuka.
- Dead-letter tidak bertambah.

### Test C - Health final

```bash
curl https://www.ai-swift.biz.id/api/health?refreshProvider=true
curl https://www.ai-swift.biz.id/api/provider/health
curl https://www.ai-swift.biz.id/api/worker/health
curl https://sandbox.ai-swift.biz.id/health
```

Target:

```text
status: healthy
deadLetter.waiting: 0
idleTimeoutMs >= 900000
stalledGenerationDetected: false
sandbox.hasDatabaseUrl: true
workerService.ok: true
```

## Tahap 10 - Deploy dan GitHub

Jika patch kode sudah dibuat dan test lolos:

```bash
npm run lint
npm run typecheck
npm run build
git status --short
git add <file-yang-diubah>
git commit -m "Stabilize full-stack generation runtime"
git push origin main
```

Catatan:

- Jangan `git add .` jika ada file `.env`.
- Jangan commit `.env*`.
- Jika `ceking.md` atau `planperbaikan.md` masih deleted dari perubahan lama, jangan ikut commit kecuali memang diminta.

## Urutan Eksekusi yang Direkomendasikan

1. Patch `GenerationJobService.appendEvent`.
2. Test lokal: lint, typecheck, build.
3. Commit dan push patch kode.
4. Redeploy Vercel.
5. Pull commit terbaru di VPS worker.
6. Restart worker.
7. Set database sandbox dan restart sandbox.
8. Set `SWIFT_WORKER_HEALTH_URL`.
9. Audit dead-letter.
10. Jalankan smoke test frontend.
11. Jalankan smoke test full-stack minimal.
12. Bersihkan/replay dead-letter yang valid.

## Kriteria Production Ready Setelah Fix

Swift AI dianggap siap lagi untuk full-stack jika:

- `SWIFT_AI_PROVIDER_FAILOVER_EXHAUSTED` tidak muncul di smoke test.
- `Generation timed out after 500s` tidak muncul lagi.
- `Unique constraint failed on (jobId, sequence)` tidak muncul lagi.
- Worker heartbeat fresh dan tidak stalled.
- Dead-letter tidak bertambah saat smoke test.
- Sandbox health punya database URL.
- Full-stack minimal berhasil sampai preview.

