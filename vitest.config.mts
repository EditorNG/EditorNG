import { defineConfig } from 'vitest/config';
import path from 'node:path';

const root = import.meta.dirname;

export default defineConfig({
  resolve: {
    alias: {
      '@core': path.resolve(root, 'src/core'),
      '@shared': path.resolve(root, 'src/shared'),
      '@': path.resolve(root, 'src/renderer'),
    },
  },
  test: { include: ['tests/**/*.test.ts'], testTimeout: 120000 },
});
