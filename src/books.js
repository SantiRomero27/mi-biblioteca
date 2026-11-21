// Lógica de la biblioteca: importar libros, progreso, anotaciones.
import { db } from './db.js'

// ---------- Huella del archivo ----------
// El ID de cada libro sale de su contenido, no del nombre: tamaño + primeros y últimos 2 MB.
// Así el mismo archivo en el celu y en la PC da el mismo ID aunque esté renombrado o en otra carpeta.
const CHUNK = 2 * 1024 * 1024
export async function fingerprint(file) {
  const head = await file.slice(0, CHUNK).arrayBuffer()
  const tail = file.size > CHUNK ? await file.slice(Math.max(CHUNK, file.size - CHUNK)).arrayBuffer() : new ArrayBuffer(0)
  const size = new TextEncoder().encode(String(file.size) + ':')
  const all = new Uint8Array(size.byteLength + head.byteLength + tail.byteLength)
  all.set(size, 0)
  all.set(new Uint8Array(head), size.byteLength)
  all.set(new Uint8Array(tail), size.byteLength + head.byteLength)
  const hash = await crypto.subtle.digest('SHA-256', all)
  return Array.from(new Uint8Array(hash).slice(0, 16), b => b.toString(16).padStart(2, '0')).join('')
}

export const formatOf = file => {
  const name = (file.name || '').toLowerCase()
  if (name.endsWith('.pdf') || file.type === 'application/pdf') return 'pdf'
  if (name.endsWith('.epub') || file.type === 'application/epub+zip') return 'epub'
  return null
}

const now = () => Date.now()

// ---------- Metadatos ----------
const textOf = x => {
  if (!x) return ''
  if (typeof x === 'string') return x
  if (Array.isArray(x)) return x.map(textOf).filter(Boolean).join(', ')
  if (x.name) return textOf(x.name)
  const k = Object.keys(x)[0]
  return k ? textOf(x[k]) : ''
}

async function readEpubMeta(file) {
  const { makeBook } = await import('./vendor/foliate/view.js')
  const book = await makeBook(file)
  const title = textOf(book.metadata?.title)
  const author = textOf(book.metadata?.author)
  let cover = null
  try { cover = await book.getCover?.() } catch { /* sin portada */ }
  book.destroy?.()
  return { title, author, cover: cover ? await shrinkCover(cover) : null }
}

async function readPdfMeta(file) {
  const { loadPdf, closePdf } = await import('./reader/pdfjs.js')
  const pdf = await loadPdf(file)
  const { info } = (await pdf.getMetadata().catch(() => null)) ?? {}
  const page = await pdf.getPage(1)
  const vp = page.getViewport({ scale: 1 })
  const scale = 360 / vp.width
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(viewport.width)
  canvas.height = Math.round(viewport.height)
  await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise
  const cover = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.82))
  const pages = pdf.numPages
  await closePdf(pdf)
  return { title: info?.Title?.trim() || '', author: info?.Author?.trim() || '', cover, pages }
}

// Reduce portadas grandes para no llenar el almacenamiento
async function shrinkCover(blob) {
  try {
    const bmp = await createImageBitmap(blob)
    const w = 360, h = Math.round(bmp.height * (w / bmp.width))
    if (bmp.width <= w) return blob
    const c = document.createElement('canvas')
    c.width = w; c.height = h
    c.getContext('2d').drawImage(bmp, 0, 0, w, h)
    return await new Promise(r => c.toBlob(r, 'image/jpeg', 0.82))
  } catch {
    return blob
  }
}

const cleanName = name => name.replace(/\.(pdf|epub)$/i, '').replace(/[_]+/g, ' ').trim()

