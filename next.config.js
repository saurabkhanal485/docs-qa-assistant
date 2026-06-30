/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['better-sqlite3', '@xenova/transformers'],
    outputFileTracingIncludes: {
      '/api/chat': ['./data/docs.db'],
    },
  },
};

module.exports = nextConfig;