import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Use relative paths for Electron file:// protocol compatibility
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/mermaid')) return 'vendor-mermaid';
          if (id.includes('node_modules/katex')) return 'vendor-katex';
          if (id.includes('node_modules/highlight.js')) return 'vendor-highlight';
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    exclude: ['tests/_pending/**', 'e2e/**', 'node_modules', 'dist'],
  },
});
