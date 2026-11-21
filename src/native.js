// Puente con la app Android (Capacitor). En la web todo esto queda inactivo.
import { Capacitor, registerPlugin } from '@capacitor/core'
import { db } from './db.js'
import { platform } from './platform.js'

export const isNative = Capacitor.isNativePlatform()
export const Biblioteca = isNative ? registerPlugin('Biblioteca') : null

if (isNative) {
  platform.isNative = true
  platform.deleteOriginal = async bookId => {
    const row = await db.get('files', bookId)
    if (!row?.uri) return false
    const { deleted } = await Biblioteca.deleteFile({ uri: row.uri })
    if (deleted) await db.del('files', bookId)
    return deleted
  }
}

// URL interna desde la que la app Android entrega el archivo, leyéndolo en su carpeta
export const bookUrl = uri => `${location.origin}/_book/${encodeURIComponent(uri)}`

export const listFolders = async () => (await Biblioteca.listFolders()).folders ?? []
export const pickFolder = () => Biblioteca.pickFolder()
export const removeFolder = uri => Biblioteca.removeFolder({ uri })

// Recorre las carpetas elegidas y actualiza la biblioteca:
//  - libros nuevos → se agregan
//  - libros que ya estaban en la cuenta (de otro dispositivo) → se vinculan con su archivo
//  - archivos que ya no están → el libro queda como "no está en este dispositivo"
let scanning = null
export function scanFolders(onProgress) {
  if (!isNative) return Promise.resolve({ added: 0, linked: 0, missing: 0 })
  if (scanning) return scanning
  scanning = (async () => {
    const { importFromFolder } = await import('./books.js')
    const folders = await listFolders()
    const found = new Map() // huella → archivo
    for (const f of folders) {
      try {
        const { files } = await Biblioteca.scan({ uri: f.uri })
        for (const file of files) if (!found.has(file.fingerprint)) found.set(file.fingerprint, file)
      } catch (e) { console.error(e) }
    }
    let added = 0, linked = 0, missing = 0, failed = 0, i = 0, firstError = ''
    for (const file of found.values()) {
      onProgress?.(++i, found.size, file.name)
      try {
        const status = await importFromFolder(file)
        if (status === 'nuevo') added++
        else if (status === 'vinculado') linked++
      } catch (e) {
        failed++
        firstError ||= `${file.name}: ${e?.message ?? e}`
        console.error('No se pudo leer', file.name, e)
      }
    }
    // archivos de carpetas que ya no aparecen
    for (const row of await db.all('files')) {
      if (row.uri && !found.has(row.id)) { await db.del('files', row.id); missing++ }
    }
    return { added, linked, missing, failed, firstError, total: found.size, folders: folders.length }
  })().finally(() => { scanning = null })
  return scanning
}

// Ingreso con Google nativo: Android entrega un idToken y Firebase lo canjea
export async function nativeGoogleToken(serverClientId) {
  const { idToken } = await Biblioteca.googleSignIn({ serverClientId })
  return idToken
}

// Orientación de pantalla: auto | vertical | horizontal
export async function setOrientation(mode) {
  if (isNative) return Biblioteca.setOrientation({ mode }).catch(() => {})
  try {
    if (mode === 'auto') screen.orientation?.unlock?.()
    else await screen.orientation?.lock?.(mode === 'vertical' ? 'portrait' : 'landscape')
  } catch { /* el navegador solo lo permite en pantalla completa */ }
}
