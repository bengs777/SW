# Perbaikan Error AI Generated Invalid Project Structure

Tanggal investigasi: 2026-06-01, timezone Asia/Jakarta.

Dokumen ini fokus pada error dashboard:

`AI generated invalid project structure. Repair loop attempting automatic correction...`

## Status Singkat

Sudah diimplementasikan pada 2026-06-01.

Pesan di UI tetap aman sebagai pesan publik/wrapper, tetapi pipeline sekarang menyimpan diagnostics aman untuk error mentah artifact/path, mengirim event lifecycle repair ke job stream, dan memberi retry prompt detail validator yang lebih actionable.

## Status Implementasi

File yang diubah:

- `lib/ai/generated-artifact.ts`
- `lib/services/generation-orchestrator.service.ts`
- `lib/ai/provider-router.ts`
- `scripts/artifact-schema-regression.js`
- `perbaikan.md`

Yang sudah masuk:

- helper `summarizeArtifactContractError(...)` untuk mengklasifikasikan error menjadi `MALFORMED_GENERATED_ARTIFACT`, `PATH_ERROR`, atau `UNKNOWN_ARTIFACT_ERROR`
- kategori diagnostik aman seperti `path_policy`, `json_envelope`, `schema`, `diagnostic_payload`, `runtime_message`, `missing_required_file`, `empty_files`, dan `unsupported_structure`
- helper `buildArtifactContractRepairInstructions(...)` untuk mengirim detail validator ke retry prompt
- log aman `artifact_parse_failed`, `artifact_path_validation_failed`, `artifact_contract_repair_started`, `artifact_contract_repair_failed`, dan `artifact_contract_repair_succeeded`
- job stream event `artifact_validating`, `artifact_invalid`, `artifact_repairing`, `artifact_repaired`, dan `artifact_repair_failed`
- developer diagnostics sekarang menyimpan ringkasan aman berisi code, category, reason, path/received bila ada, required files, raw hash, raw length, dan artifact audit
- prompt path policy di provider dan orchestrator kembali memuat contoh path kanonik yang eksplisit
- regression test untuk `.env.production`, `files: []`, missing required file, repair instruction block, dan event lifecycle artifact repair

## Gejala

Prompt yang terlihat di dashboard:

`Buat web e-commerce dengan nama jbb untuk role nya admin user seller dan kurir`

Hasil di UI:

- preview tetap kosong
- panel logs menampilkan 1 error
- pesan chat: `AI generated invalid project structure. Repair loop attempting automatic correction...`
- file belum terbentuk untuk preview

## Bukti Dari Log Lampiran

File log lampiran yang diperiksa:

`C:\Users\ibnua\.codex\attachments\d8ffb535-d49f-432b-8616-5e7cd9d2b940\pasted-text.txt`

Isi log hanya menunjukkan sinyal awal job:

- `stream_connected`
- `frontend_notified`
- `job_db_reservation`
- `INSTRUMENTATION_INIT`

Log tersebut belum memuat error low-level seperti:

- `MALFORMED_GENERATED_ARTIFACT`
- `PATH_ERROR`
- `strict-json-schema`
- `diagnostic payload`
- `Unrecognized key(s)`
- `Missing required file`
- `Unsupported artifact structure`

Kesimpulan: dari log lampiran saja belum bisa dipastikan validator mana yang gagal. UI sudah menampilkan pesan wrapper, tetapi error teknis mentah belum ikut muncul di snippet log itu.

## Akar Masalah Yang Paling Mungkin

Pesan UI berasal dari mapper error di:

- `lib/ai/runtime-contracts.ts`
- `app/dashboard/project/[id]/page.tsx`

Mapper itu mengubah error mentah berikut menjadi pesan publik yang sama:

- `MALFORMED_GENERATED_ARTIFACT`
- `PATH_ERROR`
- `strict-json-schema`
- `required`
- `diagnostic payload`
- `Unrecognized key(s)`

Jadi error ini paling mungkin terjadi karena output AI tidak sesuai kontrak artifact, misalnya:

- response model bukan JSON artifact valid
- model mengembalikan payload diagnostik, bukan payload file
- `files` kosong saat mode build mengharuskan file
- `taskGraph` muncul di mode yang hanya menerima `files`
- ada field ekstra yang ditolak strict schema
- ada file wajib yang hilang
- path file tidak masuk allowlist
- path mengandung root/segment terlarang seperti `.env`, `.git`, `node_modules`, path absolut, atau traversal

## File Yang Terlibat

Parser artifact:

- `lib/ai/generated-artifact.ts`

Validator path:

- `lib/ai/file-policy.ts`

Mapper pesan publik:

- `lib/ai/runtime-contracts.ts`
- `app/dashboard/project/[id]/page.tsx`

Orchestrator generation:

- `lib/services/generation-orchestrator.service.ts`

Repair loop preview:

- `app/api/orchestrator/preview-error/route.ts`

Regression guard yang sudah relevan:

- `scripts/artifact-schema-regression.js`
- `scripts/path-policy-regression.js`
- `scripts/generation-runtime-contracts.js`

## Kontrak Path Yang Berlaku

Root generated yang diizinkan:

- `src`
- `app`
- `components`
- `sections`
- `component-registry`
- `lib`
- `prisma`

Root file yang diizinkan:

- `package.json`
- `tsconfig.json`
- `next.config.ts`
- `next.config.js`
- `tailwind.config.ts`
- `tailwind.config.js`
- `postcss.config.js`
- `README.md`
- `.env.example`

Path yang harus tetap ditolak:

