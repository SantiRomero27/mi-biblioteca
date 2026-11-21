// Migración desde ReadEra: lee su copia de seguridad (.bak) y pasa progreso, citas, marcadores,
// favoritos y "leídos" a Mi biblioteca.
//
// (doc_to_read_time > 0 → "Por leer")
// Formato de ReadEra (.bak = ZIP): docs_N.json → [{ uri: "sha-1:<sha1 del archivo>", data: {...}, citations, bookmarks }]
//   data.doc_sha1 / doc_file_size       → identifican el archivo (SHA-1 del archivo completo)
//   data.doc_position (JSON)            → { ratio, page (desde 0), pagesCount, offsetY }
//   citations[].note_body / note_extra  → texto citado / nota del usuario
//   citations[].note_data (JSON)        → { page, pageEnd, xPath "...@x:y", xPathEnd } (coordenadas 0–1)
//   data.doc_have_read_time > 0         → leído · data.doc_favorites_time > 0 → favorito
//
// Como ReadEra identifica los libros con el SHA-1 del archivo completo y Mi biblioteca usa su propia huella,
// los datos quedan "pendientes" hasta que el mismo archivo esté en la biblioteca; ahí se aplican solos.
import { db, kv } from './db.js'
import { getBook, updateBook, addAnnotation, listAnnotations, loadFileBlob } from './books.js'

const PENDING_KEY = 'readera-pendientes'
const COLOR_BY_MARK = ['amarillo', 'rosa', 'celeste', 'verde', 'amarillo']

const parseJSON = s => { try { return typeof s === 'string' ? JSON.parse(s) : (s ?? {}) } catch { return {} } }

// ---------- Leer el .bak ----------
export async function readBackup(file) {
  const { configure, ZipReader, BlobReader, TextWriter } = await import('./vendor/foliate/vendor/zip.js')
  configure({ useWebWorkers: false })
  const reader = new ZipReader(new BlobReader(file))
  const entries = await reader.getEntries()
  const docFiles = entries.filter(e => /(^|\/)(docs_\d+|library)\.json$/i.test(e.filename))
  if (!docFiles.length) throw new Error('No parece una copia de seguridad de ReadEra')
  let docs = []
  for (const e of docFiles) {
    const json = JSON.parse(await e.getData(new TextWriter()))
    docs = docs.concat(Array.isArray(json) ? json : json.docs ?? [])
  }
  await reader.close()

  const out = []
  for (const d of docs) {
    const data = d.data ?? {}
    if (data.doc_delete_time > 0 || data.doc_active === 0) continue
    const sha1 = (data.doc_sha1 || String(d.uri || '').replace(/^sha-1:/, '')).toLowerCase()
    if (!sha1) continue
    const format = String(data.doc_format || '').toLowerCase()
    if (format !== 'pdf' && format !== 'epub') continue
    const pos = parseJSON(data.doc_position)
    out.push({
      sha1,
      size: data.doc_file_size ?? null,
      format,
      title: data.user_title || data.doc_file_name_title || data.doc_title || '',
      userTitle: data.user_title || '',
      position: pos.ratio >= 0 ? { ratio: pos.ratio, page: pos.page, pagesCount: pos.pagesCount, offsetY: pos.offsetY } : null,
      lastRead: data.doc_last_read_time || 0,
      finished: data.doc_have_read_time > 0,
      favorite: data.doc_favorites_time > 0,
      toRead: data.doc_to_read_time > 0,
      citations: (d.citations ?? []).map(c => ({
        id: c.note_uri,
        text: c.note_body || '',
        note: c.note_extra || '',
        color: COLOR_BY_MARK[c.note_mark ?? 0] ?? 'amarillo',
        page: c.note_page ?? parseJSON(c.note_data).page ?? 0,
        data: parseJSON(c.note_data),
        index: c.note_index ?? null,
        createdAt: c.note_insert_time || Date.now(),
      })),
      bookmarks: (d.bookmarks ?? []).map(b => ({
        id: b.note_uri,
        page: b.note_page ?? parseJSON(b.note_data).page ?? 0,
        data: parseJSON(b.note_data),
        createdAt: b.note_insert_time || Date.now(),
      })),
    })
  }
  return out
}

// ---------- Pendientes ----------
export const listPending = () => kv.get(PENDING_KEY, [])
const savePending = list => kv.set(PENDING_KEY, list)

async function sha1Hex(blob) {
  const hash = await crypto.subtle.digest('SHA-1', await blob.arrayBuffer())
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('')
}

