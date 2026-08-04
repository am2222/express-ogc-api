import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,  // Optional: Allows skipping `import { describe, it, expect } from 'vitest'`
    environment: 'node',  // Since you're using Express/fetch
    include: ['**/*.{test,spec}.{ts,js}'],  // Matches your test files
    // Installs the DuckDB `spatial` extension once before the worker pool
    // spawns; see test/global-setup.ts for why that has to happen here.
    globalSetup: ['./test/global-setup.ts'],
  },
  resolve: {
    alias: {
      // Optional: Alias for easier imports (e.g., if you have deep src paths)
      '@': path.resolve(__dirname, './src'),
    },
  },
});