import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));
const hardenedWorker = fileURLToPath(new URL('./public-new/sw.js', import.meta.url));

function hardenedServiceWorker() {
  return {
    name: 'cardgamesmp-hardened-service-worker',
    configureServer(server) {
      server.middlewares.use('/sw.js', (_request, response) => {
        response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        response.setHeader('Cache-Control', 'no-cache');
        response.end(readFileSync(hardenedWorker));
      });
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: readFileSync(hardenedWorker, 'utf8'),
      });
    },
  };
}

export default defineConfig({
  root: projectRoot,
  publicDir: 'public',
  envDir: projectRoot,
  plugins: [hardenedServiceWorker()],
  build: {
    emptyOutDir: true,
  },
});