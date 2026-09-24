import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: {
      '/v1': {
        target: 'http://127.0.0.1:1235',
        changeOrigin: true,
      },
      '/health': {
        target: 'http://127.0.0.1:1235',
        changeOrigin: true,
      },
      '/api/wiki': {
        target: 'http://127.0.0.1:31235',
        changeOrigin: true,
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-markdown-math': [
            'katex',
            'rehype-katex',
            'remark-math',
            'react-markdown',
            'remark-gfm',
          ],
          'vendor-react': ['react', 'react-dom'],
          'vendor-icons': ['lucide-react'],
        },
      },
    },
  },
});
