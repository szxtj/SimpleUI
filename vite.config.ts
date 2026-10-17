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
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (
              id.includes('katex') ||
              id.includes('rehype-') ||
              id.includes('remark-') ||
              id.includes('react-markdown') ||
              id.includes('unified') ||
              id.includes('micromark') ||
              id.includes('mdast-') ||
              id.includes('hast-')
            ) {
              return 'vendor-markdown-math';
            }
            if (id.includes('lucide-react')) {
              return 'vendor-icons';
            }
            if (id.includes('react-dom') || id.includes('react/') || id.includes('scheduler')) {
              return 'vendor-react';
            }
          }
          if (id.includes('/src/components/ServiceManagerModal') || id.includes('/src/components/SettingsModal')) {
            return 'ui-modals';
          }
          if (id.includes('/src/i18n/')) {
            return 'ui-i18n';
          }
        },
      },
    },
  },
});
