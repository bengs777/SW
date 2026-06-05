# Evaluasi Swift AI menuju "Lovable versi Indonesia"

Tanggal audit: 5 Juni 2026

## Metode audit

- Membaca struktur Next.js App Router, dashboard, editor, auth, project API, generation job API, template, dan workspace.
- Menjalankan `npm run typecheck`, `npm run lint`, `npm run build`, `npm run deploy:readiness`, dan `npm run schema:health`.
- Menjalankan web lokal via `npm run dev:next` lalu mengecek halaman publik dengan browser desktop dan mobile.
- Mengecek `/api/health` setelah startup.
- Membandingkan dengan acuan resmi Lovable: prompt-to-app, workspace/project lifecycle, Build/Plan mode, code editor, visual edits, testing, publish, pricing, dan governance.

## Ringkasan eksekutif

Swift sudah punya pondasi yang kuat untuk menjadi AI app builder: ada dashboard, workspace, project, generation queue, billing, editor chat, preview/code/explorer, draft restore, version history, validate preview, GitHub push, dan deploy Vercel.

Namun pengalaman akhirnya belum sepenuhnya terasa seperti Lovable versi Indonesia. Masalah terbesarnya bukan TypeScript atau lint, karena keduanya lulus. Pada audit awal, gap utama ada di onboarding produk, integrasi template, readiness deploy, konsistensi bahasa, link/route yang belum tersambung, dan landing page yang masih berupa demo statis. Setelah perbaikan prioritas, readiness deploy, template flow, prompt landing, dan sandbox timeout sudah membaik; gap tersisa terutama ada di polish produk, dokumentasi, workspace, publish, dan visual edit.

Status saat ini setelah perbaikan prioritas: jalur awal menuju "tulis prompt -> login/signup -> project -> generation -> preview" sudah jauh lebih kuat, tetapi Swift belum final sebagai pengalaman produk seperti Lovable versi Indonesia. Sisa gap terbesar ada di `npm run dev`, copy Indonesia menyeluruh, workspace creation, docs, publish flow, dan visual edit.

## Update implementasi prioritas

Urutan kerja mengikuti prioritas keberhasilan user membuat aplikasi, bukan daftar audit secara literal.

1. Deploy/readiness: `scripts/deploy-readiness.js` sekarang mengecek target produksi dan membaca `.env.production` secara eksplisit. Hasil terbaru `READY_FOR_DEPLOY` dengan required check 24/24 lulus; yang tersisa hanya warning rekomendasi untuk `SWIFT_METRICS_TOKEN` dan `SWIFT_WORKER_HEALTH_URL`.
2. Template Flow: `/dashboard/templates` sekarang memakai ID template katalog internal dan tombol "Pakai Template" benar-benar membuat project lewat `POST /api/templates/[id]`, lalu membuka editor project.
3. Prompt Landing: prompt di hero sekarang form nyata. Guest prompt disimpan sementara, diarahkan ke signup/login dengan callback, lalu `/dashboard/projects?continuePrompt=1` membuka dialog project berisi prompt tersebut.
4. Sandbox: proksi sandbox eksternal sekarang punya timeout eksplisit agar preview tidak menggantung tanpa batas saat service runtime mati atau lambat.

## Yang sudah berjalan

1. `npm run typecheck` lulus.
2. `npm run lint` lulus.
3. `npm run build` berhasil membuat production build.
4. `npm run deploy:readiness` kini menghasilkan `READY_FOR_DEPLOY`.
5. `npm run schema:health` menunjukkan runtime schema kompatibel dengan database.
6. Landing page, pricing, docs, docs/api, security, privacy, dan terms bisa dibuka tanpa crash.
7. Setelah Next dev siap, `/api/health` menunjukkan database, auth, worker, dan queue `ok`.
8. Editor project secara kode sudah punya alur penting: chat prompt, generation job, SSE progress, cancel, draft restore, autosave, preview, code editor, explorer, logs, validate preview, rollback, GitHub, dan deploy.
9. Playwright lokal memverifikasi prompt landing tersimpan, redirect signup membawa callback, footer login mempertahankan callback, dan redirect dashboard tanpa sesi tetap membawa `continuePrompt=1`.

