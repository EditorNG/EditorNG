import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const root = import.meta.dirname;

export default defineConfig({
  root: path.resolve(root, 'src/renderer'),
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@core': path.resolve(root, 'src/core'),
      '@shared': path.resolve(root, 'src/shared'),
      '@': path.resolve(root, 'src/renderer'),
    },
  },
  build: {
    outDir: path.resolve(root, 'out/renderer'),
    emptyOutDir: true,
    target: 'chrome130',
    chunkSizeWarningLimit: 8000,
    sourcemap: false,
  },
  worker: { format: 'es' },
  server: { port: 5183, strictPort: true },
});
