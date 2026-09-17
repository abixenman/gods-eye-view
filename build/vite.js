import { applicationHtmlPlugin } from './application-html.js';
import cesium from 'vite-plugin-cesium';

/** Documents built by default: the globe and the local-voice companion page. */
export const BROWSER_PAGES = Object.freeze({
  main: 'index.html',
  remote: 'remote.html',
});

/** Build browser assets with explicit inputs; never load environment or providers. */
export function createBrowserViteConfig({
  plugins = [],
  publicDir,
  googleApiKey,
  cesiumToken,
  aiProvider,
  host = 'localhost',
  port = 4173,
  // Pass null/false to keep Vite's single index.html default.
  inputs = BROWSER_PAGES,
} = {}) {
  return {
    plugins: [cesium(), applicationHtmlPlugin(), ...plugins],
    ...(publicDir === undefined ? {} : { publicDir }),
    server: {
      host: host || 'localhost',
      port: parseInt(port, 10) || 4173,
      allowedHosts:
        host === '0.0.0.0' || host === '::'
          ? true
          : ['localhost', '127.0.0.1', '.local'],
      fs: {
        deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/ENVIRONMENT'],
      },
      // These headers protect the document containing Provider Settings.
      headers: {
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "frame-ancestors 'none'",
      },
    },
    define: {
      'import.meta.env.GOOGLE_MAPS_API_KEY': JSON.stringify(googleApiKey),
      'import.meta.env.CESIUM_ION_TOKEN': JSON.stringify(cesiumToken),
      ...(aiProvider
        ? { 'import.meta.env.GEV_AI_PROVIDER': JSON.stringify(aiProvider) }
        : {}),
    },
    build: {
      chunkSizeWarningLimit: 1500,
      ...(inputs ? { rollupOptions: { input: { ...inputs } } } : {}),
    },
  };
}
