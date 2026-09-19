import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          root: import.meta.dirname,
          include: ['test/**/*.test.ts'],
        },
      },
      {
        plugins: [react()],
        resolve: {
          alias: { '@': resolve(import.meta.dirname, 'src/web/ui') },
        },
        test: {
          name: 'ui',
          root: import.meta.dirname,
          include: ['src/web/ui/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
        },
      },
    ],
  },
});
