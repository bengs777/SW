# Production AI Builder Audit

This project now has a production audit gate for a modern AI full-stack builder.

Run before production deploy:

```bash
npm run audit:production
```

The audit runs:

- `npm run lint`
- `npm run typecheck`
- `npm run build`
- static checks for AI output validation, sandbox execution, preview isolation, database persistence, deployment readiness, and cost telemetry

Current high-priority audit notes:

- Runtime sandbox exists and performs `npm install`, `npm run build`, dev-server start, process cleanup, command timeout, safe path writes, and reset.
- AI generation endpoint uses Zod request validation, structured provider output extraction, full-stack coverage validation, relevance validation, and provider request logging.
- Preview iframe includes an error boundary and compile timeout, but `allow-scripts allow-same-origin` should be removed or replaced with a stricter origin strategy before public multi-tenant use.
- Autosave persistence has a unique `(projectId, path)` guard and generation history, but multi-tab conflict resolution should use explicit file versions or optimistic concurrency tokens.
- Cost telemetry stores request tokens and usage cost signals, but sandbox runtime minutes, storage bytes, and bandwidth should be metered separately for reliable unit economics.

Production release policy:

- Do not deploy production when `npm run lint`, `npm run typecheck`, or `npm run build` fails.
- Treat warning findings from `npm run audit:production` as launch blockers for public multi-tenant plans unless explicitly accepted by engineering.
