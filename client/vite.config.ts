import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Dev only: forward server routes to the local server so the client can always use
    // same-origin URLs (`io()`, `fetch('/api/...')`), which is what production serves.
    proxy: {
      '/api': 'http://localhost:3001',
      '/mcp': 'http://localhost:3001',
      '/socket.io': { target: 'http://localhost:3001', ws: true },
    },
  },
});
