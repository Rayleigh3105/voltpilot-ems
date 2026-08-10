import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const here = dirname(fileURLToPath(import.meta.url));
const portalRoot = resolve(here, '..');

/**
 * THROWAWAY chart fixture harness.
 *
 * Its own Vite root (`chart-harness/`) so it never touches the app's
 * `index.html` / `vite.config.ts`. Imports reach the real components
 * relatively (`../src/...`) - there is deliberately NO alias, so what renders
 * here is byte-for-byte what the portal renders.
 */
export default defineConfig({
  root: here,
  plugins: [react()],
  server: {
    port: 5199,
    strictPort: true,
    // `../src` and `../designsystem` live outside the Vite root, so the dev
    // server has to be told it may serve them.
    fs: { allow: [portalRoot] },
  },
  build: {
    outDir: resolve(here, 'dist'),
    emptyOutDir: true,
  },
});
