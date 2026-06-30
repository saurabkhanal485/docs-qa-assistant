/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['better-sqlite3', '@xenova/transformers'],
  },
};

module.exports = nextConfig;
