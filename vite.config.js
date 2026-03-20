import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        // A1111 image generation can take minutes on first run.
        timeout: 600000,
        proxyTimeout: 600000,
      },
    },
  },
});
