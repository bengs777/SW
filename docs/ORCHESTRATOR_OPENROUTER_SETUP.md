# Swift AI Gateway Setup

Swift AI uses OpenRouter as the only backend AI gateway. Direct provider SDKs and direct provider API keys are not used.
All Swift product lanes must route to `deepseek/deepseek-v3.2` only.

## Required Env

```env
OPENROUTER_API_KEY=your_openrouter_key
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_SITE_URL=https://swift.biz.id
OPENROUTER_APP_NAME=Swift AI
OPENROUTER_DEEPSEEK_V32_MODEL=deepseek/deepseek-v3.2
SWIFT_USD_TO_IDR=16000
```

Internal pricing:

```env
SWIFT_FAST_PRICE_IDR=4000
SWIFT_BUILDER_PRICE_IDR=22000
SWIFT_PREMIUM_REPAIR_PRICE_IDR=50000
```

Public UI must show Swift AI product lanes and Rupiah pricing, while the runtime continues to use only DeepSeek V3.2.