// Importa la copia: guarda los datos como pendientes y aplica los de los libros que ya están en la biblioteca
export async function importBackup(file, onProgress) {
  const docs = await readBackup(file)
  const pending = new Map((await listPending()).map(p => [p.sha1, p]))
  for (const d of docs) pending.set(d.sha1, d)
  await savePending([...pending.values()])

  const stats = { books: docs.length, applied: 0, placed: 0, unplaced: 0, bookmarks: 0 }
  const books = (await db.all('books')).filter(b => !b.deleted)
  const files = new Map((await db.all('files')).map(f => [f.id, f]))
  const candidates = books.filter(b => files.has(b.id) && [...pending.values()].some(p => !p.size || p.size === b.size))
  let i = 0
  for (const b of candidates) {
    onProgress?.(++i, candidates.length, b.title)
    const r = await applyPendingFor(b.id).catch(e => { console.error(e); return null })
    if (r) { stats.applied++; stats.placed += r.placed; stats.unplaced += r.unplaced; stats.bookmarks += r.bookmarks }
  }
  stats.pending = (await listPending()).length
  return stats
}

// Se llama al agregar o vincular un libro: si hay datos de ReadEra para ese archivo, se aplican
export async function applyPendingFor(bookId) {
  const pending = await listPending()
  if (!pending.length) return null
  const book = await getBook(bookId)
  const row = await db.get('files', bookId)
  if (!book || !row) return null
  const sameSize = pending.filter(p => !p.size || p.size === book.size)
  if (!sameSize.length) return null
  const file = await loadFileBlob(row)
  const sha1 = await sha1Hex(file)
  const entry = sameSize.find(p => p.sha1 === sha1)
  if (!entry) return null
  const result = await applyEntry(book, file, entry)
  await savePending((await listPending()).filter(p => p.sha1 !== sha1))
  return result
}

// ---------- Aplicar a un libro ----------
async function applyEntry(book, file, entry) {
  const result = { placed: 0, unplaced: 0, bookmarks: 0 }
  const existing = await listAnnotations(book.id)
  const done = new Set(existing.map(a => a.source).filter(Boolean))

  let pdf = null, pageCount = book.pages || entry.position?.pagesCount || 0, labels = null
  if (book.format === 'pdf') {
    const { loadPdf } = await import('./reader/pdfjs.js')
    pdf = await loadPdf(file)
    pageCount = pdf.numPages
    labels = await outlineLabels(pdf)
  }
  const labelFor = page => {
    if (!labels) return ''
    let l = ''
    for (const x of labels) { if (x.page <= page) l = x.label; else break }
    return l
  }

  // Estado y progreso (no pisa un progreso más reciente hecho acá)
  const patch = {}
  if (entry.userTitle && entry.userTitle !== book.title) patch.title = entry.userTitle // nombre que le pusiste en ReadEra
  if (entry.finished && !book.finished) patch.finished = true
  if (entry.favorite && !book.favorite) patch.favorite = true
  if (entry.toRead && !entry.finished && !book.toRead && !book.finished) patch.toRead = true
  if (entry.position && (!(book.progress?.fraction > 0) || entry.lastRead > (book.lastOpenedAt ?? 0))) {
    if (book.format === 'pdf') {
      const page = Math.min(pageCount, (entry.position.page ?? 0) + 1)
      const offset = Math.min(0.99, Math.max(0, Number(entry.position.offsetY) || 0))
      patch.progress = { fraction: Number(((page - 1 + offset) / pageCount).toFixed(5)), locator: { page, offset }, label: labelFor(page) }
    } else {
      patch.progress = { fraction: entry.position.ratio, locator: { fraction: entry.position.ratio }, label: '' }
    }
    if (entry.lastRead) patch.lastOpenedAt = Math.max(book.lastOpenedAt ?? 0, entry.lastRead)
  }
  if (Object.keys(patch).length) await updateBook(book.id, patch)

  // Citas
  for (const c of entry.citations) {
    const source = `readera:${c.id}`
    if (done.has(source) || !c.text) continue
    let locator, fraction
    if (pdf) {
      const page = Math.min(pageCount, c.page + 1)
      const pageEnd = Math.min(pageCount, (c.data.pageEnd >= 0 ? c.data.pageEnd : c.page) + 1)
      const rects = await locateInPdf(pdf, c.text, page, Math.max(page, pageEnd)).catch(() => null)
      locator = { page, rects: rects ?? [] }
      fraction = (page - 1 + (rects?.[0]?.y ?? 0)) / pageCount
      if (rects?.length) result.placed++; else result.unplaced++
    } else {
      fraction = c.index ?? c.data.ratio ?? 0
      locator = { fraction }
      result.unplaced++
    }
    await addAnnotation({
      bookId: book.id, kind: 'highlight', color: c.color, text: c.text, note: c.note,
      locator, fraction, label: pdf ? labelFor(locator.page) : '',
      unplaced: !(locator.rects?.length), source, createdAt: c.createdAt,
    })
  }

  // Marcadores
  for (const m of entry.bookmarks) {
    const source = `readera:${m.id}`
    if (done.has(source)) continue
    if (pdf) {
      const page = Math.min(pageCount, m.page + 1)
      const offset = Math.min(0.99, Math.max(0, Number(m.data.offsetY) || 0))
      await addAnnotation({ bookId: book.id, kind: 'bookmark', locator: { page, offset }, fraction: (page - 1 + offset) / pageCount, label: labelFor(page), text: `${page} de ${pageCount}`, source, createdAt: m.createdAt })
    } else {
      const f = m.data.ratio ?? 0
      await addAnnotation({ bookId: book.id, kind: 'bookmark', locator: { fraction: f }, fraction: f, text: `${Math.round(f * 100)} %`, source, createdAt: m.createdAt })
    }
    result.bookmarks++
  }

  if (pdf) await (await import('./reader/pdfjs.js')).closePdf(pdf)
  return result
}

