import { defineConfig } from 'vite';

export default defineConfig({
  // Use relative paths for Electron file:// protocol compatibility
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 900,
  },
  test: {
    environment: 'jsdom',
    globals: true,
  },
});
