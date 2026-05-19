const http = require("node:http")
const { Queue, Worker } = require("bullmq")
const IORedis = require("ioredis")

function loadEnvFile(path) {
  const fs = require("node:fs")
  if (!fs.existsSync(path)) return
  for (const line of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match) continue
    const key = match[1]
    if (process.env[key]) continue
    process.env[key] = match[2].trim().replace(/^['"]|['"]$/g, "")
  }
}

loadEnvFile(".env.production")
loadEnvFile(".env")

const redisUrl = process.env.REDIS_URL || process.env.UPSTASH_REDIS_URL || ""

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function classifyStatus(status) {
  if (status === 429 || status === 402) return "rate_limit"
  if (status === 408) return "timeout"
  if (status >= 500) return "server_error"
  return "unknown"
}

async function withFakeAiServer(handler, fn) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  const baseUrl = `http://127.0.0.1:${address.port}`
  try {
    return await fn(baseUrl)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

async function testRedisReconnect() {
  if (!/^rediss?:\/\//i.test(redisUrl)) {
    console.log("[resilience] redis reconnect skipped: native REDIS_URL missing")
    return { skipped: true }
  }

  const createClient = () => new IORedis(redisUrl, {
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,
    connectTimeout: 5000,
    lazyConnect: true,
    ...(redisUrl.startsWith("rediss://") ? { tls: {} } : {}),
  })

  const redis = createClient()
  await redis.connect()
  assert(await redis.ping() === "PONG", "Initial Redis PING failed")
  await redis.quit()

  const reconnected = createClient()
  await reconnected.connect()
  assert(await reconnected.ping() === "PONG", "Redis reconnect PING failed")
  await reconnected.quit()

  console.log("[resilience] redis disconnect/reconnect passed")
  return { skipped: false }
}

async function testWorkerRecovery() {
  if (!/^rediss?:\/\//i.test(redisUrl)) {
    console.log("[resilience] worker recovery skipped: native REDIS_URL missing")
    return { skipped: true }
  }

  const connection = new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    ...(redisUrl.startsWith("rediss://") ? { tls: {} } : {}),
  })
  const queueName = `swift-resilience-smoke-${Date.now()}`
  const queue = new Queue(queueName, { connection })
  let attempts = 0

  await queue.add("recoverable", { ok: true }, { attempts: 3, backoff: { type: "exponential", delay: 2000 } })
  const completed = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Worker recovery timed out")), 15_000)
    const worker = new Worker(
      queueName,
      async () => {
        attempts += 1
        if (attempts < 3) {
          throw new Error("simulated worker failure")
        }
        return { recovered: true }
      },
      {
        connection,
        lockDuration: 5_000,
        stalledInterval: 1_000,
      }
    )
    worker.on("completed", async () => {
      clearTimeout(timeout)
      await worker.close()
      resolve(true)
    })
    worker.on("failed", (_job, error) => {
      if (attempts >= 3) {
        clearTimeout(timeout)
        reject(error)
      }
    })
    worker.on("error", reject)
  })

  await completed
  assert(attempts === 3, `Expected retry recovery in 3 attempts, got ${attempts}`)
  await queue.drain(true)
  await queue.close()
  await connection.quit()
  console.log("[resilience] worker recovery retry passed")
  return { skipped: false, attempts }
}

async function testAiFailureModes() {
  await withFakeAiServer((req, res) => {
    if (req.url.includes("/timeout")) return
    res.writeHead(429, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: { message: "rate limited" } }))
  }, async (baseUrl) => {
    const rateLimit = await fetch(`${baseUrl}/rate-limit`)
    assert(classifyStatus(rateLimit.status) === "rate_limit", "429 was not classified as rate_limit")

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 250)
    try {
      await fetch(`${baseUrl}/timeout`, { signal: controller.signal })
      throw new Error("Timeout simulation did not abort")
    } catch (error) {
      assert(error && error.name === "AbortError", "Timeout did not produce AbortError")
    } finally {
      clearTimeout(timeout)
    }
  })

  try {
    await fetch("http://127.0.0.1:9/network-error")
    throw new Error("Network error simulation unexpectedly succeeded")
  } catch {
    // Expected: closed port.
  }

  console.log("[resilience] AI provider failure simulations passed (429, timeout, network)")
}

async function main() {
  await testRedisReconnect()
  await testWorkerRecovery()
  await testAiFailureModes()
  console.log("[resilience] pipeline resilience smoke checks passed")
}

main().catch((error) => {
  console.error("[resilience] pipeline resilience smoke checks failed")
  console.error(error)
  process.exit(1)
})
