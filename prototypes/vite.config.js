import { defineConfig } from 'vite';

export default defineConfig({
  root: new URL('.', import.meta.url).pathname,
  oxc: { jsx: { runtime: 'automatic' } },
  server: { host: '127.0.0.1' },
  build: {
    outDir: '../dist/prototypes',
    emptyOutDir: true,
  },
});
