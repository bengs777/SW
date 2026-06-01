# Perbaikan 2 - Rencana Implementasi Swift

Dokumen ini adalah rencana kerja untuk memperbaiki alur generasi web Swift tanpa langsung mengubah kode. Fokusnya adalah menutup sumber error yang paling sering muncul: queue/worker, fallback sandbox, urutan frontend-first, dan status error yang membingungkan user.

---

## Tujuan

- Mencegah error `queue_enqueue` dan penolakan generasi yang terlalu cepat.
- Memastikan worker produksi benar-benar stabil sebelum request ditolak.
- Membuat proses generasi selalu mulai dari frontend dulu, lalu backend belakangan.
- Menyiapkan sandbox Railway yang jelas, sehat, dan mudah dipakai user.
- Membuat status UI lebih informatif supaya user tahu apa yang sedang terjadi.

---

## Masalah Utama Yang Harus Diselesaikan

| Prioritas | Masalah | Dampak | Target Hasil |
| --- | --- | --- | --- |
| P1 | Queue dan worker terlalu mudah dianggap gagal | Request generasi ditolak sebelum sempat jalan | Queue tetap boleh menerima job kalau Redis sehat |
| P1 | Heartbeat worker dipakai terlalu agresif sebagai gate | Sistem menolak job padahal worker bisa pulih | Bedakan `queue sehat` dan `worker sehat` |
| P1 | Fallback belum cukup jelas | Preview kosong dan user hanya melihat pesan error | Ada fallback yang eksplisit dan bisa dilacak |
| P2 | Generasi belum selalu frontend-first | Backend muncul terlalu awal | Page utama dan dashboard dibuat dulu |
| P2 | Sandbox Railway belum dijadikan target jelas | User sulit run preview di environment sandbox | Preview bisa jalan di sandbox yang terkonfigurasi |
| P3 | UI error state masih generik | User tidak tahu harus retry, tunggu, atau ganti mode | Status lebih detail dan lebih ramah |

---

## Prinsip Perbaikan

- Queue menerima job jika Redis/BullMQ masih sehat, walau worker heartbeat belum fresh.
- Worker heartbeat dipakai untuk observasi dan recovery, bukan selalu untuk memblokir enqueue.
- Full-stack generation tidak boleh mendahului frontend preview untuk project baru.
- Fallback harus punya status yang jelas, bukan gagal diam-diam.
- Sandbox Railway harus diperlakukan sebagai runtime target, bukan asumsi tambahan.
- Setiap tahap harus bisa dicek dengan log, health check, dan status yang konsisten.

---

## Urutan Implementasi

### Tahap 1 - Stabilkan Queue dan Worker

Fokus:

- Pisahkan status `queue accepts jobs` dari `worker heartbeat healthy`.
- Jika Redis masih bisa menerima job, jangan tolak request hanya karena heartbeat worker terlambat.
- Gunakan reason code yang jelas, misalnya `redis_error`, `redis_ping_failed`, `worker_stale`, atau `queue_healthy`.
- Pastikan retry dan dead-letter tetap tercatat.

Yang harus ada setelah tahap ini:

- Job bisa masuk ke queue saat Redis sehat.
- Worker yang baru restart tidak langsung memblokir request.
- Error queue punya alasan yang lebih spesifik untuk dibaca user dan log internal.

### Tahap 2 - Perjelas Fallback Sandbox Railway

Fokus:

- Jadikan `SANDBOX_SERVICE_URL` dan token sandbox sebagai bagian dari flow resmi.
- Pastikan preview bisa diarahkan ke sandbox service bila queue production tidak bisa dipakai.
- Tambahkan jalur fallback yang aman untuk non-production atau environment yang memang mengizinkan fallback.
- Pastikan health check sandbox punya status yang mudah dibaca.

Yang harus ada setelah tahap ini:

- User punya jalur preview yang jelas saat queue gagal.
- Sandbox bisa dipakai untuk run environment tanpa menebak-nebak status.
- Log sandbox menunjukkan apakah masalah ada di boot, build, atau runtime.

### Tahap 3 - Paksa Frontend-First untuk Project Baru

Fokus:

