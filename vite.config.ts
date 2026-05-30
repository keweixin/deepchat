import { defineConfig } from 'vitest/config';
import fs from 'fs';
import path from 'path';

export default defineConfig({
  // Use relative paths for Electron file:// protocol compatibility
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 650,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Force-split mermaid core + parser; split heavy shared deps to keep chunks under 500KB.
          if (id.includes('node_modules/mermaid/dist/mermaid.core.mjs')) return 'vendor-mermaid';
          if (id.includes('node_modules/@mermaid-js/parser')) return 'vendor-mermaid-parser';
          if (id.includes('node_modules/katex')) return 'vendor-katex';
          if (id.includes('node_modules/highlight.js')) return 'vendor-highlight';
          if (id.includes('node_modules/d3')) return 'vendor-d3';
          if (id.includes('node_modules/marked')) return 'vendor-marked';
        },
      },
    },
  },
  plugins: [
    {
      name: 'resolve-ts-in-electron',
      enforce: 'pre',
      resolveId(source, importer) {
        if (source.endsWith('.js') && importer && importer.includes('/electron/')) {
          const tsSource = source.slice(0, -3) + '.ts';
          const resolved = path.resolve(path.dirname(importer), tsSource);
          if (fs.existsSync(resolved)) {
            return resolved;
          }
        }
      },
    },
  ],
  test: {
    environment: 'jsdom',
    globals: true,
    exclude: ['tests/_pending/**', 'e2e/**', 'node_modules', 'dist'],
  },
});
