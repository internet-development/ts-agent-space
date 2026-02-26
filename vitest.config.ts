import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.test.ts'],
    exclude: ['node_modules', 'data'],
  },
  resolve: {
    alias: {
      '@common': path.resolve(__dirname, './common'),
      '@modules': path.resolve(__dirname, './modules'),
    },
  },
});
