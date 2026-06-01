# Perbaikan Swift AI Web Builder

Dokumen ini adalah panduan perbaikan untuk mencegah error saat user membuat web di Swift. Fokus utamanya:

1. Generator harus membuat dashboard page-by-page secara berurutan.
2. Frontend harus selesai dulu sebelum backend dihubungkan.
3. Sandbox runtime harus stabil, termasuk integrasi ke Railway.
4. Error queue, preview, build, dan deploy harus punya fallback yang aman.

---

## Tujuan Utama

- Mengurangi kegagalan generasi seperti `queue_enqueue`.
- Membuat proses pembuatan web lebih teratur, bertahap, dan mudah dilanjutkan.
- Menyediakan alur kerja yang jelas dari `prompt -> frontend -> preview -> backend -> sandbox -> deploy`.
- Menjaga user tetap bisa bekerja walau salah satu layanan sementara bermasalah.

---

## Prinsip Wajib

### 1. Frontend-first

- Semua proyek baru harus dimulai dari struktur UI.
- Buat layout, navigasi, halaman, dan state visual terlebih dahulu.
- Jangan sambungkan backend sebelum halaman utama bisa dirender dengan benar.
- Gunakan mock data sementara untuk memastikan UI berjalan.

### 2. Page-by-page

- Generator tidak boleh langsung membuat semua halaman secara acak.
- Halaman harus dibuat berurutan:
  1. Shell / layout utama
  2. Sidebar / header / navigasi
  3. Dashboard utama
  4. Halaman detail berikutnya
  5. Form, tabel, chart, atau komponen tambahan
  6. Integrasi data
  7. Validasi preview
  8. Handoff ke backend / deploy

### 3. Bertahap dan aman

- Setiap tahap harus punya status yang jelas.
- Jika tahap sebelumnya gagal, jangan lanjut ke tahap berikutnya.
- Semua langkah harus bisa diulang tanpa merusak hasil sebelumnya.

### 4. Sandbox-ready

- Setiap proyek harus bisa dijalankan di sandbox environment.
- Runtime sandbox harus memiliki konfigurasi minimal yang konsisten.
- Jika Railway dipakai, pastikan ada health check, port binding, dan log yang mudah dibaca.

---

## Alur Ideal Pembuatan Web

### Tahap 1. Inisialisasi proyek

- Terima prompt user.
- Normalisasi prompt menjadi tujuan proyek.
- Tentukan jenis aplikasi:
  - Landing page
  - Dashboard
  - E-commerce
  - Admin panel
  - Company profile
  - Custom app
- Buat `project manifest` berisi:
  - nama proyek
  - tipe proyek
  - daftar halaman
  - komponen utama
  - data mock
  - status tahap

### Tahap 2. Generate frontend dulu

- Buat struktur layout utama.
- Buat routing / page tree.
- Buat komponen visual dasar.
- Gunakan data dummy jika backend belum siap.
- Pastikan responsif di desktop dan mobile.

### Tahap 3. Preview dan validasi

- Jalankan preview setelah frontend jadi.
- Validasi:
  - halaman bisa dibuka
  - tidak ada error render
  - navigasi berjalan
  - komponen inti tampil
  - tidak ada crash di console

### Tahap 4. Integrasi backend

- Backend hanya dihubungkan setelah frontend stabil.
- Hubungkan API satu per satu.
- Tambahkan error handling di setiap request.
- Gunakan fallback ke mock data jika API gagal.

### Tahap 5. Sandbox Railway

- Proyek bisa dijalankan di sandbox Railway untuk testing.
- Pastikan:
  - `PORT` dibaca dari environment
  - health endpoint tersedia
  - start command jelas
  - log runtime mudah dilacak
  - restart tidak merusak state proyek

### Tahap 6. Deploy / handoff

- Hanya lakukan deploy jika preview lulus validasi.
- Simpan versi build yang sudah lolos.
- Catat semua perubahan penting.

---

## Urutan Dashboard yang Disarankan

Untuk dashboard Swift, gunakan urutan page seperti ini:

1. Dashboard overview
2. Projects list
3. Project detail
4. Builder / prompt page
5. Preview page
6. Code explorer
7. Version history
8. Error log
9. Deploy page
10. Settings page
11. Sandbox / runtime page
12. Billing / usage page jika diperlukan

Urutan ini penting supaya user melihat progres yang logis dan tidak langsung masuk ke area kompleks sebelum fondasi UI selesai.

---

## Pencegahan Error Wajib

### A. Error queue / enqueue

Masalah seperti `queue_enqueue` dan kegagalan Redis/BullMQ harus dicegah dengan cara:

- Cek kesehatan queue sebelum job dikirim.
- Jika queue tidak tersedia, tampilkan fallback yang aman.
- Jika Redis/BullMQ unavailable, jangan gagal diam-diam.
- Beri status jelas: queue down, job ditahan, atau fallback aktif.
- Jangan membiarkan request user hilang tanpa status.
- Simpan status job: `pending`, `running`, `failed`, `done`.
- Gunakan retry dengan batas yang jelas.
- Pakai idempotency key agar job tidak dobel.