- Buat project baru mulai dari layout, page tree, dan komponen UI dulu.
- Dashboard harus dibuat page by page secara berurutan.
- Untuk e-commerce atau dashboard, urutan page harus logis:
  - layout utama
  - home/overview
  - projects atau product list
  - detail page
  - builder/preview
  - settings/error log
- Backend baru masuk setelah frontend preview layak.

Yang harus ada setelah tahap ini:

- Project baru tidak langsung full-stack dari awal.
- Preview awal selalu punya UI yang bisa dilihat.
- User melihat progres yang masuk akal, bukan file backend duluan.

### Tahap 4 - Rapikan Status dan Error UX

Fokus:

- Bedakan status seperti `queued`, `waiting_worker`, `fallback_scheduled`, `sandbox_running`, `preview_ready`, dan `failed`.
- Tampilkan alasan kegagalan yang tidak terlalu teknis untuk user umum.
- Sediakan tombol retry yang sesuai dengan statusnya.
- Buat pesan error yang menjelaskan langkah berikutnya, bukan hanya menyebut gagal.

Yang harus ada setelah tahap ini:

- User tahu apakah harus menunggu, retry, atau pindah mode.
- Panel error tidak lagi terasa seperti pesan mentah dari backend.
- Log dan label status selaras dengan keadaan runtime.

### Tahap 5 - Tambahkan Validasi dan Regression Guard

Fokus:

- Tambahkan kontrak test untuk queue/worker fallback.
- Tambahkan guard untuk urutan frontend-first.
- Tambahkan validasi agar planner tidak lompat ke backend terlalu cepat.
- Pastikan lint, typecheck, dan build tetap lulus setelah perubahan.

Yang harus ada setelah tahap ini:

- Perubahan tidak gampang hilang saat refactor.
- Aturan queue dan frontend-first punya pembatas otomatis.
- Failure mode baru mudah dilacak lewat test atau kontrak runtime.

---

## Area Kode Yang Perlu Diperiksa Saat Implementasi

- `app/api/generate/jobs/route.ts`
- `lib/queue/generation-queue.ts`
- `workers/index.ts`
- `workers/generation-worker.ts`
- `lib/services/generation-orchestrator.service.ts`
- `lib/ai/architecture-planner.ts`
- `lib/ai/frontend-completeness-validator.ts`
- `app/api/projects/[id]/sandbox/route.ts`
- `services/sandbox-runtime/server.mjs`
- `scripts/generation-runtime-contracts.js`

---

## Checklist Sukses

- [ ] Queue tetap bisa menerima job saat Redis sehat.
- [ ] Worker heartbeat tidak lagi memblokir request secara berlebihan.
- [ ] Error queue punya reason code yang jelas.
- [ ] Fallback sandbox bisa dipakai di environment yang tepat.
- [ ] Project baru dimulai dari frontend, bukan backend.
- [ ] Dashboard dibuat page by page secara urut.
- [ ] Preview awal tidak blank karena pipeline lompat tahap.
- [ ] Status UI lebih detail dan mudah dipahami.
- [ ] Regression test menutup aturan penting.
- [ ] Lint, typecheck, dan build tetap hijau.

---

## Risiko Jika Tidak Dikerjakan

- User terus melihat error yang sama walau queue sebenarnya hanya butuh recovery singkat.
- Preview tetap kosong karena pipeline tidak pernah sampai tahap render.
- Frontend dan backend tercampur terlalu dini, sehingga repair makin sulit.
- Fallback sandbox jadi tidak konsisten dan user kehilangan progres.
- Dashboard terasa tidak stabil karena status dan log tidak menjelaskan kondisi sebenarnya.

---

## Rekomendasi Eksekusi

1. Stabilkan queue dan worker dulu.
2. Rapikan fallback sandbox Railway.
3. Paksa frontend-first untuk project baru.
4. Perjelas status dan error UX.
5. Tambahkan regression guard terakhir.

---

## Definisi Selesai

Perbaikan ini dianggap selesai kalau:

- request generasi tidak lagi ditolak hanya karena worker heartbeat terlambat,
- frontend proyek baru selalu dibuat lebih dulu,
- sandbox Railway bisa dipakai sebagai jalur run yang jelas,
- user bisa memahami status error tanpa harus baca log mentah,
- perubahan perilaku ini punya test atau kontrak yang menguncinya.

