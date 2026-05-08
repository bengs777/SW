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
}

module.exports = nextConfig
