# Swift AI Gateway Setup

Swift AI uses OpenRouter as the only backend AI gateway. Direct provider SDKs and direct provider API keys are not used.
All Swift generation, inspect, repair, and health-check paths route to `deepseek/deepseek-v4-pro` only.

## Required Env

```env
OPENROUTER_API_KEY=your_openrouter_key
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_SITE_URL=https://swift.biz.id
OPENROUTER_APP_NAME=Swift AI
OPENROUTER_DEEPSEEK_V4_PRO_MODEL=deepseek/deepseek-v4-pro
SWIFT_USD_TO_IDR=16000
```

Internal pricing:

```env
SWIFT_BUILDER_PRICE_IDR=3000
```

Public UI must show one Swift AI orchestrator option and Rupiah pricing, while the runtime continues to use only DeepSeek V4 Pro.
