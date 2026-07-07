import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    // duckdb-wasm ships workers + wasm assets that Vite's dep optimizer mangles.
    exclude: ['@duckdb/duckdb-wasm'],
  },
  server: {
    port: 5173,
  },
});
