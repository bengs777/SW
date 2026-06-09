# Swift AI Gateway Setup

Swift AI uses OpenRouter as the backend AI gateway.
All Swift generation, inspect, repair, and health-check paths route through the model configured by `OPENROUTER_MODEL`.

## Required Env

```env
OPENROUTER_API_KEY=your_openrouter_key
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_SITE_URL=https://www.ai-swift.biz.id
OPENROUTER_APP_NAME=Swift AI
OPENROUTER_MODEL=openrouter/free
SWIFT_AI_PROVIDER_NAME=openrouter
SWIFT_USD_TO_IDR=16000
```

Internal pricing:

```env
SWIFT_BUILDER_PRICE_IDR=3000
```

Public UI must show one Swift AI orchestrator option and Rupiah pricing, while the runtime continues to use the configured OpenRouter model.

Keep `OPENROUTER_MODEL` identical in Vercel Production and the dedicated VPS generation worker.
