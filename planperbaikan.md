# Plan Perbaikan Swift AI Production

Tanggal: Kamis, 4 Juni 2026

## Target

Swift AI berjalan dengan arsitektur:

```txt
Vercel Web Swift
-> OpenRouter
-> VPS Sandbox Alibaba
-> Preview
```

Tidak memakai platform worker lama.

## Perbaikan Yang Dilakukan

```txt
Sandbox URL diarahkan ke https://sandbox.ai-swift.biz.id
OpenRouter model diarahkan ke OPENROUTER_MODEL
Default model production disamakan ke poolside/laguna-xs.2:free
Fallback OpenRouter sederhana memakai openrouter/owl-alpha
Konfigurasi platform worker lama dihapus
Script audit production disesuaikan ke Vercel + VPS sandbox
Dokumentasi production disesuaikan ke env OpenRouter baru
```

## Env Production Vercel

```env
OPENROUTER_API_KEY=<ISI_KEY_OPENROUTER>
OPENROUTER_MODEL=poolside/laguna-xs.2:free
SWIFT_AI_PROVIDER_NAME=openrouter

SANDBOX_SERVICE_URL=https://sandbox.ai-swift.biz.id
SANDBOX_PUBLIC_BASE_URL=https://sandbox.ai-swift.biz.id
SANDBOX_SERVICE_TOKEN=<TOKEN_SANDBOX>

SWIFT_GENERATION_EXECUTION_MODE=queue
SWIFT_DISABLE_SERVERLESS_GENERATION_FALLBACK=true
NODE_ENV=production
```

## Env VPS Sandbox

```env
NODE_ENV=production
PORT=8080
SANDBOX_SERVICE_TOKEN=<TOKEN_SANDBOX>
SANDBOX_PUBLIC_BASE_URL=https://sandbox.ai-swift.biz.id
SWIFT_SANDBOX_ROOT=/data/swift-sandbox
```

## Verifikasi

```bash
curl https://sandbox.ai-swift.biz.id/health
curl -i https://sandbox.ai-swift.biz.id/sandbox/compat-check
curl https://www.ai-swift.biz.id/api/provider/health
curl "https://www.ai-swift.biz.id/api/health?refreshProvider=true"
npm run lint
npm run typecheck
npm run build
```

## Production Ready Criteria

```txt
Vercel healthy
Sandbox healthy
Auth healthy
Database healthy
Redis healthy
OpenRouter healthy
Generate berhasil
Preview berhasil
Tidak ada dependency platform worker lama
```
