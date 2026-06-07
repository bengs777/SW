# Swift AI Gateway Setup

Swift AI uses AgentRouter as the backend AI gateway. Direct provider SDKs and direct provider API keys are not used.
All Swift generation, inspect, repair, and health-check paths route through the model configured by `AGENTROUTER_MODEL`.

## Required Env

```env
AGENTROUTER_API_KEY=your_agentrouter_key
AGENTROUTER_BASE_URL=https://agentrouter.org/v1
AGENTROUTER_SITE_URL=https://www.ai-swift.biz.id
AGENTROUTER_APP_NAME=Swift AI
AGENTROUTER_MODEL=glm-5.1
SWIFT_AI_PROVIDER_NAME=agentrouter
SWIFT_USD_TO_IDR=16000
```

Internal pricing:

```env
SWIFT_BUILDER_PRICE_IDR=3000
```

Public UI must show one Swift AI orchestrator option and Rupiah pricing, while the runtime continues to use the configured AgentRouter model.

Keep `AGENTROUTER_MODEL` identical in Vercel Production and the dedicated VPS generation worker. During production stabilization, keep fallback models limited to known healthy AgentRouter routes.
