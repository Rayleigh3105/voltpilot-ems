import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Vitest runs the portal's unit + component tests (jsdom). Kept separate from
// vite.config.ts so the production build is untouched; tests are excluded from
// the `tsc` build (tsconfig) and typechecked by vitest's own transform instead.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
