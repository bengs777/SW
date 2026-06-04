# Checklist Pengecekan Swift AI Production

Target arsitektur:

```txt
User
-> Vercel Web Swift
-> OpenRouter
-> VPS Sandbox Alibaba
-> Preview
```

## 1. Endpoint Publik

```bash
curl https://www.ai-swift.biz.id/api/provider/health
curl "https://www.ai-swift.biz.id/api/health?refreshProvider=true"
curl https://sandbox.ai-swift.biz.id/health
curl -i https://sandbox.ai-swift.biz.id/sandbox/compat-check
```

Kriteria lulus:

```txt
Provider OpenRouter healthy
Vercel health HTTP 200
Sandbox service = swift-sandbox-runtime
Sandbox status = healthy
Compat check tidak 404
```

## 2. Env Production Vercel

Wajib:

```env
SANDBOX_SERVICE_URL=https://sandbox.ai-swift.biz.id
SANDBOX_PUBLIC_BASE_URL=https://sandbox.ai-swift.biz.id
SANDBOX_SERVICE_TOKEN=<TOKEN_SANDBOX>
OPENROUTER_MODEL=poolside/laguna-xs.2:free
SWIFT_AI_PROVIDER_NAME=openrouter
SWIFT_GENERATION_EXECUTION_MODE=queue
SWIFT_DISABLE_SERVERLESS_GENERATION_FALLBACK=true
```

Tidak boleh:

```txt
localhost
IP direct sandbox
typo domain sandbox
hardcoded model berbayar
legacy provider model env
legacy platform env
```

## 3. Queue

Kriteria lulus:

```txt
Redis connected
Waiting job tidak menumpuk
Active job tidak menggantung
Failed job = 0 setelah cleanup
Dead letter = 0 setelah cleanup
```

## 4. Build Lokal

```bash
npm run lint
npm run typecheck
npm run build
```

Semua wajib sukses.

## 5. Smoke Test

Prompt:

```txt
Buat landing page toko kopi modern.
```

Kriteria lulus:

```txt
Generate berhasil
Project tersimpan
Sandbox aktif
Preview terbuka
Tidak ada error queue baru
```
