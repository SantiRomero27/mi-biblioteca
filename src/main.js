import '@fontsource-variable/archivo/wdth.css'
import '@fontsource-variable/archivo/wdth-italic.css'
import './styles/app.css'
import './styles/pdf-text-layer.css'
import { renderLibrary } from './library.js'
import { renderReader } from './reader/reader-view.js'
import { initSync } from './sync.js'

const root = document.getElementById('app')
let cleanup = null

// Rutas: #/ → biblioteca · #/leer/<id>[?nota=<id>] → lector
async function route() {
  if (cleanup) { const c = cleanup; cleanup = null; await c() }
  const m = location.hash.match(/^#\/leer\/([a-f0-9]+)(?:\?nota=([\w-]+))?/)
  if (m) {
    cleanup = await renderReader(root, m[1], { annId: m[2] ?? null, onExit: () => { location.hash = '#/' } })
  } else {
    cleanup = await renderLibrary(root, {
      openBook: (id, annId) => { location.hash = `#/leer/${id}${annId ? `?nota=${annId}` : ''}` },
    })
  }
}

window.addEventListener('hashchange', route)
initSync()
route()

// Pedir almacenamiento persistente para que el navegador no borre los libros
navigator.storage?.persist?.()

// Funcionamiento offline en la web (en la app Android los archivos ya vienen dentro)
if (import.meta.env.PROD && 'serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {})
}
