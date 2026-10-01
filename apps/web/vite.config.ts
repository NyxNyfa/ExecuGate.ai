import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The dev server proxies `/api` to the Fastify process so the browser sees a single
 * origin. Without this, every request from the page would need an absolute URL and
 * the API would need permissive CORS configured for localhost:5173.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    // Bound to loopback: the dashboard exposes tenant data and has no auth of its own,
    // so it must not be reachable from the network during development.
    host: '127.0.0.1',
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/health': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/ready': { target: 'http://127.0.0.1:3000', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});