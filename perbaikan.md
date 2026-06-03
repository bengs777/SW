# Rencana Perbaikan Swift AI

Tanggal eksekusi: Rabu, 3 Juni 2026

Tujuan utama:

```txt
Memulihkan pipeline Swift AI sampai user bisa prompt, AI membuat website full-stack bertahap, hasil muncul di preview/sandbox, lalu siap deploy ke Vercel.
```

Status sebelum eksekusi:

```txt
Kode lokal dan audit production sudah lulus.
GitHub terakhir sudah memuat runbook investigasi.
Production belum siap penuh karena worker Railway dan sandbox runtime masih menjadi blocker.
```

## 1. Prioritas Besok

Urutan prioritas:

1. Redeploy Railway generation worker ke commit terbaru.
2. Pulihkan sandbox runtime `https://sanbox.ai-swift.biz.id`.
3. Pastikan health check production tidak lagi blocked.
4. Jalankan prompt smoke test end-to-end.
5. Jika prompt sukses, lanjut validasi preview dan deploy Vercel.

## 2. Checklist Pagi

Jam target: 09.00 - 10.00 WIB

- [ ] Buka Railway dashboard.
- [ ] Pastikan service generation worker terhubung ke repo GitHub `bengs777/SW`.
- [ ] Pastikan service worker memakai branch `main`.
- [ ] Redeploy worker dari commit terbaru.
- [ ] Catat `startedAt` worker setelah redeploy.
- [ ] Buka service sandbox runtime di Railway.
- [ ] Pastikan sandbox runtime memakai Dockerfile:

```txt
services/sandbox-runtime/Dockerfile
```

- [ ] Restart atau redeploy sandbox runtime.
- [ ] Pastikan domain sandbox mengarah ke service yang benar:

```txt
https://sanbox.ai-swift.biz.id
```

## 3. Env Yang Harus Dicek

### 3.1 Worker/App Env

Pastikan env ini ada di runtime production yang relevan:

```env
OPENROUTER_STREAM_IDLE_TIMEOUT_MS=60000
OPENROUTER_HARD_TIMEOUT_MS=180000
AI_PROVIDER_REQUEST_BUDGET_MS=180000
AI_MAX_CONCURRENT_GENERATIONS=1
SWIFT_GENERATION_WORKER_CONCURRENCY=1
SWIFT_AI_MODEL_CHAIN=openrouter:deepseek/deepseek-v4-pro
SWIFT_AI_FREE_MODE=false
SANDBOX_SERVICE_URL=https://sanbox.ai-swift.biz.id
```

Catatan:

```txt
Jangan ganti API key jika health provider masih healthy.
Fokus utama adalah redeploy worker agar timeout fix benar-benar aktif.
```

### 3.2 Sandbox Runtime Env

Pastikan env ini ada di service sandbox runtime:

```env
NODE_ENV=production
PORT=8080
SANDBOX_PUBLIC_BASE_URL=https://sanbox.ai-swift.biz.id
SANDBOX_SERVICE_TOKEN=<same token as Vercel/Railway worker>
SWIFT_SANDBOX_ROOT=/data/swift-sandbox
```

Catatan:

```txt
SANDBOX_SERVICE_TOKEN harus sama antara app/worker dan sandbox runtime.
Jika token beda, request sandbox bisa gagal walaupun service hidup.
```

## 4. Health Check Setelah Redeploy

Jam target: 10.00 - 11.00 WIB

Jalankan endpoint ini setelah worker dan sandbox redeploy:

```txt
https://www.ai-swift.biz.id/api/worker/health
https://www.ai-swift.biz.id/api/provider/health
https://www.ai-swift.biz.id/api/health?refreshProvider=true
https://www.ai-swift.biz.id/api/production/monitoring
https://sanbox.ai-swift.biz.id/health
```

Kriteria lulus:

```txt
Worker status healthy
Worker startedAt lebih baru dari waktu redeploy
Provider status healthy
Sandbox status healthy
Sandbox response punya runtime.storage.ok=true
Vercel health tidak lagi memuat blockingFailures SANDBOX_RUNTIME_HEALTH
```

