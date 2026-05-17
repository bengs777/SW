
---

## 📌 FASE 1: FONDASI ARSITEKTUR DATA & SISTEM FILE
*Target: Mengubah manipulasi file statis tunggal menjadi Virtual File System (VFS) multi-file berbasis memori.*

### 1.1 Struktur State File Global (Client-Side)
Aplikasi wajib mengelola seluruh struktur folder proyek dalam bentuk objek JSON datar (*flat key-value object*) untuk mempermudah mutasi state instan.
```typescript
interface VirtualFileSystem {
  [filePath: string]: string; // Key: Path file relatif, Value: Isi teks kode pemrograman
}

// Contoh State Riwayat Proyek:
const initialVFS: VirtualFileSystem = {
  "package.json": "{\n  \"dependencies\": {\n    \"lucide-react\": \"latest\"\n  }\n}",
  "app/page.tsx": "export default function Page() { return <h1>Swift Engine</h1> }",
  "app/api/news/route.ts": "export async function GET() { return Response.json({ data: [] }) }"
};
```

### 1.2 Sinkronisasi Real-Time Menggunakan Server-Sent Events (SSE)
*   **Backend (`generation-orchestrator.service.ts`)**: Event `job.files.updated` harus memancarkan data pecahan (*chunks*) berbasis delta terkompresi. Jangan mengirim ulang seluruh isi berkas file jika hanya ada perubahan kecil.
*   **Client (`page.tsx`)**: Begitu token data masuk, parser langsung melakukan penggabungan (*shallow merge*) ke dalam state VFS global tanpa merusak UI.

---

## 💻 FASE 2: OPTIMALISASI RUANG KERJA MONACO EDITOR
*Target: Integrasi penuh penjelajah folder (File Tree) dengan Monaco Editor secara responsif.*

### 2.1 Sinkronisasi Penjelajah Berkas (Explorer Component)
*   **Sisi Kiri (File Tree Components)**: Membaca kunci teks (*keys*) dari objek JSON `VirtualFileSystem`, memisahkan karakter garis miring (`/`), dan menyusunnya menjadi visual direktori folder interaktif.
*   **Sisi Kanan (Monaco Editor)**: Saat berkas file di-klik oleh pengguna, Monaco Editor wajib:
    1. Mengganti isi teks visual sesuai value state file.
    2. Melakukan deteksi otomatis (*auto-detect extension*) untuk mengubah penyorotan bahasa sintaks (`.tsx` ➔ `typescript`, `.json` ➔ `json`, `.css` ➔ `css`).

### 2.2 Hubungan Komunikasi Dua Arah (Two-Way Data Binding)
*   **AI Generating Status**: Ketika AI sedang melakukan *streaming text input*, kunci (*read-only = true*) Monaco Editor khusus untuk file yang sedang dimodifikasi tersebut demi mencegah tabrakan data (*race condition*).
*   **User Editing Status**: Saat status kecerdasan buatan dalam posisi diam (*idle*), buka kunci editor. Setiap ketikan manual pengguna di Monaco Editor wajib memicu perubahan state VFS secara *real-time* yang otomatis memperbarui tampilan visual panel pratinjau.

---

## ⚡ FASE 3: MESIN SANDBOX PREVIEW TANPA SERVER (ZERO-COST RUNTIME)
*Target: Menjalankan eksekusi backend fungsional Next.js tanpa membebani biaya VPS/Railway berbayar.*

### 3.1 Pilihan Utama: WebContainers API (@webcontainer/api)
Gunakan tumpukan teknologi berbasis WebAssembly dari StackBlitz untuk menjalankan Node.js langsung di tab peramban pengguna.
```typescript
// Alur Kerja Inisialisasi Terminal di Browser
import { WebContainer } from '@webcontainer/api';

async function startDevServer() {
  const webcontainerInstance = await WebContainer.boot();
  await webcontainerInstance.mount(initialVFS);
  
  const installProcess = await webcontainerInstance.spawn('npm', ['install']);
  if ((await installProcess.exit) !== 0) throw new Error('Instalasi Dependensi Gagal');

  // Menjalankan perintah npm run dev secara lokal
  webcontainerInstance.on('server-ready', (port, url) => {
    document.getElementById('preview-iframe').src = url;
  });
}
```

