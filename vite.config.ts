import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: 'dashboard',
  build: { outDir: '../dist/dashboard', emptyOutDir: true },
  server: { proxy: { '/api': 'http://127.0.0.1:3000', '/sites': 'http://127.0.0.1:3000', '/versions': 'http://127.0.0.1:3000', '/health': 'http://127.0.0.1:3000' } },
});