// ---------- Importar ----------
// Devuelve { book, status: 'nuevo' | 'vinculado' | 'existente' }
export async function importFile(file) {
  const format = formatOf(file)
  if (!format) throw new Error(`Formato no soportado: ${file.name}`)
  const id = await fingerprint(file)
  const existing = await db.get('books', id)
  const hasFile = await db.get('files', id)

  if (existing && hasFile) return { book: existing, status: 'existente' }

  const meta = format === 'epub' ? await readEpubMeta(file) : await readPdfMeta(file)
  await db.put('files', { id, blob: file, name: file.name })

  if (existing) {
    // El libro ya estaba en la cuenta (vino de otro dispositivo): solo le sumamos el archivo y la portada
    const book = { ...existing, cover: meta.cover ?? existing.cover ?? null }
    await db.put('books', book, 'remote') // la portada es local; no hace falta subir nada
    return { book, status: 'vinculado' }
  }

  const book = {
    id,
    format,
    title: meta.title || cleanName(file.name),
    author: meta.author || '',
    fileName: file.name,
    size: file.size,
    pages: meta.pages ?? null,
    cover: meta.cover ?? null,
    favorite: false,
    finished: false,
    progress: { fraction: 0, locator: null, label: '' },
    addedAt: now(),
    lastOpenedAt: null,
    updatedAt: now(),
    deleted: false,
    _dirty: true,
  }
  await db.put('books', book)
  return { book, status: 'nuevo' }
}

export async function listBooks() {
  const [books, files] = await Promise.all([db.all('books'), db.all('files')])
  const local = new Set(files.map(f => f.id))
  return books
    .filter(b => !b.deleted)
    .map(b => ({ ...b, hasFile: local.has(b.id) }))
}

export const getBook = id => db.get('books', id)
export const getFile = id => db.get('files', id)

export async function updateBook(id, patch) {
  const book = await db.get('books', id)
  if (!book) return null
  const next = { ...book, ...patch, updatedAt: now(), _dirty: true }
  await db.put('books', next)
  return next
}

// Borra de la cuenta (marca deleted para que se propague) y el archivo local
export async function deleteBook(id) {
  await updateBook(id, { deleted: true })
  await db.del('files', id)
  const anns = await db.byIndex('annotations', 'bookId', id)
  for (const a of anns) await db.put('annotations', { ...a, deleted: true, updatedAt: now(), _dirty: true })
}

// Solo quita el archivo de este dispositivo; notas y progreso quedan en la cuenta
export const removeLocalFile = id => db.del('files', id)

// ---------- Anotaciones ----------
// kind: 'highlight' (subrayado, con o sin nota) | 'bookmark' (marcador)
// locator: EPUB → { cfi } · PDF → { page, rects: [{ p, x, y, w, h }] } (coordenadas 0–1 de la página)
export async function listAnnotations(bookId) {
  const all = bookId ? await db.byIndex('annotations', 'bookId', bookId) : await db.all('annotations')
  return all.filter(a => !a.deleted).sort((a, b) => (a.fraction ?? 0) - (b.fraction ?? 0) || a.createdAt - b.createdAt)
}

export async function addAnnotation(data) {
  const ann = {
    id: crypto.randomUUID(),
    kind: 'highlight',
    color: 'amarillo',
    text: '',
    note: '',
    label: '',
    fraction: 0,
    createdAt: now(),
    updatedAt: now(),
    deleted: false,
    _dirty: true,
    ...data,
  }
  await db.put('annotations', ann)
  return ann
}

export async function updateAnnotation(id, patch) {
  const ann = await db.get('annotations', id)
  if (!ann) return null
  const next = { ...ann, ...patch, updatedAt: now(), _dirty: true }
  await db.put('annotations', next)
  return next
}

export const removeAnnotation = id => updateAnnotation(id, { deleted: true })

export const COLORS = {
  amarillo: '#f5c84c',
  verde: '#8fd17a',
  celeste: '#7cc4ef',
  rosa: '#f29bb8',
}

export const formatSize = bytes => {
  if (!bytes) return ''
  const mb = bytes / (1024 * 1024)
  return mb >= 1 ? `${mb.toFixed(1).replace('.', ',')} MB` : `${Math.round(bytes / 1024)} KB`
}
