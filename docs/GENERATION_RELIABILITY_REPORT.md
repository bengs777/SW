# Swift AI Generation Reliability Report

## Primary Metric

The business-critical metric is usable full-stack app generation success rate:

```text
completed jobs with passing build + passing runtime smoke / total generation jobs
```

Swift now records this through `GenerationQualityMetric` with app type, failure stage, build/runtime pass state, repair attempts, latency, and token/cost signals.

## Controlled Generation Scope

Swift should only optimize these categories before expanding scope:

- SaaS dashboard
- CRUD admin panel
- AI chat app
- landing page + auth
- internal business tool
- booking app
- lightweight CRM
- simple marketplace

The generation stack is locked to Next.js App Router, TypeScript, Tailwind, shadcn/ui-compatible primitives, Prisma, Turso, and Supabase storage.

## Reliability Gates

Before marking a generation successful, the backend must complete:

- intent and app-type classification
- controlled blueprint selection
- deterministic starter architecture seeding
- file-sliced code generation
- conversational edit intent classification
- import graph impact analysis
- partial regeneration scope enforcement
- dependency normalization
- static validation
- preview module compile
- dependency install
- typecheck
- lint
- production build
- runtime smoke verification
- idempotent persistence

## Production Dashboards To Watch

- `generationSuccessRate`
- `buildSuccessRate`
- `runtimeSuccessRate`
- `repairSuccessRate`
- `averageRepairAttempts`
- `averageGenerationLatencyMs`
- `averageTokenCost`
- failures grouped by `failureStage`
- edit intent and preserved file counts in generation metadata

## Conversational Editing Contract

Existing projects should avoid full regeneration. Swift now classifies common edit intents such as pricing page, schema change, API change, runtime fix, upload integration, style/copy edit, and component-scoped edit.

For partial edits the engine should:

- select target files from active file, preview error evidence, prompt-mentioned paths, and ranked relevant files
- expand scope through `file -> imports -> importedBy` so direct dependencies and reverse dependents are considered
- allow only explicit new files needed by the edit
- preserve stable files outside the target scope
- reject broad model output before merge
- validate the full project after the targeted patch

Import graph node shape:

```json
{
  "file": "components/lead-form.tsx",
  "imports": [],
  "importedBy": []
}
```

Developer endpoint:

```text
GET /api/admin/generation-quality?days=7
```

## Remaining Launch Risks

- Real deploy success rate still needs measurement after export/deploy runs are connected to `deployValidated`.
- Playwright-backed runtime smoke requires the runtime package to be available in the sandbox environment.
- Prompt categories outside the controlled list should be rejected, narrowed, or mapped to the nearest supported blueprint.
- Billing chaos tests cover duplicate reservations/refunds locally; run them in staging with Turso before paid traffic.

## Pre-Launch Checklist

```text
npm run db:push:local
npm run db:generate
npm run test:chaos
npm run typecheck
npm run lint
npm run build
npm run audit:production
```

Production env must include Turso, Supabase, Redis queue, provider keys, auth secrets, and Sentry DSN before public launch.
