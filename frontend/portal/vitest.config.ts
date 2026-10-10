import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Vitest runs the portal's unit + component tests (jsdom). Kept separate from
// vite.config.ts so the production build is untouched; tests are excluded from
// the `tsc` build (tsconfig) and typechecked by vitest's own transform instead.
//
// Node 25 turns Web Storage on by default: its global `localStorage` then hides
// jsdom's and throws a SecurityError without `--localstorage-file`. The flag
// restores the Node 22 behaviour (CI) for the test workers; Node versions that
// do not know the flag get none.
const ohneNodeWebStorage = process.allowedNodeEnvironmentFlags.has('--experimental-webstorage')
  ? ['--no-experimental-webstorage']
  : [];

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // Das Portal zeigt bewusst die Ortszeit des Browsers; die Tests setzen dabei die Berliner Wanduhr voraus
    // („seit 14:10“, Bestandsschutz-Schnappschüsse). Ohne diese Zeile hängen sie an der Zeitzone des Rechners.
    env: { TZ: 'Europe/Berlin' },
    poolOptions: { forks: { execArgv: ohneNodeWebStorage } },
  },
});
