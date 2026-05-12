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
  experimental: {
    serverComponentsExternalPackages: ['bullmq', 'ioredis'],
  },
}

module.exports = nextConfig