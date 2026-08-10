import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const portalRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Throwaway: runs ONLY the harness smoke test (the app suite is untouched). */
export default defineConfig({
  root: portalRoot,
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: [resolve(portalRoot, 'src/test/setup.ts')],
    include: ['chart-harness/**/*.test.tsx'],
  },
});
