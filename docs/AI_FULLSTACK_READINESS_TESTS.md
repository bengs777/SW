# Swift AI Full-Stack Readiness Tests

Tujuan dokumen ini adalah menilai output AI dengan bukti teknis, bukan feeling dari preview.

## Cara Pakai

1. Jalankan prompt test secara berurutan di project yang sama.
2. Setelah setiap generate, export project atau cek generation history terbaru.
3. Jalankan audit statis:

```bash
npm run audit:fullstack -- --dir ./path/to/exported-project
```

Atau audit generation history terbaru dari database Swift:

```bash
npm run audit:fullstack -- --history latest
```

Gunakan hasil script sebagai bukti awal, lalu tetap lakukan browser/runtime check untuk persistence dan refresh.

## Test 1: Full-Stack Nyata

Prompt:

```text
Buat aplikasi todo dengan:
- login user (email/password sederhana)
- simpan todo ke database (Prisma)
- API route untuk create, list, delete
- frontend harus fetch dari API (bukan state lokal)
- tampilkan daftar todo milik user yang login
```

Wajib lulus:

- Ada `prisma/schema.prisma` dengan model user dan todo.
- Ada API todo dengan `GET`, `POST`, dan `DELETE`.
- API memakai Prisma query/mutation, bukan array lokal.
- Frontend memanggil API memakai `fetch`.
- UI tidak hanya menyimpan todo di `useState` tanpa API.
- Setelah refresh, data tetap ada.

Fail jika:

- Prisma hanya placeholder.
- API route ada tapi tidak memakai database.
- Todo hilang setelah refresh.
- Todo user tidak scoped ke user login.

## Test 2: Integration Stress

Prompt lanjutan:

```text
Tambahkan fitur filter todo berdasarkan status (done / not done)
dan pastikan filtering dilakukan di backend (API), bukan frontend
```

Wajib lulus:

- API berubah untuk menerima `status`, `done`, atau query param sejenis.
- Query Prisma memakai `where` untuk filter status.
- Frontend mengirim filter ke API.
- UI menyesuaikan hasil dari API, bukan `.filter()` lokal sebagai sumber utama.

Fail jika:

- Filter hanya dilakukan di frontend.
- API tidak berubah.
- Query DB tidak berubah.

## Test 3: Error Fixing

Sebelum prompt, paksa error manual:

- Rename API route todo, atau
- Hapus import penting dari halaman todo.

Prompt:

```text
Fix error yang terjadi tanpa menghapus fitur yang sudah ada
```

Wajib lulus:

- AI patch file yang rusak.
- Fitur login, list, create, delete, dan filter tetap ada.
- File lama tidak hilang tanpa alasan.
- Tidak regenerate project dari nol.

Fail jika:

- AI mengganti project menjadi scaffold baru.
- Fitur lama hilang.
- Error hilang tapi data flow todo rusak.

## Test 4: Context Consistency

Prompt:

```text
Tambahkan fitur edit todo tanpa merusak fitur sebelumnya
```

Wajib lulus:

- API lama `GET`, `POST`, `DELETE` tetap ada.
- Ada endpoint atau method update, misalnya `PATCH`.
- Frontend create/list/delete/filter masih jalan.
- Edit memakai API dan data tetap persist setelah refresh.

Fail jika:

- API lama hilang.
- Todo lama tidak bisa dibuat/dihapus.
- Edit hanya state lokal.

## Test 5: Sandbox Recovery

Simulasikan error:

- Hapus dependency dari `package.json`, atau
- Rusak `.env.example` / env reference.

Prompt:

```text
Perbaiki agar aplikasi bisa dijalankan kembali
```

Wajib lulus:

- AI fokus ke dependency/env yang rusak.
- Tidak menambah fitur baru yang tidak diminta.
- Build/dev server kembali jalan.

Fail jika:

- AI membuat UI baru.
- Masalah dependency/env tidak disentuh.
- Build tetap gagal.

## Scorecard

| Test | Pass/Fail | Bukti |
| --- | --- | --- |
| Full-stack real |  |  |
| Integration |  |  |
| Auto-repair |  |  |
| Context consistency |  |  |
| Sandbox recovery |  |  |

Jika dua test atau lebih fail, sistem belum ready untuk claim full-stack generation.

