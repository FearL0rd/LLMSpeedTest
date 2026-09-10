import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// Tauri expects a fixed dev port and a browser-safe build target.
export default defineConfig({
  plugins: [vue()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    target: 'es2021',
    minify: 'esbuild',
    sourcemap: false,
    outDir: 'dist',
  },
});