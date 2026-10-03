import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// BASE is set by the GitHub Pages workflow ("/<repo>/"); "/" for local dev and custom domains.
const base = process.env.BASE ?? '/';

export default defineConfig({
  base,
  plugins: [
    preact(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'prompt',
      injectManifest: { globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'] },
      manifest: {
        name: 'GitVault',
        short_name: 'GitVault',
        description: 'GitHub に同期するオフライン Markdown ノート',
        lang: 'ja',
        start_url: base,
        scope: base,
        display: 'standalone',
        background_color: '#1e1e24',
        theme_color: '#1e1e24',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      devOptions: { enabled: true, type: 'module' },
    }),
  ],
});