### B. Error preview

- Preview harus punya state kosong, loading, error, dan ready.
- Jika preview gagal, tampilkan pesan singkat yang bisa dipahami user.
- Sediakan tombol retry.
- Jangan menampilkan stack trace mentah ke user akhir.

### C. Error build

- Build harus divalidasi sebelum deploy.
- Jika build gagal:
  - simpan log
  - tandai versi gagal
  - jangan menimpa versi yang sudah berhasil

### D. Error runtime sandbox

- Jika sandbox gagal start:
  - cek environment variable
  - cek port
  - cek dependency install
  - cek perintah start
  - cek health endpoint
- Jangan lanjut ke deploy bila sandbox belum sehat.

### E. Error data / state

- Setiap proyek harus punya schema data yang jelas.
- Gunakan default value untuk field wajib.
- Hindari null / undefined yang tidak di-handle.
- Validasi input user sebelum diproses.

---

## Fallback Strategy

Kalau layanan utama bermasalah, sistem harus pindah ke mode aman:

1. Queue gagal -> tampilkan mode fallback dan simpan request.
2. Preview gagal -> tetap simpan file hasil generate.
3. Backend gagal -> tampilkan frontend mock mode.
4. Sandbox Railway gagal -> gunakan run mode alternatif jika tersedia.
5. Deploy gagal -> tetap simpan versi terakhir yang sehat.

Fallback ini penting supaya user tidak kehilangan progres.

---

## Struktur Status yang Disarankan

Gunakan status yang sederhana dan konsisten:

- `draft`
- `queued`
- `building_frontend`
- `preview_ready`
- `integrating_backend`
- `sandbox_running`
- `deploy_ready`
- `deployed`
- `failed`

Setiap status harus punya:

- timestamp
- message singkat
- step aktif
- error terakhir jika ada

---

## Aturan Generasi

- Jangan generate backend sebelum frontend lulus preview.
- Jangan generate banyak page sekaligus tanpa urutan.
- Jangan menimpa file yang sudah valid tanpa backup versi.
- Jangan menganggap job sukses kalau queue hanya menerima request.
- Jangan menunggu tanpa progress update.
- Jangan sembunyikan error teknis dari log internal.

---

## Railway Sandbox Integration

Kalau Railway dipakai sebagai sandbox environment, pastikan:

- Proyek dapat dijalankan dari `start command`.
- Proyek membaca `PORT` dari environment.
- Health endpoint tersedia, misalnya `/health`.
- File system dipakai secara aman, jangan tulis ke lokasi yang tidak stabil.
- Dependency install harus deterministic.
- Log harus bisa dibaca untuk debugging.
- Timeout harus jelas agar job tidak menggantung.

Rekomendasi flow:

1. Generate frontend.
2. Jalankan sandbox Railway.
3. Buka preview URL.
4. Validasi render.
5. Lanjutkan backend.
6. Jalankan ulang sandbox.
7. Final check.

---

## Checklist Validasi Sebelum User Melihat Hasil

- [ ] Layout utama tampil
- [ ] Sidebar / navbar tampil
- [ ] Minimal satu halaman dashboard sukses dibuka
- [ ] Responsif desktop dan mobile
- [ ] Tidak ada error fatal di console
- [ ] Preview tidak blank
- [ ] Retry action tersedia jika gagal
- [ ] Queue status tercatat
- [ ] Sandbox bisa start
- [ ] Health check lolos
- [ ] Backend belum dihubungkan sebelum frontend stabil

---

## Format Prompt Internal yang Disarankan

Saat Swift menerima prompt user, ubah jadi format internal seperti ini:

```text
Tujuan proyek:
- ...

Tipe proyek:
- ...

Urutan halaman:
1. ...
2. ...
3. ...

Frontend plan:
- layout
- navigasi
- komponen utama
- state
- mock data

Backend plan:
- endpoint
- schema
- integrasi bertahap

Sandbox plan:
- start command
- health check
- log
- fallback
```

Format ini membantu generator tetap fokus dan tidak lompat ke tahap yang belum siap.

---

## Definisi Sukses

Sebuah project dianggap berhasil kalau:

- frontend sudah terbentuk dengan urutan halaman yang jelas,
- preview bisa dibuka tanpa error fatal,
- backend terhubung secara bertahap,
- sandbox Railway bisa menjalankan aplikasi,
- user tetap bisa lanjut walau ada error sementara,
- log error bisa dipakai untuk perbaikan berikutnya.

---

## Prioritas Perbaikan

1. Stabilkan queue dan fallback.
2. Paksa frontend-first.
3. Tambahkan status per tahap.
4. Validasi preview sebelum backend.
5. Integrasikan Railway sandbox.
6. Tambahkan logging dan retry.
7. Baru optimalkan deploy.

---

## Catatan Penting

Dokumen ini sengaja dibuat sebagai aturan operasional. Jika ada bagian sistem yang masih langsung membuat error, maka yang diperbaiki dulu adalah alur kerja dan fallback-nya, bukan hanya tampilan error-nya.