## Temuan utama yang tidak berjalan semestinya

### P0 - `npm run dev` gagal sebelum server jalan

`npm run dev` menjalankan `scripts/dev-start.js`, lalu `node scripts/db-push.js local`. Proses ini berhenti karena Prisma mendeteksi potensi data loss:

- Akan drop tabel `ai_providers` yang masih berisi data.
- Akan drop tabel `settings` yang masih berisi data.
- Prisma meminta `--accept-data-loss`.

Saya tidak menjalankan flag tersebut. Dampaknya, developer atau operator lokal tidak bisa menjalankan web dari command utama. Untuk audit UI, Next hanya bisa dibuka lewat `npm run dev:next`.

Rekomendasi:
- Jangan jadikan `prisma db push` destruktif sebagai langkah otomatis `npm run dev`.
- Pisahkan menjadi command eksplisit, misalnya `npm run db:sync:local`.
- Untuk database aktif, pakai migration flow, bukan `db push` yang bisa drop tabel.
- Tambahkan guard yang menjelaskan data loss dan meminta tindakan manual.

### P0 - Deployment readiness awalnya `NOT_READY_FOR_DEPLOY` (status: diperbaiki)

Saat audit awal, `npm run deploy:readiness` gagal pada:

- `NEXTAUTH_URL`
- `NEXT_PUBLIC_APP_URL`
- `SWIFT_METRICS_TOKEN`

Masalah utama bukan hanya nilai env, tetapi script readiness default membaca konteks development sehingga `.env.production` tidak menjadi sumber utama untuk pengecekan deploy. Setelah perbaikan, command terbaru membaca `.env.production`, semua required check lulus, dan status akhirnya `READY_FOR_DEPLOY`.

Sisa rekomendasi:
- Isi `SWIFT_METRICS_TOKEN` bila endpoint metrics/monitoring akan dipakai serius.
- Putuskan apakah `SWIFT_WORKER_HEALTH_URL` tetap opsional atau menjadi direct probe wajib di produksi.

### P1 - Landing belum seperti Lovable: prompt utama masih statis (status: diperbaiki untuk alur awal)

Di Lovable, layar utama langsung mengajak pengguna membuat app lewat chat/prompt. Saat audit awal, hero Swift berisi mockup prompt dan tombol `Buat` tidak punya aksi.

Sekarang prompt di hero sudah menjadi form nyata. Saat guest submit, Swift menyimpan prompt di `localStorage`, mengarahkan user ke signup dengan callback `/dashboard/projects?continuePrompt=1`, lalu halaman Projects membuka dialog project dengan prompt tersebut. Setelah project dibuat, halaman project sudah punya efek auto-generate dari `project.prompt` bila project masih kosong.

Verifikasi Playwright:
- URL signup membawa `callbackUrl=/dashboard/projects?continuePrompt=1`.
- Prompt tersimpan dengan key `swift.pendingProjectPrompt`.
- Link signup ke login tetap mempertahankan callback.
- Akses dashboard tanpa sesi redirect ke login tanpa membuang query `continuePrompt=1`.

Sisa rekomendasi:
- Sediakan chips template Indonesia seperti "Dashboard UMKM", "Landing produk", "Marketplace", "CRM sales", "Portal desa".
- Ubah copy auth menjadi Indonesia-first agar continuation dari landing terasa mulus.

### P1 - Onboarding dan auth belum Indonesia-first

Login/signup masih berbahasa Inggris:

- "Continue with Google"
- "Google is the only sign-in method for Swift."
- "Need to create an account? Go to sign up"

Untuk target "Lovable versi Indonesia", ini terasa belum selesai.

