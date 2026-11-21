// Service worker: deja la web app disponible sin conexión.
// Páginas: primero la red, si falla la copia guardada. Archivos con hash (JS, CSS, fuentes): primero la copia.
const CACHE = 'mi-biblioteca-v1'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k)
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', e => {
  const req = e.request
  const url = new URL(req.url)
  if (req.method !== 'GET' || url.origin !== location.origin) return

  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = await fetch(req)
        const c = await caches.open(CACHE)
        c.put('./', res.clone())
        return res
      } catch {
        return (await caches.match('./')) ?? Response.error()
      }
    })())
    return
  }

  e.respondWith((async () => {
    const cached = await caches.match(req)
    if (cached) return cached
    const res = await fetch(req)
    if (res.ok && url.pathname.includes('/assets/')) {
      const c = await caches.open(CACHE)
      c.put(req, res.clone())
    }
    return res
  })())
})
