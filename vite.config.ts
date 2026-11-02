import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  worker: {
    format: 'es',
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
    // build_mac_app.sh 会在项目根的 build/ 里生成整个 .app（含 ~800MB Python 运行时），
    // 不忽略的话每次构建都会被 watcher 当成源码变更，触发成百次整页 reload。
    // dist/ 同理（vite build 的产物）。两者都不参与 dev 的模块图。
    watch: {
      ignored: ['**/build/**', '**/dist/**', '**/.workbuddy/**'],
    },
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
          if (id.includes('/src/i18n/')) {
            return 'ui-i18n';
          }
        },
      },
    },
  },
});
