# Redis Configuration for Swift AI

## Overview
Swift AI uses Redis for job queue management through BullMQ. The system requires a **native Redis TCP connection**, not just the REST API.

## Current Status
- ✅ Upstash REST API configured (UPSTASH_REDIS_REST_URL & UPSTASH_REDIS_REST_TOKEN)
- ❌ Native Redis URL missing (REDIS_URL)
- ❌ Generation jobs failing with "Generation queue is unavailable"

## Setup Steps

### Step 1: Get Upstash Native Redis Credentials

1. Visit https://console.upstash.com/redis
2. Click on your Redis instance (should be `true-mink-98071`)
3. Go to the **Connect** section
4. Look for the **Native Redis Connection** option (not REST)
5. Copy the connection string which should look like:
   ```
   redis://default:YOUR_PASSWORD@true-mink-98071.upstash.io:31329
   ```

### Step 2: Update .env File

1. Open `.env` file in your editor
2. Find the Redis section (around line 19)
3. Update or add the REDIS_URL line:
   ```env
   REDIS_URL=redis://default:YOUR_PASSWORD@true-mink-98071.upstash.io:31329
   ```
   
   Replace `YOUR_PASSWORD` with the actual password from Upstash console.

### Step 3: Restart Application

```bash
# If using dev server:
npm run dev

# If using production:
npm run build
npm run start
```

## Verification

After restarting, test if Redis is working:

1. Try creating a generation job in the dashboard
2. Check browser console for errors
3. Check server logs for Redis connection messages
4. Look for "Generation job queued" success message

## Troubleshooting

### Error: "Redis queue is not configured"
- REDIS_URL is not set or invalid
- Check Step 1 and Step 2 above

### Error: "ECONNREFUSED"
- Redis host is unreachable
- Verify correct hostname and port in REDIS_URL
- Check your network can reach Upstash

### Error: "WRONGPASS"
- The password in REDIS_URL is incorrect
- Get the correct password from Upstash console

### Generation jobs created but not processing
- Ensure SWIFT_ENABLE_GENERATION_WORKER=true in .env
- Worker may need to be running in a separate process

## What REDIS_URL Does

The REDIS_URL environment variable is used by:
1. **Generation Queue** - Manages AI code generation job queue (BullMQ)
2. **Generation Worker** - Processes queued generation jobs
3. **AI Queue** - Rate limiting and concurrency control for AI requests

## Environment Variables

```env
# REST API (for HTTP endpoints, already configured)
UPSTASH_REDIS_REST_URL=https://true-mink-98071.upstash.io
UPSTASH_REDIS_REST_TOKEN=your_rest_token

# Native Redis (required for BullMQ queues)
REDIS_URL=redis://default:your_password@hostname:port

# Enable generation worker
SWIFT_ENABLE_GENERATION_WORKER=true
```

## Alternative: Local Redis Development

For development, you can use local Redis instead:

```bash
# Install Redis locally or use Docker
docker run -d -p 6379:redis redis:latest

# Set in .env
REDIS_URL=redis://localhost:6379
```

## Additional Resources

- BullMQ Documentation: https://docs.bullmq.io/
- Upstash Console: https://console.upstash.com/
- Upstash Docs: https://upstash.com/docs/redis/overview
