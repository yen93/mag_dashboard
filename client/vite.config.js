import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// During `npm run dev`, the Vite dev server proxies /api to the Express server
// (default port 8080) so the frontend and API share one origin, matching how
// they run together in production behind a single Cloud Run service.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8080',
    },
  },
  build: {
    outDir: 'dist',
  },
});
