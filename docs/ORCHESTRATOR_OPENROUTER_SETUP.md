# Swift AI Gateway Setup

Swift AI uses OpenRouter as the only backend AI gateway. Direct provider SDKs and direct provider API keys are not used.

## Required Env

```env
OPENROUTER_API_KEY=your_openrouter_key
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_SITE_URL=https://swift.biz.id
OPENROUTER_APP_NAME=Swift AI
```

Optional internal model overrides:

```env
OPENROUTER_SWIFT1_MODEL=
OPENROUTER_SWIFT1_FALLBACK_MODEL=
OPENROUTER_SWIFT2_MODEL=
OPENROUTER_SWIFT2_FALLBACK_MODEL=
OPENROUTER_SWIFT3_MODEL=
OPENROUTER_SWIFT3_FALLBACK_MODEL=
```

Public UI must show only Swift 1, Swift 2, Swift 3, and Rupiah pricing.
