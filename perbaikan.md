# Perbaikan Error Checkpoint E-Commerce Swift

Dokumen ini dibuat untuk menangani error seperti:

- `Tahap 2: ecommerce routes checkpoint failed`
- `Missing ecommerce route: app/login/page.tsx`
- `Missing ecommerce route: app/admin/page.tsx`

Fokus dokumen ini adalah memperbaiki logika generator Swift supaya prompt e-commerce sederhana tidak gagal terlalu cepat hanya karena route `login` dan `admin` belum dibuat di tahap awal.

---

## 1. Ringkasan Masalah

Saat user menulis prompt seperti:

- `Buat web e-commerce`
- `Buat toko online`
- `Buat marketplace sederhana`

Swift saat ini terlalu cepat menganggap proyek tersebut sebagai `FULLSTACK_COMMERCE`.

Akibatnya:

- planner menambahkan route `login` dan `admin` sejak awal,
- checkpoint fase `routes` mewajibkan route tersebut langsung ada,
- generator gagal sebelum preview storefront dasar sempat lolos,
- user melihat `No preview yet` walau penyebab utamanya adalah validator internal yang terlalu keras.

---

## 2. Hasil Audit

Audit menemukan beberapa sumber masalah yang saling mengunci.

### A. Klasifikasi archetype terlalu agresif

File:

- `lib/ai/architecture-intent.ts`

Masalah:

- domain `commerce_storefront` dan `simple_marketplace` langsung diarahkan ke `FULLSTACK_COMMERCE`
- tidak ada jalur aman untuk storefront e-commerce sederhana yang frontend-first

Efek:

- generator langsung masuk ekspektasi full stack
- route admin dan auth dianggap kebutuhan inti, bukan fitur lanjutan

### B. Planner selalu menambahkan `login` dan `admin`

File:

- `lib/ai/architecture-planner.ts`

Masalah:

- untuk `FULLSTACK_COMMERCE`, planner selalu memasukkan:
  - `app/login/page.tsx`
  - `app/admin/page.tsx`

Efek:

- prompt yang hanya butuh toko online publik tetap dipaksa punya auth dan admin

### C. Checkpoint fase `routes` terlalu keras

File:

- `lib/services/generation-orchestrator.service.ts`

Masalah:

- fase `routes` saat ini mewajibkan sekaligus:
  - `app/products/page.tsx`
  - `app/products/[id]/page.tsx`
  - `app/cart/page.tsx`
  - `app/checkout/page.tsx`
  - `app/login/page.tsx`
  - `app/admin/page.tsx`

Efek:

- generator gagal di Tahap 2 walau storefront inti sebenarnya sudah benar
- frontend-first jadi tidak terasa bertahap

### D. Recovery ikut mengunci constraint yang sama

File:

- `lib/services/generation-orchestrator.service.ts`
- `lib/ai/software-orchestration.ts`

Masalah:

- `ecommerceRequiredFiles()` masih menganggap `login` dan `admin` sebagai file wajib inti
- planner scope e-commerce juga masih memutlakkan route tersebut

Efek:

- retry dan repair akan cenderung mengulang constraint yang sama
- generator sulit turun ke versi storefront minimal yang valid

### E. Ada masalah terpisah pada infra worker production

Audit readiness juga menunjukkan:

- `GENERATION_WORKER_HEARTBEAT` masih gagal

Ini bukan penyebab error checkpoint e-commerce di screenshot, tetapi tetap harus dibereskan karena akan mengganggu generate production setelah bug checkpoint selesai.

---

## 3. Tujuan Perbaikan

Perbaikan dianggap benar jika:

- prompt e-commerce sederhana bisa lolos fase awal tanpa `login` dan `admin`,
- preview storefront bisa muncul lebih cepat,
- route auth/admin hanya diwajibkan jika memang diminta user atau dibutuhkan archetype,
- generator tetap bisa naik ke mode full stack bila prompt memang meminta admin, role, auth, atau backoffice,
- worker heartbeat production tetap dipantau sebagai isu terpisah.

---

## 4. Strategi Perbaikan

## Tahap 1 - Pisahkan E-Commerce Dasar dan Full Commerce

Yang harus diubah:

- jangan semua `commerce_storefront` otomatis dianggap `FULLSTACK_COMMERCE`
- tambahkan jalur yang lebih ringan untuk e-commerce dasar

Opsi implementasi:

1. Tambah archetype baru seperti `COMMERCE_STOREFRONT`
2. Atau tetap pakai `FULLSTACK_COMMERCE`, tetapi jadikan auth/admin kondisional berdasarkan intent

Target:

- prompt seperti `buat web e-commerce` cukup menghasilkan storefront + cart + checkout dulu
- auth/admin baru masuk jika prompt menyebut:
  - admin
  - dashboard admin
  - role
  - staff
  - login
  - autentikasi
  - backoffice

## Tahap 2 - Longgarkan Checkpoint Fase Routes

Yang harus diubah:

- `validateStagedCheckpoint()` untuk fase `routes`

Aturan baru yang direkomendasikan:

Route minimum fase `routes` untuk e-commerce dasar:

