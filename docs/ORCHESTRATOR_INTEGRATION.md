# Swift AI Orchestrator

The orchestrator routes Swift 1, Swift 2, and Swift 3 through the AgentRouter gateway configured by `AGENTROUTER_API_KEY`.

Public users never see internal model IDs, provider routing, token pricing, or gateway branding. Admin-only health checks may inspect internal model health for debugging.

## Production Guarantees

- Tier-based model chain.
- Hard timeout per Swift tier.
- Maximum one retry per transient model failure.
- Fallback to the next configured model.
- Atomic balance reserve, capture, and refund.
- Queue overload protection before billing reserve.
- Structured request and billing audit fields in internal logs.
