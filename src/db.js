// IndexedDB escrito a mano, sin dependencias.
// Stores:
//   files        { id, blob, name }            → el archivo del libro (solo en este dispositivo)
//   books        { id, title, author, ... }     → metadatos + progreso (se sincroniza)
//   annotations  { id, bookId, kind, ... }      → subrayados, notas y marcadores (se sincroniza)
//   kv           { key, value }                 → ajustes y fuentes propias (local)

const DB_NAME = 'mi-biblioteca'
const VERSION = 1

let dbPromise

function openDB() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('annotations')) {
        const s = db.createObjectStore('annotations', { keyPath: 'id' })
        s.createIndex('bookId', 'bookId')
      }
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

const wrap = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result)
  req.onerror = () => reject(req.error)
})

async function tx(store, mode = 'readonly') {
  const db = await openDB()
  return db.transaction(store, mode).objectStore(store)
}

// Avisos de cambios: la UI y la sincronización escuchan acá
export const changes = new EventTarget()
const emit = (store, value, origin) =>
  changes.dispatchEvent(new CustomEvent('change', { detail: { store, value, origin } }))

export const db = {
  async get(store, key) {
    return wrap((await tx(store)).get(key))
  },
  async all(store) {
    return wrap((await tx(store)).getAll())
  },
  async byIndex(store, index, value) {
    return wrap((await tx(store)).index(index).getAll(value))
  },
  // origin: 'local' (cambio del usuario) | 'remote' (llegó de la nube)
  async put(store, value, origin = 'local') {
    await wrap((await tx(store, 'readwrite')).put(value))
    emit(store, value, origin)
    return value
  },
  async del(store, key) {
    await wrap((await tx(store, 'readwrite')).delete(key))
    emit(store, { id: key, _removed: true }, 'local')
  },
}

export const kv = {
  async get(key, fallback = null) {
    const row = await db.get('kv', key)
    return row ? row.value : fallback
  },
  set(key, value) {
    return db.put('kv', { key, value })
  },
}