async function outlineLabels(pdf) {
  const out = []
  const walk = async items => {
    for (const it of items ?? []) {
      const label = (it.title ?? '').replace(/\s+/g, ' ').trim()
      try {
        const dest = typeof it.dest === 'string' ? await pdf.getDestination(it.dest) : it.dest
        if (label && dest) {
          const ref = dest[0]
          const idx = typeof ref === 'number' ? ref : await pdf.getPageIndex(ref)
          out.push({ label, page: idx + 1 })
        }
      } catch { /* destino roto */ }
      await walk(it.items)
    }
  }
  await walk(await pdf.getOutline().catch(() => null))
  return out.sort((a, b) => a.page - b.page)
}

// ---------- Ubicar una cita en el PDF ----------
// Busca el texto citado en las páginas indicadas por ReadEra y devuelve rectángulos 0–1 por línea,
// en el mismo formato que los subrayados hechos en la app.
const norm = s => s.normalize('NFKC').toLowerCase().replace(/[\s­\-‐‑–—]/g, '')

async function locateInPdf(pdf, text, pageFrom, pageTo) {
  const { pdfjsLib } = await import('./reader/pdfjs.js')
  const chars = [] // { p, item, off }
  const items = [] // por página: { p, vp, items }
  for (let p = pageFrom; p <= pageTo; p++) {
    const page = await pdf.getPage(p)
    const vp = page.getViewport({ scale: 1 })
    const content = await page.getTextContent()
    const list = content.items.filter(it => typeof it.str === 'string')
    items.push({ p, vp, list })
    list.forEach((it, idx) => {
      for (let k = 0; k < it.str.length; k++) {
        if (norm(it.str[k])) chars.push({ c: norm(it.str[k]), p, idx, off: k, len: it.str.length })
      }
    })
  }
  const hay = chars.map(x => x.c).join('')
  const needle = norm(text)
  if (needle.length < 4) return null

  let start = hay.indexOf(needle), end = start + needle.length
  if (start < 0) {
    // ReadEra a veces incluye números de página o encabezados al cruzar de página: se busca por los extremos
    const a = needle.slice(0, Math.min(40, needle.length >> 1))
    const b = needle.slice(-Math.min(40, needle.length >> 1))
    const s = hay.indexOf(a)
    const e = s >= 0 ? hay.indexOf(b, s + a.length) : -1
    if (s < 0 || e < 0 || e - s > needle.length * 1.6 + 60) return null
    start = s; end = e + b.length
  }

  // agrupar por (página, ítem) el tramo encontrado
  const segs = new Map()
  for (let i = start; i < end; i++) {
    const ch = chars[i]
    const key = `${ch.p}:${ch.idx}`
    const seg = segs.get(key)
    if (seg) seg.to = ch.off
    else segs.set(key, { p: ch.p, idx: ch.idx, from: ch.off, to: ch.off, len: ch.len })
  }
  const rects = []
  for (const seg of segs.values()) {
    const pg = items.find(x => x.p === seg.p)
    const it = pg.list[seg.idx]
    const tx = pdfjsLib.Util.transform(pg.vp.transform, it.transform)
    const h = Math.hypot(tx[2], tx[3])
    const w = it.width
    const x0 = tx[4] + w * (seg.from / seg.len)
    const x1 = tx[4] + w * ((seg.to + 1) / seg.len)
    const top = tx[5] - h * 0.95
    rects.push({ p: seg.p, x: x0 / pg.vp.width, y: top / pg.vp.height, w: (x1 - x0) / pg.vp.width, h: (h * 1.2) / pg.vp.height })
  }
  // unir por línea
  rects.sort((a, b) => a.p - b.p || a.y - b.y || a.x - b.x)
  const merged = []
  for (const r of rects) {
    const last = merged[merged.length - 1]
    if (last && last.p === r.p && Math.abs(last.y - r.y) < last.h * 0.5 && r.x <= last.x + last.w + last.h * 1.5) {
      const right = Math.max(last.x + last.w, r.x + r.w)
      last.x = Math.min(last.x, r.x); last.w = right - last.x
    } else merged.push({ ...r })
  }
  const round = v => Number(v.toFixed(5))
  return merged.filter(r => r.w > 0.002).map(r => ({ p: r.p, x: round(r.x), y: round(r.y), w: round(r.w), h: round(r.h) }))
}
