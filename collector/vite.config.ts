// Vite + Vitest configuration.
//
// The AI Scraper is served by the MetaCode server at /collector/ (production
// build in dist/) and talks to that server's /api/scraper. In development
// (`npm run dev`), Vite proxies the API to a running MetaCode server:
// METACODE_URL (collector/.env or the shell), default http://localhost:3000.
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
        // The scraper API refuses requests whose Origin isn't its own site.
        '/api/scraper': {
          target: METACODE_URL, changeOrigin: true,
          configure: proxy => { proxy.on('proxyReq', proxyReq => { if (proxyReq.getHeader('origin')) proxyReq.setHeader('origin', METACODE_URL); }); }
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
