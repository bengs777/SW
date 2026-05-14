const { withSentryConfig } = require('@sentry/nextjs')

/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: false,
  },
  allowedDevOrigins: [
    'localhost',
    'localhost:3000',
    '*.vusercontent.net',
    'vusercontent.net',
  ],
  reactCompiler: false,
  // Security headers as defense-in-depth (also enforced by middleware)
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-XSS-Protection', value: '1; mode=block' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()' },
          ...(process.env.NODE_ENV === 'production'
            ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains; preload' }]
            : []),
        ],
      },
      {
        // API routes: prevent caching of authenticated responses
        source: '/api/(.*)',
        headers: [
          { key: 'Cache-Control', value: 'no-store, no-cache, must-revalidate' },
          { key: 'Pragma', value: 'no-cache' },
        ],
      },
    ]
  },
  webpack: (config, { isServer }) => {
    if (isServer) {
      // Mark bullmq and ioredis as external dependencies for server-side
      // This prevents webpack from bundling them and eliminates the critical dependency warning
      config.externals = config.externals || []
      config.externals.push({
        'bullmq': 'commonjs bullmq',
        'ioredis': 'commonjs ioredis',
      })
    }
    return config
  },
  // Exclude bullmq and ioredis from server components bundling since they use Node.js native modules
  serverExternalPackages: ['bullmq', 'ioredis'],
}

// Only apply Sentry build plugin when Sentry is actually configured.
// When unconfigured, withSentryConfig is a no-op wrapper but this makes intent explicit.
const hasSentryBuildConfig = Boolean(
  process.env.SENTRY_ORG &&
  process.env.SENTRY_PROJECT &&
  process.env.SENTRY_AUTH_TOKEN
)

if (hasSentryBuildConfig) {
  module.exports = withSentryConfig(nextConfig, {
    org: process.env.SENTRY_ORG,
    project: process.env.SENTRY_PROJECT,
    authToken: process.env.SENTRY_AUTH_TOKEN,
    silent: true,
    widenClientFileUpload: true,
    hideSourceMaps: true,
  })
} else {
  module.exports = nextConfig
}
