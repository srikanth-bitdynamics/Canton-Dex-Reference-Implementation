import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, './src'),
    },
  },
  build: {
    // The Canton wallet picker is published as one pre-bundled module. At the
    // current lockfile SDK version it is about 580 kB minified (127 kB gzip), so
    // Rolldown cannot divide it further. Keep that exception named and bound;
    // all other third-party code is split into chunks no larger than 400 kB.
    chunkSizeWarningLimit: 600,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'canton-wallet-ui',
              test: /node_modules[\\/]@canton-network[\\/]core-wallet-ui-components[\\/]/,
              priority: 10,
            },
            {
              name: 'vendor',
              test: /node_modules[\\/]/,
              maxSize: 400 * 1024,
            },
          ],
        },
      },
    },
  },
});
