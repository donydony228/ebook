import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  // On GitHub Pages a project site lives under /<repo>/, so assets and the
  // service worker must be built with that base. The deploy workflow sets
  // BASE_PATH=/<repo>/; locally it defaults to '/'.
  base: process.env.BASE_PATH || '/',
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      // PDF.js worker is large; allow precaching bigger chunks so the
      // whole app shell works fully offline after the first visit.
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,wasm,mjs}'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
      },
      manifest: {
        name: '離線電子書閱讀器',
        short_name: '電子書',
        description: '上傳 PDF,離線閱讀,可重排文字、左右滑動換頁',
        theme_color: '#1a1a2e',
        background_color: '#1a1a2e',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '.',
        scope: '.',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
});
