import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  publicDir: resolve('ui/frontend/public'),
  test: {
    environment: 'jsdom',
    globals: true,
  },
  build: {
    outDir: resolve('ui/static/dist'),
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: resolve('ui/frontend/src/main.jsx'),
      output: {
        entryFileNames: 'app.js',
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: (assetInfo) => {
          if (assetInfo.name && assetInfo.name.endsWith('.css')) {
            return 'app.css';
          }
          return 'assets/[name][extname]';
        },
      },
    },
  },
});
