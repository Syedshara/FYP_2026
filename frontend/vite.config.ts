import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:8000/api/v1',
        ws: true,
        changeOrigin: true,
        // Suppress noisy proxy errors when backend is unavailable
        configure: (proxy) => {
          proxy.on('error', (err) => {
            if (err.message.includes('ECONNABORTED') || err.message.includes('ECONNREFUSED') || err.message.includes('ECONNRESET')) {
              return;
            }
            console.error('[ws proxy]', err.message);
          });
        },
      },
    },
  },
})
