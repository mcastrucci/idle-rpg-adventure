import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Local server origin for the dev proxy. The server rejects cross-origin browser requests and sets a `Secure`
 * same-site session cookie, so the browser must talk to one origin: Vite serves the app and forwards API/WS paths.
 * `changeOrigin` stays false so the forwarded Host matches the browser Origin (server `checkOrigin`).
 */
const target = process.env['RPG_SERVER_URL'] ?? 'http://127.0.0.1:3000';
const proxied = { target, changeOrigin: false } as const;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // `/auth/live` is the authenticated WebSocket; the rest of `/auth` is plain HTTP.
      '/auth': { ...proxied, ws: true },
      '/characters': proxied,
      '/expeditions': proxied,
      '/live': proxied,
      '/merchant': proxied,
      '/content': proxied,
      // Staging-only debug routes (#132); they answer 404 unless the server runs with RPG_DEBUG_TOOLS.
      '/debug': proxied,
      '/health': proxied,
    },
  },
  build: { target: 'es2022', sourcemap: true },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
  },
});
