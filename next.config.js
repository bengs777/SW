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

module.exports = withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: true,
  widenClientFileUpload: true,
  hideSourceMaps: true,
})
