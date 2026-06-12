# Production Fix Plan: Agent Router Credit Tidak Terlihat Terpakai

Tanggal investigasi: 2026-06-08

## Ringkasan

Masalah utama bukan karena key Agent Router tidak terpasang. Konfigurasi lokal sudah mengarah ke Agent Router, tetapi runtime production/worker yang sedang berjalan masih memakai model chain lama seperti `poolside/laguna-m.1:free` dan fallback `openrouter/owl-alpha`. Karena banyak job gagal atau timeout, sistem billing internal Swift otomatis melakukan refund Rp3.000, sehingga saldo aplikasi kembali dan credit terlihat seperti tidak kepakai.

Di dashboard Agent Router terlihat sekitar `$49.97 / $50.00`, jadi ada indikasi penggunaan kecil. Warmup log `ai_warmup_cycle openRouterOk: true` hanya ping metadata dan tidak membakar credit model.

## Bukti

- `.env.production` lokal lulus audit dan memakai:
  - `AGENTROUTER_BASE_URL=https://agentrouter.org/v1`
  - `AGENTROUTER_MODEL=glm-5.1`
  - `SWIFT_AI_PROVIDER_NAME=agentrouter`
  - `SWIFT_AI_MODEL_CHAIN=agentrouter:glm-5.1`
- Database production menunjukkan job terbaru masuk worker, tetapi banyak berakhir `dead_lettered` atau `refunded`.
- `UsageLog` terbaru berstatus `refunded`, contohnya error `SWIFT_AI_PROVIDER_FAILOVER_EXHAUSTED` dan `Generation timed out after 500s`.
- `GenerationAttempt.metadataJson` masih menunjukkan provider attempt ke:
  - `poolside/laguna-m.1:free`
  - `openrouter/owl-alpha`
- CLI Vercel lokal belum login, dan `.vercel/project.json` lokal menunjuk project/team berbeda dari log Vercel yang ditempel. Ini perlu dibetulkan sebelum validasi live lewat CLI.

## Root Cause

Production runtime dan/atau generation worker tidak memakai environment terbaru. Ada salah satu atau kombinasi dari kondisi berikut:

1. Vercel Production env masih menyimpan model lama atau belum di-redeploy setelah env diubah.
2. Worker generation berjalan dari environment lama dan belum restart.
3. Project Vercel lokal ter-link ke project/team yang berbeda dari production app yang aktif.
4. Ada env tersembunyi di host worker yang override `AGENTROUTER_MODEL` atau model chain.

## Target State

Production harus konsisten memakai satu route Swift AI:

```env
AGENTROUTER_API_KEY=<sensitive>
AGENTROUTER_BASE_URL=https://agentrouter.org/v1
AGENTROUTER_MODEL=glm-5.1
AGENTROUTER_MAX_TOKENS=16000
SWIFT_AI_PROVIDER_NAME=agentrouter
SWIFT_AI_MODEL_CHAIN=agentrouter:glm-5.1
SWIFT_AI_FREE_MODE=false
AI_PROVIDER_REQUEST_BUDGET_MS=180000
```

Env lama berikut harus tidak aktif di production dan worker:

```env
OPENROUTER_FREE_MODEL
OPENROUTER_MODEL_ID
SWIFT_FALLBACK_MODEL_1
AGENTROUTER_FALLBACK_MODEL
AGENTROUTER_FALLBACK_MODELS
OPENROUTER_FALLBACK_MODEL
OPENROUTER_FALLBACK_MODELS
```

Jika `OPENROUTER_API_KEY` masih dipakai sebagai compatibility alias, nilainya harus sama dengan `AGENTROUTER_API_KEY`, dan `OPENROUTER_BASE_URL` harus tetap `https://agentrouter.org/v1`.

## Production Fix Steps

### 1. Pastikan Project Vercel Benar

Project di log Vercel yang ditempel:

```text
Project: sw
Project ID: prj_XlBfKpRQi63tVSgPUQTaDC98HmYn
Team: bengs777s-projects
Team ID: team_QHo8H32IXhExzbZRKDGVJ7a2
Domain: www.ai-swift.biz.id
```

Project lokal saat ini berbeda:

```text
Project ID: prj_9zxtnQv5zQFKcLwemv9wwKrBpTGF
Team ID: team_Sh4cO29ybM0BoU3ty2bUP5mw
Project name: swift
```

Relink repo lokal ke project production yang benar sebelum menjalankan audit Vercel:

```powershell
npx vercel login
npx vercel link --yes --project sw --scope bengs777s-projects
```

Jika nama project ambigu, buka dashboard production dulu dan pastikan link CLI mengarah ke `prj_XlBfKpRQi63tVSgPUQTaDC98HmYn`.

### 2. Sinkronkan Environment Vercel Production

Di Vercel Dashboard, set Production env ke target state di atas. Hapus atau kosongkan env model lama.

Setelah itu pull untuk validasi lokal:

```powershell
npx vercel env pull .env.vercel.production --environment=production
```

Pastikan hasil pull tidak mengandung `poolside/laguna-m.1:free` atau `openrouter/owl-alpha`:

```powershell
Select-String -Path .env.vercel.production -Pattern "poolside|owl-alpha|OPENROUTER_FREE_MODEL|SWIFT_FALLBACK_MODEL_1"
```

Expected: tidak ada match.

### 3. Sinkronkan Environment Worker

Worker harus memakai env yang sama dengan Vercel Production. Di host worker/VPS/process manager, audit env aktif:

```powershell
$env:AGENTROUTER_BASE_URL
$env:AGENTROUTER_MODEL
$env:SWIFT_AI_MODEL_CHAIN
$env:SWIFT_AI_PROVIDER_NAME
```

Expected:

```text
https://agentrouter.org/v1
glm-5.1
agentrouter:glm-5.1
agentrouter
```

Restart worker setelah env diperbarui:

```powershell
npm run worker:generation
```

Jika worker dikelola PM2/systemd/Docker, restart service terkait dan pastikan proses baru membaca env terbaru.

### 4. Deploy Ulang Production

Setelah env production benar:

```powershell
npm run audit:production-env
npm run typecheck
npm run lint
npx vercel --prod
```

Jika deployment memakai CI, trigger redeploy tanpa cache setelah env diperbarui.

### 5. Validasi Runtime Model Chain

Jalankan health endpoint production:

```powershell
Invoke-RestMethod "https://www.ai-swift.biz.id/api/provider/health"
```

Expected:

```json
{
  "provider": "swift",
  "modelId": "glm-5.1",
  "status": "healthy"
}
```

Cek logs production setelah satu test generation:

```powershell
npx vercel logs --since 30m --json
```

Cari event berikut:

```text
swift_model_route
openrouter_request_created
provider_attempt
first_token_received
ai_response_received
```

Expected model internal hanya `glm-5.1`. Tidak boleh muncul `poolside/laguna-m.1:free` atau `openrouter/owl-alpha`.

### 6. Test Generation Kecil

Gunakan prompt kecil agar validasi cepat:

```text
Buat landing page sederhana untuk toko kopi dengan hero, daftar menu, dan footer. Frontend only.
```

Expected:

- Job masuk `queued` lalu `running`.
- `GenerationAttempt.metadataJson` mencatat `modelName: "glm-5.1"`.
- Job selesai `completed`, bukan `dead_lettered`.
- `UsageLog.status` menjadi `completed`.
- Saldo internal user terdebit Rp3.000 dan tidak refund.
- Dashboard Agent Router menunjukkan usage bertambah setelah refresh.

### 7. Query Database Setelah Test

Gunakan query observasi ini untuk memastikan tidak ada model lama:

```sql
select
  ga."jobId",
  ga.sequence,
  ga.provider,
  ga.model,
  ga.purpose,
  ga.status,
  ga."latencyMs",
  ga."metadataJson",
  ga."startedAt"
from "GenerationAttempt" ga
order by ga."startedAt" desc
limit 20;
```

Expected:

- `metadataJson` hanya berisi provider attempt `glm-5.1`.
- Tidak ada `poolside/laguna-m.1:free`.
- Tidak ada `openrouter/owl-alpha`.

## Code Hardening Yang Disarankan

### A. Tambah Startup Env Audit Di Worker

Saat worker start, log model chain efektif:

```text
generation_worker_env_snapshot
AGENTROUTER_BASE_URL
AGENTROUTER_MODEL
SWIFT_AI_MODEL_CHAIN
SWIFT_AI_PROVIDER_NAME
```

Secret harus tetap di-redact. Tujuannya supaya mismatch env langsung terlihat di log.

### B. Fail Fast Jika Model Lama Muncul Di Production

Tambahkan guard production di model chain resolver:

```text
Jika NODE_ENV=production dan model mengandung poolside/laguna/openrouter/owl-alpha, throw config error.
```

Ini mencegah worker diam-diam memakai route lama.

### C. Simpan Token Usage Dari Streaming

Saat ini `GenerationAttempt` sering menyimpan token `0` karena streaming response tidak membawa usage final. Jika Agent Router mendukung usage pada final chunk, parse usage dari stream final. Jika tidak, minimal simpan estimated token/cost dari jumlah karakter agar dashboard internal tidak terlihat kosong.

### D. Perbaiki Status Job Stale

Ada job yang pernah terlihat `running` tetapi sudah punya `failedAt` dan usage sudah `refunded`. Reconciliation harus menormalkan status terminal:

```text
Jika failedAt != null dan status bukan completed/cancelled, set status failed/dead_lettered sesuai orchestrationState.
Jika UsageLog refunded, UI jangan tampilkan job sebagai running.
```

## Rollback Plan

Jika `glm-5.1` tidak stabil:

1. Jangan kembali ke free model lama tanpa label eksplisit.
2. Set fallback Agent Router berbayar yang valid dan sudah diuji.
3. Redeploy dan restart worker.
4. Jalankan test generation kecil.
5. Cek Agent Router dashboard dan `GenerationAttempt.metadataJson`.

Rollback hanya boleh dianggap aman jika:

- Billing internal tetap reserve/refund dengan benar.
- Provider attempt tidak memakai model free lama yang tidak diinginkan.
- Health endpoint `healthy`.
- Job test selesai `completed`.

## Production Readiness Checklist

- [ ] CLI Vercel login dan repo ter-link ke project production `sw` yang benar.
- [ ] Vercel Production env memakai Agent Router `glm-5.1`.
- [ ] Worker env memakai Agent Router `glm-5.1`.
- [ ] Tidak ada env model lama di Vercel atau worker.
- [ ] Production redeploy selesai.
- [ ] Worker restart selesai.
- [ ] `npm run audit:production-env` lulus.
- [ ] Health endpoint menunjukkan `modelId: "glm-5.1"` dan `status: "healthy"`.
- [ ] Test generation kecil selesai `completed`.
- [ ] `UsageLog.status` menjadi `completed`, bukan `refunded`.
- [ ] Agent Router dashboard usage bertambah.
- [ ] Logs tidak lagi menampilkan `poolside/laguna-m.1:free` atau `openrouter/owl-alpha`.
- [ ] Reconciliation job membersihkan status stale.

## Definition Of Done

Fix dianggap production-ready jika satu test generation production berhasil end-to-end dengan model internal `glm-5.1`, billing internal selesai `completed`, tidak ada refund otomatis, dan dashboard Agent Router menunjukkan penggunaan bertambah.