- `.env`
- `.env.production`
- `.git`
- `node_modules`
- `package-lock.json`
- `pnpm-lock.yaml`
- `yarn.lock`
- path absolut Windows/Linux
- path yang keluar dari workspace

## Checklist Perbaikan

### 1. Tambahkan logging error mentah yang aman - selesai

Target:

- ketika parser artifact gagal, log harus menyimpan kategori error mentah
- log tidak boleh menyimpan secret atau full artifact besar
- log harus membawa `jobId`, `projectId`, `userId`, `requestId`, dan `correlationId` bila tersedia

Output yang diharapkan:

- `artifact_parse_failed`
- `artifact_path_validation_failed`
- `artifact_contract_repair_started`
- `artifact_contract_repair_failed`
- `artifact_contract_repair_succeeded`

Detail aman yang perlu dicatat:

- error code: `MALFORMED_GENERATED_ARTIFACT` atau `PATH_ERROR`
- reason singkat
- path yang gagal bila ada
- daftar missing files bila ada
- jumlah file artifact
- panjang response provider
- nama model/provider

### 2. Kirim detail validator ke repair prompt - selesai

Saat parser menolak output, repair loop harus menerima detail yang actionable:

- expected schema: artifact harus memakai `files`
- allowed roots
- blocked paths
- missing required files
- contoh path valid
- daftar field yang tidak boleh dipakai

Tujuannya agar repair loop tidak hanya mencoba ulang secara umum, tetapi memperbaiki kontrak yang spesifik.

### 3. Pisahkan error publik dan error diagnostik - selesai

UI publik tetap boleh menampilkan:

`AI generated invalid project structure. Repair loop attempting automatic correction...`

Tetapi panel diagnostics/admin harus bisa melihat:

- code mentah
- alasan validator
- path yang gagal
- fase pipeline
- apakah repair berhasil atau stop

Ini penting karena error sekarang terlalu generik untuk debugging production.

### 4. Perketat fallback JSON parsing - selesai sebagian

Pastikan parser tidak menerima output setengah benar yang bisa membuat repair loop berulang.

Yang sudah dijaga:

- response harus JSON object
- artifact harus berisi `files` valid untuk build output
- tidak boleh menerima runtime message selain artifact
- diagnostic payload harus langsung masuk repair path
- strict schema error harus diringkas menjadi instruksi repair yang jelas

### 5. Tambah regression test - selesai

Test yang perlu ada:

- model mengembalikan diagnostic payload -> UI wrapper muncul, log menyimpan code mentah
- model mengembalikan path `.env.production` -> `PATH_ERROR`, repair mendapat blocked path
- model mengembalikan `node_modules/...` -> `PATH_ERROR`
- model mengembalikan `taskGraph` pada mode strict files only -> `MALFORMED_GENERATED_ARTIFACT`
- model mengembalikan `files: []` -> `MALFORMED_GENERATED_ARTIFACT`
- model menghilangkan file wajib -> `Missing required file`
- repair output valid -> job lanjut ke sandbox/preview
- repair output sama berulang -> loop stop dengan pesan yang jelas

### 6. Tambah event untuk job stream - selesai

Stream job ke dashboard sebaiknya punya event fase contract repair:

- `artifact_validating`
- `artifact_invalid`
- `artifact_repairing`
- `artifact_repaired`
- `artifact_repair_failed`

Dengan begitu user tidak hanya melihat preview kosong, tetapi dashboard tahu bahwa sistem sedang memperbaiki struktur project.

### 7. Verifikasi setelah implementasi - selesai

Jalankan minimal:

```powershell
npm run test:generation-runtime-contracts
npm run test:regression
npm run test:hardening
npm run typecheck
npm run lint
npm run build
```

Hasil verifikasi lokal:

- `npm run test:artifact-schema` PASS
- `npm run test:path-policy` PASS
- `npm run test:generation-runtime-contracts` PASS
- `npm run test:regression` PASS
- `npm run test:hardening` PASS
- `npm run typecheck` PASS
- `npm run lint` PASS
- `npm run build` PASS

Jika ada script regression khusus schema/path, jalankan juga:

```powershell
node scripts/artifact-schema-regression.js
node scripts/path-policy-regression.js
```

Lalu uji prompt yang gagal:

`Buat web e-commerce dengan nama jbb untuk role nya admin user seller dan kurir`

Hasil yang diharapkan:

- jika output AI valid, preview mulai terbentuk
- jika output AI invalid, log diagnostics menampilkan alasan teknis yang jelas
- repair loop tidak berulang tanpa informasi
- error publik tetap aman dan tidak membocorkan payload/secret

## Batasan Investigasi Saat Ini

Log lampiran belum memuat error low-level dari parser/validator, jadi akar spesifiknya belum bisa dipilih antara schema error, path error, missing file, atau diagnostic payload.

Untuk memastikan 100%, perlu salah satu dari:

- log Vercel setelah provider response diproses
- detail job event untuk `cmpv0e5pm0003735vum3ipua3`
- artifact mentah yang diterima parser, dengan secret disensor
- diagnostics panel output jika tersedia

## Prioritas Implementasi

Urutan yang paling aman:

1. Tambah logging diagnostik aman di parser/orchestrator.
2. Tambah event stream untuk fase artifact invalid dan repair.
3. Kirim detail validator ke repair prompt.
4. Tambah regression test untuk schema/path/repair loop.
5. Jalankan ulang prompt e-commerce multi-role.

Dengan urutan ini, kita memperbaiki observability dulu, lalu membuat repair loop lebih pintar. Ini mengurangi risiko kita menambal gejala tanpa tahu bentuk output AI yang sebenarnya.
