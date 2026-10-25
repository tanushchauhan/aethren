import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

// Override with VITE_API_TARGET to point the dev client at another local server.
const api = process.env.VITE_API_TARGET ?? 'http://localhost:3001';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(rootDir, 'src'),
    },
  },
  server: {
    port: 5173,
    // Dev only: forward server routes to the local server so the client can always use
    // same-origin URLs (`io()`, `fetch('/api/...')`), which is what production serves.
    proxy: {
      '/health': api,
      '/api': api,
      '/mcp': api,
      '/socket.io': { target: api, ws: true },
    },
  },
});
