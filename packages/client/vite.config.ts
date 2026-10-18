import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // ws: also proxy the WebSocket upgrade at /api/canvases/:id/ws.
      '/api': { target: 'http://localhost:3001', ws: true },
    },
  },
});
