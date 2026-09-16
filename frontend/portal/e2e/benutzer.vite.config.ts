import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
export default defineConfig({ plugins: [react()], build: {
  outDir: '/tmp/vp-uems-r03-benutzerverwaltung/e2e', emptyOutDir: true,
  rollupOptions: { input: [resolve(process.cwd(), 'e2e/benutzer.html'), resolve(process.cwd(), 'e2e/startpasswort.html')] },
} });
