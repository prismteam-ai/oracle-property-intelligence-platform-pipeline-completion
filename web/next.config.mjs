import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Repo has sibling lockfiles; pin the tracing root to this app so Vercel
  // bundles the right files.
  outputFileTracingRoot: here,
  // DuckDB-WASM ships large wasm; don't let Next try to bundle it server-side.
  webpack: (config) => {
    config.resolve.fallback = { ...config.resolve.fallback, fs: false };
    return config;
  },
};
export default nextConfig;
