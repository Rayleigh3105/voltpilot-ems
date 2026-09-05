// HARNESS · Bewegung P1 — Vite-Konfiguration NUR fuer den Browser-Beweis.
//
// ⚠ Warum es sie gibt: laeuft eine zweite Spur, ist 5173 belegt und dieser
// Arbeitsbaum bekommt einen anderen Port. Dann greifen zwei fremde Zaeune:
// Keycloak kennt nur 5173 als Redirect-Ziel, und die api laesst per
// `VOLTPILOT_CORS_ALLOWED_ORIGINS` nur 5173 als Ursprung zu.
//
// Der Redirect wird additiv in der Dev-Keycloak freigeschaltet; die CORS-Regel
// der api wird NICHT angefasst (ein Neustart risse der Nachbarspur ihren Beweis
// weg). Stattdessen laeuft der API-Verkehr hier GLEICHURSPRUENGLICH: der
// Browser ruft `/api` auf dem Dev-Server auf, und Vite reicht es serverseitig
// an 8090 weiter — damit gibt es gar keinen Vorabflug, den jemand ablehnen
// koennte. Aufruf:
//   npx vite --config e2e/motion-lab/vite.harness.ts
// zusammen mit VITE_API_BASE=/api (siehe `.env.harness` daneben).
//
// Reines Werkzeug: die ausgelieferte `vite.config.ts` bleibt unberuehrt.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  envDir: 'e2e/motion-lab',
  server: {
    port: Number(process.env.VP_PORT || 5181),
    strictPort: true,
    proxy: {
      '/api': { target: 'http://localhost:8090', changeOrigin: true },
    },
  },
});
