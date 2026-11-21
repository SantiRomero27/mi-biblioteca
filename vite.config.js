import { defineConfig } from 'vite'

// base relativa: funciona igual en GitHub Pages (/mi-biblioteca/) y dentro de la app Android (Capacitor)
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
  esbuild: { target: 'es2022' },
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
})
