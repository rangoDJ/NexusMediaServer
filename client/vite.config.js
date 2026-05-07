import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // In dev, proxy API calls to the Fastify server running on :3000.
  // In production, both are served from the same process — no proxy needed.
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
