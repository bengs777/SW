import * as Sentry from "@sentry/nextjs"

let sentryInitialized = false

function initSentryForNonNextRuntime() {
  if (sentryInitialized) return

  const dsn = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN
  sentryInitialized = true

  if (!dsn) return

  Sentry.init({
    dsn,
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0.02),
    beforeSend(event) {
      if (event.request?.cookies) {
        delete event.request.cookies
      }
      if (event.request?.headers) {
        delete event.request.headers.authorization
        delete event.request.headers.cookie
      }
      return event
    },
  })
}

export function captureException(error: unknown, context?: Record<string, unknown>) {
  try {
    initSentryForNonNextRuntime()
    Sentry.captureException(error, {
      extra: context,
    })
  } catch {
    // Error reporting must never break the app or worker lifecycle.
  }
}
