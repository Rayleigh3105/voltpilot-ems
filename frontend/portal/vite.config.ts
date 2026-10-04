import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  build: {
    // ⚠ Die Wortmarke (voltpilot-wordmark.png, 9,2 kB) wird IMMER als Data-URI
    // ins Bündel gebacken - der Lade-Moment (`VpLoader`/`BootSplash`) zeigt sie
    // beim Mount ohne Netz-Request, byte-genau dasselbe Bild wie der Inline-Lader
    // in `index.html` (Review SOLLTE-1). `assetsInlineLimit` als Funktion gibt es
    // seit Vite 5.0; `?inline` (Vite 6) tut es auf Vite 5.4 NICHT und liesse die
    // Marke im Build als Netz-Asset stehen. Alle anderen Assets behalten die
    // Standard-Grenze (Rückgabe `undefined`). Wächter: test:bundle prüft, dass
    // die Wortmarke inline ist und keine eigene `.png` emittiert wird.
    assetsInlineLimit: (filePath: string) =>
      filePath.includes("voltpilot-wordmark") ? true : undefined,
  },
});
