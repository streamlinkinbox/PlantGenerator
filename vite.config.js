import { defineConfig } from 'vite';

// The preview is served through a proxy, and a cached module there is
// indistinguishable from a bug in the app: you get a fresh index.html driving a
// stale bundle. Dev responses are therefore sent no-store, and index.html
// requests the entry with a ?v=<build> query so a cached copy cannot be reused
// by URL either.
export default defineConfig({
  // Do NOT pre-bundle three. Vite's optimizer serves deps from
  // /node_modules/.vite/deps/three.js?v=<hash>, and that hash changes whenever
  // the server re-optimizes. An open tab then imports a hash that no longer
  // exists, Vite answers 504 "Outdated Optimize Dep", and a failed import
  // inside a module graph fails SILENTLY - no error event, no console entry
  // from our code, the module simply never executes. Excluding three keeps the
  // import on a stable path that cannot go stale.
  optimizeDeps: {
    exclude: ['three', 'three/addons/controls/OrbitControls.js'],
  },
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
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  // The preview is served from a BUILT bundle: filenames are content-hashed, so
  // a stale copy cannot masquerade as the current one, and there is no dev
  // transform cache to go out of sync with the files on disk.
  preview: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' },
  },
});
