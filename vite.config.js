import { defineConfig } from 'vite';

/**
 * The preview is served through a proxy, and a cached module there is
 * indistinguishable from a bug in the app (you get a fresh index.html driving a
 * stale bundle). Kill every cache header in dev so that cannot happen: no
 * store, no revalidation, no ETag to match against.
 */
function noStore() {
  return {
    name: 'no-store-dev',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const set = res.setHeader.bind(res);
        res.setHeader = (name, value) => {
          const n = String(name).toLowerCase();
          if (n === 'etag' || n === 'last-modified') return res;
          if (n === 'cache-control') return set(name, 'no-store, no-cache, must-revalidate, max-age=0');
          return set(name, value);
        };
        set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
        set('Pragma', 'no-cache');
        set('Expires', '0');
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [noStore()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    cors: true,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    },
  },
  preview: { host: '0.0.0.0', port: 5173, allowedHosts: true },
});
