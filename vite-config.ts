// biome-ignore assist/source/organizeImports: <explanation>
import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),  // Maps @/ to ./src/
    },
  },
  // Optional: Add build/test-specific config if needed
  build: {
    outDir: 'dist',
    // Ensure ES modules are built correctly for your imports
    lib: {
      entry: 'src/index.js',  // Adjust if your entry is different
      formats: ['es'],  // Use 'es' for modern JS modules
    },
  },
  test: {
    // Vitest-specific config (if not already set)
    environment: 'node',
  },
});