Rekomendasi:
- Ubah seluruh copy auth ke Bahasa Indonesia.
- Tambahkan pesan error OAuth yang jelas.
- Tampilkan manfaat singkat: saldo awal, project pertama, dan prompt yang akan dilanjutkan.
- Pertimbangkan email magic link atau OAuth tambahan bila target pengguna non-teknis Indonesia.

### P1 - Template belum tersambung ke alur project (status: diperbaiki untuk create project)

Saat audit awal, `/dashboard/templates` masih statis dan berbahasa Inggris. Tombol `Use Template` mengarah ke `/dashboard/projects?template=...`, tetapi halaman `/dashboard/projects` tidak membaca query `template`.

Sekarang ID template UI diselaraskan dengan katalog internal:

- `admin-dashboard`
- `landing-page`
- `storefront`
- `auth-suite`
- `workspace-builder`

Tombol "Pakai Template" memanggil `POST /api/templates/[id]`, membuat project dari file template, lalu membuka `/dashboard/project/[projectId]`.

Sisa rekomendasi:
- Tambahkan kategori lokal yang lebih kuat: UMKM, desa, sekolah, klinik, booking, inventory, komunitas.
- Tambahkan empty/error state yang lebih ramah bila user belum punya workspace atau session habis.

### P1 - Sandbox preview rawan menggantung (status: diperbaiki sebagian)

Alur editor sudah bisa menerima `previewUrl` dari generation job/event dan mengirimkannya ke `PreviewPanel`. Risiko yang lebih besar ada pada proksi sandbox eksternal: jika service runtime lambat atau tidak merespons, user bisa menunggu terlalu lama tanpa sinyal jelas.

Perbaikan:
- `app/api/projects/[id]/sandbox/route.ts` sekarang memakai `AbortController`.
- Default timeout proksi sandbox 30 detik, bisa diatur lewat `SWIFT_SANDBOX_PROXY_TIMEOUT_MS`.
- Timeout mengembalikan kode `sandbox_service_timeout`, bukan error generic.

Sisa rekomendasi:
- Tambahkan retry/backoff terukur untuk status transient.
- Tampilkan pesan UI yang membedakan "sandbox timeout", "service disabled", dan "file payload terlalu besar".

### P1 - Link `New Workspace` rusak

`components/workspace-switcher.tsx` mengarah ke `/dashboard/workspace-settings`, tetapi route itu tidak ada di build output.

Dampak:
- Pengguna yang ingin membuat workspace baru akan mendapat 404.

Rekomendasi:
- Buat route `/dashboard/workspace-settings`, atau ubah link menjadi dialog create workspace.
- Setelah workspace dibuat, arahkan ke `/dashboard/workspace/[id]`.

### P1 - Dokumentasi publik masih terlalu tipis dan ada endpoint stale

`/docs/api` menampilkan `POST /api/generate`, tetapi implementasi utama yang dipakai editor adalah `POST /api/generate/jobs`.

Dampak:
- Pengguna developer akan mengikuti endpoint yang salah.
- Docs belum cukup untuk produk seperti Lovable.

Rekomendasi:
- Perbarui API docs sesuai route aktual.
- Tambahkan quick start: buat akun, tulis prompt, pilih mode, review preview, publish.
- Tambahkan docs prompting berbahasa Indonesia.
- Tambahkan troubleshooting generation, billing, deploy, dan custom domain.

### P2 - Banyak copy dashboard/editor masih campur Indonesia dan Inggris

Contoh:

- Dashboard: "Dashboard overview", "Recent Usage", "Current Balance", "Successful Requests".
- Sidebar: "Projects", "Templates", "Settings", "Sign out".
- Editor: "Preview validation", "Version history", "Push GitHub", "Deploy Vercel".
- Legal/security pages masih sebagian besar Inggris.

Dampak:
- Produk belum terasa sebagai Lovable versi Indonesia.
- Pengguna non-teknis bisa bingung karena istilah bercampur.

