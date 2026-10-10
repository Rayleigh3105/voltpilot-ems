import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Statische Prüfansicht: kein Entwicklungsserver und keine Fixture im Produktionsbundle.
export default defineConfig({ plugins: [react()], build: {
  outDir: '/tmp/vp-uems-r03-startpasswort-e2e', emptyOutDir: true,
  rollupOptions: { input: resolve(process.cwd(), 'e2e/startpasswort.html') },
} });
