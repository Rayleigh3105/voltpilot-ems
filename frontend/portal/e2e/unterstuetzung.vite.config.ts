import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
export default defineConfig({ plugins: [react()], build: {
  outDir: '/tmp/vp-uems-r03-unterstuetzung-portal/e2e', emptyOutDir: true,
  rollupOptions: { input: ['unterstuetzung', 'benutzer', 'startpasswort'].map(n => resolve(process.cwd(), `e2e/${n}.html`)) },
} });