### 3.2 Opsi Alternatif: Client-Side Router & SDK Mocking Injection
Jika WebContainer terlalu lambat di komputer spesifikasi rendah, gunakan teknik injeksi URL Blob:
*   Mata-matai perintah global `window.fetch` di dalam `<iframe>`.
*   Jika aplikasi hasil buatan AI menembak endpoint internal seperti `/api/news`, cegat permintaan tersebut dan jalankan fungsi JavaScript backend dari VFS berkas `app/api/news/route.ts` secara dinamis.

---

## 🧠 FASE 4: INSTANSINASI SISTEM PROMPT & INTEGRASI OPENROUTER
*Target: Menjinakkan model LLM (DeepSeek R1/V3) agar patuh pada kategori industri pengguna.*

### 4.1 Pembuatan Berkas Benih Dinamis (Dynamic Seeding Strategy)
Sistem dilarang keras menggunakan satu templat awal universal. Backend wajib melakukan pengkondisian klasifikasi kata kunci (*keyword matching*):
*   Prompt mengandung kata `berita`, `portal`, `majalah` ➔ Gunakan Benih Artikel & Blog Statis.
*   Prompt mengandung kata `toko`, `dagang`, `pasar` ➔ Gunakan Benih Katalog E-Commerce Terbuka.

### 4.2 Aturan Baku Instruksi Sistem (Strict System Prompt Definition)
Suntikkan teks instruksi di bawah ini ke dalam variabel payload OpenRouter di file `generation-orchestrator.service.ts`:
```text
[STRICT RULE] Anda adalah mesin generator Next.js 14 App Router. 
Hasilkan kode bersih yang HANYA berfokus pada industri yang diminta oleh pengguna. 
DILARANG KERAS berasumsi atau memasukkan komponen finansial, dasbor SaaS, metrik pendapatan, tingkat konversi bisnis, atau grafik keuangan jika pengguna meminta kategori non-komersial (seperti portal berita desa, portofolio pribadi, atau web hobi). Fokus pada fungsionalitas murni sesuai teks prompt pengguna.
```

### 4.3 Strategi Generasi Bertahap Anti-Timeout (Preview-First Slicing)
Generator dilarang membuat 10-15 file sekaligus pada awal proyek. Siklus pertama wajib berupa pondasi pratinjau kecil agar preview tampil cepat dan tidak menabrak batas total job 120 detik.

**Prompt pondasi tahap 1 untuk project JBB:**
```text
Buat MAX 3 FILE saja untuk project JBB.

Yang dibuat sekarang:
1. app/dashboard/page.tsx - UI dashboard dengan data dummy
2. app/dashboard/layout.tsx - layout sidebar header
3. app/api/dashboard/stats/route.ts - return JSON dummy

Rules:
- Pakai Tailwind + shadcn/ui. Jangan install library baru.
- Data semua pakai array dummy di dalam file. Jangan konek DB.
- Max 4000 token per file.
- Stop setelah 3 file. Jangan buat file lain.

Tujuan: Dashboard langsung tampil di preview dalam 45 detik.
```

**Prompt tahap 2 setelah preview tampil:**
```text
Sekarang konek ke Turso. Ubah app/api/dashboard/stats/route.ts jadi query Prisma.
File yang diubah: schema.prisma, lib/prisma.ts, route.ts. Max 4 file.
```

Aturan baku orchestrator:
*   **Fase pondasi**: maksimal 3 file, data dummy lokal, tanpa DB, tanpa dependency baru.
*   **Fase integrasi**: maksimal 3-4 file per siklus, hanya file yang disebut di prompt.
*   **Fase perbaikan**: ubah file terkecil yang menyebabkan error preview, jangan regenerasi seluruh proyek.
*   **Target UX**: hasil pertama harus bisa muncul di preview dalam 45 detik, lalu fitur backend dipecah ke prompt lanjutan.

### 4.4 Lock Khusus DeepSeek Flash V4
DeepSeek Flash V4 wajib dipakai sebagai mesin murah-cepat untuk siklus preview. Karena model cepat mudah melenceng jika prompt longgar, sistem harus mengulang batas file, dummy data, dan format JSON pada system prompt.

