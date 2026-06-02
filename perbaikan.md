# Perbaikan Swift AI Production Ready

Tanggal audit: 2026-06-02

## Status Saat Ini

- Sandbox runtime sudah dipasang di Railway.
- Production health masih belum lulus.
- Blocking failure utama saat ini:
  - `SANDBOX_RUNTIME_HEALTH`
  - `GENERATION_WORKER_HEARTBEAT`
- Sandbox health endpoint masih mengembalikan payload lama:
  - `service: "swift-sandbox-service"`
  - belum ada `runtime.storage`
- Production health checker sudah mengharapkan:
  - `runtime.storage.availableBytes`
  - `runtime.storage.minFreeBytes`

## Tujuan

Membuat Swift AI benar-benar siap production sebagai builder web:

- Draft AI tampil dulu di Monaco/Explorer.
- Preview tidak gagal karena dependency registry hilang.
- Sandbox dipakai untuk validasi runtime setelah draft tersedia.
- Push GitHub dan Deploy Vercel hanya aktif setelah sandbox verified.
- `/api/health?refreshProvider=true` kembali `200`.

## Yang Sudah Beres

- Draft preview registry dependency sudah diperbaiki.
- `app/page.tsx` yang mengimpor `@/component-registry/navbar` dan `footer` sudah dibantu oleh draft file closure.
- Perubahan ini sudah ada di commit `373f9d6`.

## Sumber Masalah Saat Ini

### 1. Sandbox health masih stale

Health production memanggil:

```txt
https://swift-sandbox-service-production.up.railway.app/health
```

Payload yang masih keluar sekarang hanya seperti ini:

```json
{"ok":true,"service":"swift-sandbox-service"}
```

Masalahnya:

- health endpoint itu belum mengirim `runtime.storage`
- nama service yang tampil masih `swift-sandbox-service`, bukan `swift-sandbox-runtime`
- readiness checker menganggap endpoint itu belum valid

### 2. Storage sandbox belum dipakai sebagai storage persisten

Sandbox runtime masih bisa jatuh ke storage temporary seperti `/tmp`, sehingga dependency install bisa gagal saat ruang habis.

### 3. Worker dedicated belum terhubung ke health

Production masih menunggu:

- `SWIFT_WORKER_HEALTH_URL`
- worker heartbeat yang fresh

### 4. Token deploy Vercel belum valid

Masih ada env production yang perlu dibenahi:

- `VERPRO_ACCES_TOKEN`

## Urutan Perbaikan

### Langkah 1: Benarkan health contract sandbox

Edit sandbox runtime agar `/health` mengembalikan struktur yang dipakai production checker.

File terkait:

- [services/sandbox-runtime/server.mjs](<C:/Users/ibnua/Desktop/SOSIAL MEDIA/SWIFT AI/SW/services/sandbox-runtime/server.mjs>)
- [lib/observability/external-runtime-health.ts](<C:/Users/ibnua/Desktop/SOSIAL MEDIA/SWIFT AI/SW/lib/observability/external-runtime-health.ts>)
- [scripts/deploy-readiness.js](<C:/Users/ibnua/Desktop/SOSIAL MEDIA/SWIFT AI/SW/scripts/deploy-readiness.js>)

Target payload:

```json
{
  "ok": true,
  "service": "swift-sandbox-runtime",
  "runtime": {
    "storage": {
      "availableBytes": 123456789,
      "minFreeBytes": 268435456
    }
  }
}
```

Kalau endpoint masih mengembalikan `swift-sandbox-service`, berarti:

- Railway masih menjalankan image lama, atau
- service yang dipanggil bukan deploy terbaru, atau
- health route belum di-update ke schema baru.

### Langkah 2: Pakai volume Railway yang persisten

Pastikan Railway service sandbox punya volume yang cukup, lalu mount ke path permanen.

Rekomendasi:

- mount path: `/data`
- env: `SWIFT_SANDBOX_ROOT=/data/swift-sandbox`

Jangan pakai `/tmp` untuk storage runtime produksi.

### Langkah 3: Redeploy sandbox runtime

Setelah volume dan env benar:

- redeploy sandbox runtime
- cek `/health`
- pastikan `runtime.storage.availableBytes` tidak `0`
- pastikan `ok: true`
- pastikan status health tidak lagi stale

### Langkah 4: Set health URL worker

Tambahkan env production:

```txt
SWIFT_WORKER_HEALTH_URL=https://<url-worker>/health
```

Pastikan worker dedicated:

- benar-benar hidup sebagai service terpisah
- mengembalikan HTTP `200`
- heartbeat-nya masuk ke production health

### Langkah 5: Benarkan env production Vercel

Cek environment variables production di Vercel:

- `SANDBOX_SERVICE_URL`
- `SANDBOX_SERVICE_TOKEN`
- `SWIFT_WORKER_HEALTH_URL`
- `VERPRO_ACCES_TOKEN`

Pastikan semuanya menunjuk ke service production yang benar.

### Langkah 6: Bersihkan dead-letter queue

Setelah sandbox dan worker sehat:

- cek job gagal lama
- replay job yang masih relevan
- hapus job lama yang memang sudah tidak diperlukan

Jangan replay dulu sebelum health hijau, karena nanti gagal ulang.

### Langkah 7: Verifikasi produksi

Jalankan cek ini:

- `https://www.ai-swift.biz.id/api/health?refreshProvider=true`
- `https://swift-sandbox-service-production.up.railway.app/health`

Yang harus terjadi:

- `api/health` status `200`
- `blockingFailures` kosong
- `SANDBOX_RUNTIME_HEALTH` hilang
- `GENERATION_WORKER_HEARTBEAT` hilang
- sandbox health mengandung `runtime.storage`
- preview draft bisa muncul sebelum sandbox selesai

## Checklist Siap Production

- `/api/health?refreshProvider=true` HTTP `200`
- `database`, `auth`, `queue`, `worker`, `deployment`, dan `providers` healthy
- sandbox runtime mengembalikan `runtime.storage`
- sandbox runtime memakai volume persisten
- worker dedicated punya health URL
- deploy token Vercel valid
- preview draft tampil di Monaco/Explorer
- push GitHub dan Deploy Vercel tetap terkunci sampai sandbox verified

## Catatan Keamanan

- Jangan commit `.env`, `.env.production`, token, API key, private key, atau secret lain.
- Kalau secret pernah tersebar, rotasi dulu sebelum final production.
- Jangan gunakan storage sementara untuk runtime produksi.

