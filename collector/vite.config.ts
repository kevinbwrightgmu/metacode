// Vite + Vitest configuration.
//
// The collector is served by the MetaCode server at /collector/ (production
// build in dist/). Scramjet's files, its service worker and the Wisp endpoint
// come from that same server, so the app and the proxied Reddit pages share
// one origin. In development (`npm run dev`), Vite proxies those paths to a
// running MetaCode server: METACODE_URL (collector/.env or the shell),
// default http://localhost:3000.
import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const METACODE_URL = env.METACODE_URL || 'http://localhost:3000';
  return {
    base: '/collector/',
    plugins: [react()],
    build: { outDir: 'dist', emptyOutDir: true, sourcemap: true },
    worker: { format: 'es' },
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        '/scramjet-sw.js': { target: METACODE_URL, changeOrigin: true },
        '/scramjet/': { target: METACODE_URL, changeOrigin: true },
        '/api/scraper/status': { target: METACODE_URL, changeOrigin: true },
        // The Wisp endpoint only accepts WebSockets from its own origin.
        '/wisp/': {
          target: METACODE_URL, ws: true, changeOrigin: true,
          configure: proxy => { proxy.on('proxyReqWs', proxyReq => { proxyReq.setHeader('origin', METACODE_URL); }); }
        }
      }
    },
    test: {
      environment: 'jsdom',
      include: ['test/**/*.test.ts'],
      setupFiles: ['test/setup.ts'],
      restoreMocks: true
    }
  };
});