- `app/products/page.tsx`
- `app/products/[id]/page.tsx`
- `app/cart/page.tsx`
- `app/checkout/page.tsx`

Route yang hanya wajib jika intent mendukung:

- `app/login/page.tsx`
- `app/admin/page.tsx`

Target:

- Tahap 2 tidak lagi gagal hanya karena auth/admin belum ada
- preview storefront bisa lanjut ke tahap berikutnya

## Tahap 3 - Samakan Scope Planner dengan Checkpoint

Yang harus diubah:

- `ecommerceRequiredFiles()`
- `allowedFilesForPlanner()`
- aturan file plan e-commerce di orchestrator

Prinsip:

- daftar file wajib harus selaras dengan fase
- file inti storefront dan file opsional auth/admin jangan dicampur di level requirement yang sama

Target:

- repair tidak mengulang false requirement
- file yang dikejar AI sesuai tahap aktual

## Tahap 4 - Buat Auth/Admin Menjadi Kondisional

Yang harus diubah:

- `pagesForIntent()` di planner
- logic text matching di orchestrator
- blueprint e-commerce jika perlu

Aturan yang direkomendasikan:

- `app/login/page.tsx` wajib hanya jika:
  - prompt eksplisit minta login/auth
  - atau app memang butuh user account flow

- `app/admin/page.tsx` wajib hanya jika:
  - prompt minta dashboard admin/backoffice
  - atau appType yang dipilih memang admin-heavy

Target:

- e-commerce publik bisa lolos tanpa beban admin panel dari awal

## Tahap 5 - Tambahkan Regression Guard

Yang harus diuji:

1. Prompt e-commerce sederhana
2. Prompt e-commerce + login
3. Prompt e-commerce + admin dashboard
4. Prompt marketplace full stack

Test yang wajib lolos:

- prompt e-commerce sederhana tidak gagal di Tahap 2 hanya karena `login/admin`
- prompt dengan auth memang tetap mewajibkan `login`
- prompt dengan backoffice memang tetap mewajibkan `admin`
- audit dan regression tetap hijau

---

## 5. Perubahan Kode yang Disarankan

Area paling penting:

- `lib/ai/architecture-intent.ts`
- `lib/ai/architecture-planner.ts`
- `lib/services/generation-orchestrator.service.ts`
- `lib/ai/software-orchestration.ts`

Area test/guard:

- `scripts/regression-tests.js`
- `scripts/generation-runtime-contracts.js`
- `scripts/production-audit.js`

---

## 6. Contoh Aturan Yang Benar

### Prompt: `Buat web e-commerce`

Minimal yang boleh lolos:

- home
- product listing
- product detail
- cart
- checkout

Tidak wajib di tahap awal:

- login
- admin
- role management
- API admin

### Prompt: `Buat web e-commerce dengan login user`

Minimal yang wajib:

- semua route storefront dasar
- `app/login/page.tsx`

Masih bisa opsional di tahap lebih belakang:

- admin dashboard

### Prompt: `Buat e-commerce full stack dengan admin panel`

Minimal yang wajib:

- storefront dasar
- `app/login/page.tsx`
- `app/admin/page.tsx`
- endpoint/API/admin support sesuai orchestration

---

## 7. Risiko Jika Tidak Diperbaiki

- user akan terus melihat generate gagal walau storefront inti sudah hampir jadi
- frontend-first terasa bohong karena validator mendorong full stack terlalu cepat
- retry prompt hanya mengulang gagal yang sama
- AI terlihat buruk padahal problem utamanya ada di aturan checkpoint
- conversion user bisa turun karena preview pertama tidak pernah muncul

---

## 8. Isu Terpisah yang Tetap Harus Dipantau

Selain bug checkpoint di atas, repo juga masih menunjukkan:

- `GENERATION_WORKER_HEARTBEAT` belum sehat

Arti praktisnya:

- setelah bug checkpoint dibetulkan, generate production masih tetap perlu dedicated worker yang aktif
- masalah worker ini bukan penyebab langsung screenshot checkpoint e-commerce, tetapi tetap blocker untuk stabilitas production

---

## 9. Definisi Selesai

Perbaikan ini dianggap selesai jika:

- prompt `buat web e-commerce` tidak lagi gagal karena `app/login/page.tsx` dan `app/admin/page.tsx`
- preview storefront dasar bisa muncul sebelum fitur admin/auth lengkap
- auth/admin hanya diwajibkan bila intent benar-benar membutuhkan
- regression test menjaga perilaku baru ini
- worker heartbeat production tetap dipantau lewat readiness terpisah

---

## 10. Kesimpulan

Masalah utama saat ini bukan generator tidak bisa membuat web, tetapi validator e-commerce terlalu cepat memaksa mode full stack.

Fix yang benar bukan sekadar menambah file `login` dan `admin` secara paksa, melainkan:

1. melonggarkan archetype e-commerce dasar
2. membuat checkpoint fase `routes` lebih bertahap
3. menjadikan auth/admin kondisional
4. menyelaraskan planner, checkpoint, dan repair scope

Setelah itu, pengalaman generate akan jauh lebih masuk akal:

- storefront dulu,
- preview muncul dulu,
- full stack menyusul bila memang diminta.