## 5. Prompt Smoke Test

Jam target: 11.00 - 12.00 WIB

Gunakan prompt kecil tapi full-stack:

```txt
Buat dashboard inventory toko baju full-stack sederhana dengan halaman produk, ringkasan penjualan, tabel stok, API route produk, dan tampilan preview yang rapi.
```

Yang harus diamati:

- [ ] Job masuk queue.
- [ ] Worker mengambil job.
- [ ] Tidak muncul `OpenRouter request timed out after 15 seconds`.
- [ ] Job selesai `completed`.
- [ ] File hasil bukan scaffold default.
- [ ] Preview URL muncul.
- [ ] Sandbox session menjadi ready/running.
- [ ] Tombol deploy tidak terkunci oleh `Verify first`.

## 6. Jika Generation Masih Gagal

Urutan investigasi lanjutan:

1. Cek database recent generation attempts.
2. Pastikan error bukan timeout 15 detik lama.
3. Jika timeout berubah menjadi 60 detik atau 180 detik, berarti worker sudah memakai kode baru tetapi model masih lambat.
4. Jika provider cooldown terjadi, pertimbangkan paid fallback chain.
5. Jika error schema/artifact, cek provider output dan parser generated artifact.
6. Jika preview gagal, cek build log sandbox dan runtime smoke.

Opsi fallback model chain jika DeepSeek tetap tidak stabil:

```env
SWIFT_AI_MODEL_CHAIN=openrouter:deepseek/deepseek-v4-pro,openrouter:anthropic/claude-3.5-sonnet,openrouter:openai/gpt-4o
```

Catatan:

```txt
Fallback chain jangan diubah terburu-buru sebelum worker redeploy terbukti aktif.
Masalah utama saat ini adalah runtime lama dan sandbox 502.
```

## 7. Validasi Preview Dan Sandbox

Jam target: 13.00 - 14.00 WIB

Kriteria:

- [ ] Preview editor menampilkan UI hasil prompt.
- [ ] Tidak hanya menampilkan placeholder/default scaffold.
- [ ] Tidak ada error compile besar di preview.
- [ ] Sandbox bisa install dependency dengan `ignore-scripts`.
- [ ] Sandbox bisa menjalankan build sebelum preview.
- [ ] Sandbox bisa serve app sampai dapat preview URL.

## 8. Validasi Deploy Vercel

Jam target: 14.00 - 15.00 WIB

Sebelum deploy:

- [ ] Health app production healthy.
- [ ] Worker healthy.
- [ ] Sandbox healthy.
- [ ] Provider healthy.
- [ ] Prompt smoke test minimal 1x completed.
- [ ] Preview verified.

Setelah deploy:

- [ ] Deployment URL muncul.
- [ ] Deployment bisa dibuka.
- [ ] Tidak ada error build Vercel.
- [ ] Project history menyimpan version/deployment.

## 9. Kriteria Production Ready

Swift AI boleh dianggap siap production tahap awal jika:

```txt
1 prompt full-stack sederhana completed
Preview URL valid
Sandbox health healthy
Deploy Vercel sukses
Monitoring tidak menunjukkan failed 100%
Tidak ada blockingFailures di /api/health
```

Swift AI belum boleh disebut setara Replit sebelum:

```txt
Sandbox stabil untuk banyak session
Terminal/log real-time matang
Workspace file persistence kuat
Isolation dan quota sandbox kuat
Package install dan build recovery stabil
Deploy orchestration bisa retry dan rollback
```

## 10. Catatan Akhir

Fokus besok bukan menambah fitur baru.

Fokus besok adalah membuat jalur inti ini benar-benar hidup:

```txt
Prompt -> Queue -> Worker -> Provider -> Artifact -> Preview -> Sandbox -> Deploy
```

Jika jalur inti ini sudah hijau, barulah lanjut ke hardening agar Swift AI makin dekat ke pengalaman seperti Replit.
