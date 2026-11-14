// Profiling-Build des Portals, nur fürs Labor (`wiedergabe.mjs profil`, `cpu-profil.mjs`): react-dom →
// react-dom/profiling, damit Fasern Renderzeiten tragen, und unminifiziert, damit das CPU-Profil Funktionsnamen zeigt.
// Spiegelt frontend/portal/vite.config.ts in dem, was für die Messung zählt. Aufruf aus frontend/portal:
//   VITE_API_BASE= VITE_KEYCLOAK_URL=http://localhost:15744/auth \
//     npx vite build --config ../../docs/performance/baseline/vite.profil.config.mjs --outDir <dist>
// VITE_API_BASE leer lassen: die Wiedergabe fängt /api/ auf demselben Ursprung ab (sonst CORS-Vorabfragen).
import { fileURLToPath } from 'node:url';

const portal = new URL('../../../frontend/portal/', import.meta.url);
const { defineConfig } = await import(new URL('node_modules/vite/dist/node/index.js', portal).href);
const { default: react } = await import(new URL('node_modules/@vitejs/plugin-react/dist/index.js', portal).href);

export default defineConfig({
  root: fileURLToPath(portal),
  plugins: [react()],
  resolve: { alias: [{ find: /^react-dom$/, replacement: 'react-dom/profiling' }] },
  esbuild: { keepNames: true },
  build: {
    minify: false,
    assetsInlineLimit: (filePath) => (filePath.includes('voltpilot-wordmark') ? true : undefined),
  },
});
