# Orchestrator + OpenRouter Setup Guide

## Quick Start

Orchestrator uses OpenRouter to provide the Swift AI model. Setup is simple:

### Step 1: Get OpenRouter API Key

1. Go to https://openrouter.ai/keys
2. Sign up or log in
3. Copy your API key

### Step 2: Configure Environment Variables

Add to your `.env.local`:

```env
OPENAI_API_KEY=your_openrouter_api_key_here
OPENAI_API_URL=https://openrouter.ai/api/v1
```

### Step 3: Done!

Orchestrator will automatically appear in the model selector as:
**"Swift AI (2000/req)"**

## Why OpenRouter?

OpenRouter provides several benefits:

- **Reliable Infrastructure**: Battle-tested API with high uptime
- **Multiple Models**: Access to 200+ models beyond just Swift AI
- **Fair Pricing**: Competitive pricing for Swift AI
- **Shared Key**: Uses same OPENAI_API_KEY as other OpenRouter models
- **No Extra Setup**: No separate Orchestrator API key needed

## Model Details

| Property | Value |
|----------|-------|
| API Provider | OpenRouter |
| Model | Swift AI |
| Cost | 2,000 IDR per request |
| Max Tokens | 4,000 |
| Temperature | 0.7 |
| Timeout | 30 seconds |

## Architecture

```
User Prompt
    ↓
Orchestrator Provider (lib/ai/providers/orchestrator-provider.ts)
    ↓
OpenRouter API (https://openrouter.ai/api/v1/chat/completions)
    ↓
Swift AI Model
    ↓
Generated Code (JSON with files array)
    ↓
Parse & Validate
    ↓
Charge User Balance (2,000 IDR)
    ↓
Return Generated Files
```

## Files Involved

- `lib/ai/providers/orchestrator-provider.ts` - Provider that calls OpenRouter
- `app/api/generate/orchestrator/route.ts` - API endpoint with billing
- `lib/services/generate-billing.service.ts` - Balance checking and charging

## Response Format

Orchestrator always expects and generates JSON with this structure:

```json
{
  "files": [
    {
      "path": "app/page.tsx",
      "content": "export default function Home() { ... }",
      "language": "typescript"
    },
    {
      "path": "app/globals.css",
      "content": "body { margin: 0; }",
      "language": "css"
    }
  ]
}
```

## Error Handling

Orchestrator handles these error cases gracefully:

- **No API Key**: Returns 503 "Provider not configured"
- **Insufficient Balance**: Returns 402 with shortfall amount
- **API Error**: Returns 502 with error message
- **Timeout**: Returns 504 "Request timeout"
- **Invalid JSON**: Returns 400 "Invalid response from AI"

## Billing

Each Orchestrator request costs exactly **2,000 IDR**:

- Only charged on successful generation
- Failed requests do NOT incur charges
- Balance is checked before generation
- Request fails if balance < 2,000 IDR
- Admin can manually refund if needed

## Testing

To test Orchestrator:

```bash
# 1. Ensure OPENAI_API_KEY and OPENAI_API_URL are set
# 2. Start dev server
npm run dev

# 3. Go to editor and select "Swift AI (2000/req)"
# 4. Enter a prompt: "Create a simple counter app with React and Tailwind"
# 5. Click Generate
# 6. Should see generated code in the preview
```

## Troubleshooting

### "Orchestrator not available in model selector"

- Check that `OPENAI_API_KEY` is set
- Check that `OPENAI_API_URL=https://openrouter.ai/api/v1`
- Restart dev server after env changes

### "Insufficient balance" error

- Check user's current balance
- User needs at least 2,000 IDR for one generation
- Admin can topup user balance via dashboard

### "API error from OpenRouter"

- Check API key is valid at https://openrouter.ai/keys
- Check OpenRouter is accessible (not blocked by firewall)
- Check Swift AI is available on OpenRouter

## Switching Models

Orchestrator is hardcoded to use `Swift AI`. To use a different OpenRouter model:

Edit `lib/ai/providers/orchestrator-provider.ts`:

```typescript
const ORCHESTRATOR_MODEL = "Swift AI" // Change this
```

Available models on OpenRouter: https://openrouter.ai/docs/models