Rekomendasi:
- Tentukan glossary UI Indonesia.
- Pakai Bahasa Indonesia untuk user-facing text.
- Biarkan istilah teknis seperti GitHub/Vercel/API tetap apa adanya, tetapi deskripsinya Indonesia.

### P2 - Admin/System muncul di sidebar untuk semua user

Sidebar selalu menampilkan `Admin` dan `System`. Halamannya memang membatasi akses, tetapi navigasi yang terlihat ke user biasa menciptakan friksi.

Rekomendasi:
- Sembunyikan menu Admin/System kecuali user developer/admin.
- Untuk user biasa, tampilkan Projects, Templates, Billing, Settings, Docs.

### P2 - `/api/providers/status` membingungkan

Proxy memasukkan `/api/providers/status` sebagai public path, tetapi route-nya sendiri tetap membutuhkan auth dan `modelKey`.

Dampak:
- Status provider tidak bisa dipakai sebagai health publik.
- Dokumentasi/API surface terasa tidak konsisten.

Rekomendasi:
- Jika status ini internal editor, keluarkan dari public path.
- Jika ingin status publik, buat respons publik tanpa auth dan tanpa detail sensitif.

### P2 - Mobile landing belum optimal untuk prompt-first

Mobile tidak overflow, tetapi:

- Brand "Swift AI" pecah baris.
- First viewport belum menampilkan prompt input yang bisa dipakai.
- Mockup builder baru muncul jauh di bawah CTA.

Rekomendasi:
- Ringkas header mobile.
- Taruh prompt form nyata lebih awal.
- Tampilkan 2-3 template chips sebelum fold.

### P3 - Build lokal mengalami Prisma generate file lock

Production build berhasil, tetapi saat build dijalankan sambil dev server aktif, Prisma generate sempat gagal rename engine Windows karena file lock, lalu fallback memakai existing Prisma client.

Ini kemungkinan efek dev server aktif saat build, bukan blocker produksi. Tetap perlu dicatat karena bisa membingungkan di Windows.

Rekomendasi:
- Dokumentasikan agar build dijalankan tanpa dev server aktif.
- Atau skip regenerate bila client sudah fresh.

## Gap terhadap Lovable

Acuan Lovable yang relevan:

- Lovable homepage memosisikan produk sebagai AI app builder untuk membuat apps/websites lewat chat: https://lovable.dev/
- Lovable docs menjelaskan full-stack AI development platform dengan frontend, backend, database, auth, integrasi, editable code, workspace, GitHub sync, dan deployment: https://docs.lovable.dev/introduction/welcome
- Quick start Lovable: prompt pertama, dashboard, template, project editor, image attachments, Build/Plan mode, version history, GitHub, backend, publish, mobile/desktop preview: https://docs.lovable.dev/introduction/getting-started
- Build mode: implementasi end-to-end, visible tasks, queue prompt, debugging, verification: https://docs.lovable.dev/features/agent-mode
- Code editor: browse file, edit, search, download ZIP, reference file in chat: https://docs.lovable.dev/features/code-mode
- Visual edits: select UI element, edit layout/text/colors/images langsung dari preview: https://docs.lovable.dev/features/design
- Testing: browser testing, frontend tests, backend verification: https://docs.lovable.dev/features/testing
- Publish: live URL, access control, metadata SEO/social, security scan, update/unpublish: https://docs.lovable.dev/features/publish
- Pricing: plan/credits/custom domain/roles/security center: https://lovable.dev/pricing

Swift sudah mendekati di sisi internal builder, tetapi belum mendekati di sisi pengalaman pengguna:

- Lovable mulai dari prompt nyata; Swift mulai dari CTA ke login.
- Lovable punya template sebagai entry point; Swift punya template page statis yang belum tersambung.
- Lovable punya visual edits; Swift belum terlihat punya mode seleksi elemen langsung di preview.
- Lovable punya publish modal dengan metadata/security/access; Swift punya deploy Vercel dan domain, tetapi belum terlihat sebagai flow publish yang mudah dipahami.
- Lovable docs dan lifecycle jelas; Swift docs masih pendek dan sebagian stale.

