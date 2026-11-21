import '@fontsource/lato/300.css'
import '@fontsource/lato/400.css'
import '@fontsource/lato/400-italic.css'
import '@fontsource/lato/700.css'
import '@fontsource/lato/900.css'
import './styles/app.css'
import './styles/pdf-text-layer.css'
import { renderLibrary } from './library.js'
import { renderReader } from './reader/reader-view.js'
import { initSync } from './sync.js'
import { isNative, setOrientation } from './native.js'
import { loadSettings } from './settings.js'

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

if (isNative) document.documentElement.classList.add('is-native')
window.addEventListener('hashchange', route)
initSync()
route()
loadSettings().then(s => { if (s.orientation && s.orientation !== 'auto') setOrientation(s.orientation) })

// Pedir almacenamiento persistente para que el navegador no borre los libros
navigator.storage?.persist?.()

// Funcionamiento offline en la web (en la app Android los archivos ya vienen dentro)
if (import.meta.env.PROD && !isNative && 'serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {})
}
