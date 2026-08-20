import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // autoUpdate: a new deploy activates on the next load automatically —
      // no prompt, no stale bundle held by the old service worker. This is
      // essential for a frequently-deployed business app; 'prompt' previously
      // left users on an old cached JS bundle indefinitely (the "I deployed but
      // it's still showing the old version" problem).
      registerType: 'autoUpdate',
      // Custom service worker (injectManifest) so we can add Web Push handlers
      // for the QC notifications while keeping full offline precaching.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.js',
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,json,woff2}'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024
      },
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'ATL Flow',
        short_name: 'ATL Flow',
        description: 'Alpha Trade Links — sales, billing, delivery & quality control',
        theme_color: '#0735a5',
        background_color: '#0735a5',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'pwa-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      }
    })
  ]
})