```text
KAMU ADALAH ORCHESTRATOR SWIFT BUILDER. TUGASMU: PECAH PROMPT USER JADI MAX 3 FILE UNTUK PREVIEW CEPAT.

ATURAN KERAS:
1. MAX 3 FILE PER GENERATE. Kalau user minta fullstack, buat 3 file pondasi dulu. Sisanya tunggu prompt tahap 2.
2. PAKAI DATA DUMMY. Jangan setup Prisma, Turso, Auth, Stripe, atau package baru. Semua data pakai array const di dalam file.
3. MAX 4000 TOKEN PER FILE. Kode harus langsung jalan di preview. Jangan bikin file >150 baris.
4. PATH HARUS BENAR. Root Next.js = /app. Jangan bikin /src/app.
5. OUTPUT HANYA JSON. Jangan ada teks penjelasan, markdown, atau komentar di luar JSON.

ATURAN KHUSUS FLASH V4:
- Ulangi aturan MAX 3 FILE di awal setiap reasoning.
- Kalau prompt user terlalu besar, PECAH OTOMATIS jadi tahap 1: UI + data dummy saja.
- Jangan pakai reasoning_effort tinggi. Flash V4 stabil di default.
```

Konfigurasi API wajib:
*   **Model**: `deepseek/deepseek-v4-flash` via `OPENROUTER_DEEPSEEK_FLASH_V4_MODEL`.
*   **Temperature**: `0.2` untuk output lebih deterministik.
*   **Max tokens**: `4096` per request agar tidak mengulang dan timeout.
*   **Provider timeout**: slice cepat `45_000ms`, slice fullstack/builder `90_000ms`, total job `120_000ms`.
*   **Vercel Pro route**: endpoint job generation wajib `export const maxDuration = 300`; Hobby tetap wajib selesai di bawah batas platform.
*   **Reasoning**: `include_reasoning = false`; jangan kirim `reasoning_effort: high`.
*   **Cache**: aktifkan header OpenRouter response cache untuk request identik. Gunakan `cache_control` hanya untuk provider yang mendukung prompt caching eksplisit.
*   **Output**: JSON task graph atau daftar file terstruktur, tanpa markdown dan tanpa teks di luar JSON.

---

## 🛡️ FASE 5: PERTAHANAN PRODUKSI & VALIDASI KEAMANAN
*Target: Mengamankan stabilitas aplikasi, kuota API, dan akurasi sinkronisasi database.*

### 5.1 Skema Pembatasan Laju (Rate Limiting via Upstash Redis)
Gunakan interseptor berbasis *Vercel Edge Middleware* untuk membatasi konsumsi saldo token OpenAI/OpenRouter:
*   **Pengguna Gratis (Tier Free)**: Maksimal 3 kali siklus perintah pembuatan web per 24 jam berbasis IP & Sidik Jari Browser (*browser fingerprinting*).
*   **Pengguna Premium**: Akses tanpa batas yang diawasi oleh kebijakan pemakaian wajar (*Fair Usage Policy*).

### 5.2 Otomatisasi Webhook Gerbang Pembayaran Crypto BNB
*   Endpoint `/api/webhooks/pakasir` wajib memverifikasi kode unik kriptografi (*hash cryptographic signature*) dari Pakasir.
*   Ketika pembayaran dinyatakan berhasil (*Success*), picu mutasi pembaruan kolom baris data pengguna di **Neon DB** ke tingkat `PREMIUM` untuk membuka kunci pembatas laju kuota secara instan.

### 5.3 Validasi Keandalan Berkas (Consistency Verification Check)
Setiap kali alur streaming selesai, jalankan validasi silang otomatis di sisi klien untuk memastikan integritas data:
```typescript
if (clientFileState.count !== databaseFileState.count) {
  console.error("Explorer file count mismatch. Triggering explorer_refreshed backend query...");
  // Eksekusi API Penyegaran Otomatis:
  fetch(`/api/projects/${projectId}?reason=generation-completed`);
} else {
  console.log("streamed_files_applied: VFS Sync Status OK.");
}
```

---
*Dokumen ini wajib diperbarui setiap kali terjadi modifikasi fungsionalitas sistem inti. Patuhi aturan pengetikan kode TypeScript yang ketat demi menjaga skor kelulusan audit produksi.*