## Harapan final Swift sebagai "Lovable versi Indonesia"

### Pengalaman first viewport

- Hero berisi prompt box nyata: "Mau buat aplikasi apa?"
- Bisa attach screenshot/dokumen.
- Ada contoh prompt lokal: POS toko, dashboard sales, landing UMKM, booking klinik, portal desa, marketplace.
- Guest prompt disimpan dan dilanjutkan setelah login.

### Dashboard

- Ringkas dan Indonesia-first.
- Tombol utama: "Buat project".
- Template nyata yang bisa langsung membuat project.
- Saldo Rupiah, riwayat penggunaan, project terbaru, dan status generation jelas.

### Editor/builder

- Chat prompt kiri, preview/code/explorer kanan.
- Mode: Bangun, Rancang, Edit, Perbaiki, Tanya.
- Progress generation terlihat: rencana, file, validasi, preview, repair.
- Version history dan rollback mudah.
- Preview desktop/tablet/mobile.
- Error preview otomatis bisa dikirim ke mode fix.
- Visual edit langsung dari preview.

### Publish

- Tombol "Publikasikan".
- Pilihan URL Swift/subdomain, custom domain, metadata SEO, OG image.
- Security/basic scan sebelum publish.
- Update publish tidak otomatis tanpa konfirmasi.
- Export ZIP dan GitHub sync tetap tersedia untuk developer.

### Operasional

- Health endpoint tidak 503 saat konfigurasi produksi sudah valid.
- Worker/queue/sandbox jelas statusnya.
- Refund/saldo otomatis dijelaskan dalam UI.
- Admin/System hanya terlihat oleh role yang tepat.

## Roadmap perbaikan

### 0-2 hari

1. Belum: perbaiki `npm run dev` agar tidak gagal karena `db push` data loss.
2. Selesai untuk required deploy gate: readiness produksi kini `READY_FOR_DEPLOY`; `SWIFT_METRICS_TOKEN` masih warning rekomendasi.
3. Belum: ubah login/signup/legal/security copy ke Bahasa Indonesia.
4. Belum: perbaiki link `New Workspace`.
5. Belum: perbaiki `/docs/api` dari `POST /api/generate` ke `/api/generate/jobs`.
6. Belum: sembunyikan menu Admin/System untuk non-developer.
7. Selesai untuk alur awal: tombol/prompt hero sekarang form nyata dan prompt lanjut melewati signup/login.

### 3-7 hari

1. Selesai untuk create project: `/dashboard/templates` sekarang membuat project dari katalog template.
2. Selesai untuk handoff awal: prompt preservation dari guest ke login/signup ke dialog project sudah ada.
3. Sebagian: Playwright sudah memverifikasi guest prompt -> signup/login callback; e2e penuh sampai generation job dan preview siap masih perlu sesi authenticated/manual OAuth atau test auth fixture.
4. Rapikan mobile first viewport agar prompt muncul lebih awal.
5. Tambahkan publish flow yang lebih mirip produk, bukan sekadar deploy action.

### 2-4 minggu

1. Visual edit langsung di preview.
2. Security scan dan SEO review sebelum publish.
3. Template gallery Indonesia dengan kategori domain lokal.
4. Dokumentasi lengkap berbahasa Indonesia.
5. Role/workspace permissions yang lebih terlihat dan rapi.
6. Public status page dan incident messaging.

## Catatan audit

- Saya tidak menjalankan `prisma db push --accept-data-loss`.
- Saya tidak melakukan login Google manual, sehingga area dashboard/editor tidak diverifikasi sebagai user authenticated lewat browser. Evaluasi area itu berdasarkan kode, build, API health, dan route behavior.
- Next dev berhasil dibuka memakai `npm run dev:next`, bukan command utama `npm run dev`.
