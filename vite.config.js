import { defineConfig } from 'vite';

// The preview is served through a proxy, and a cached module there is
// indistinguishable from a bug in the app: you get a fresh index.html driving a
// stale bundle. Dev responses are therefore sent no-store, and index.html
// requests the entry with a ?v=<build> query so a cached copy cannot be reused
// by URL either.
export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    cors: true,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      Pragma: 'no-cache',
      Expires: '0',
    },
  },
  preview: { host: '0.0.0.0', port: 5173, allowedHosts: true },
});
