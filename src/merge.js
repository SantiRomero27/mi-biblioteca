// Fusión de libros entre dispositivos, campo por campo.
//
// Antes se comparaba el libro entero por fecha: si el celu "descubría" un libro en su carpeta antes de
// recibir los datos de la nube, ese registro nuevo (sin estados ni progreso) era más reciente y pisaba
// todo. Ahora cada campo lleva su propia fecha (fieldTimes) y gana el último cambio HECHO POR VOS en ese
// campo. Un libro recién descubierto tiene fecha 0 en todo, así que nunca pisa lo que ya había.
export const BOOK_FIELDS = ['title', 'author', 'description', 'favorite', 'finished', 'toRead', 'progress', 'deleted']

const isDefault = (f, v) => {
  if (f === 'progress') return !v || !(v.fraction > 0)
  if (f === 'favorite' || f === 'finished' || f === 'toRead' || f === 'deleted') return !v
  if (f === 'description') return !v
  return false
}

// Fecha de un campo. Registros viejos (sin fieldTimes): los valores por defecto cuentan como "nunca tocados".
export function fieldTime(rec, f) {
  const t = rec?.fieldTimes?.[f]
  if (typeof t === 'number') return t
  if (rec?.fieldTimes) return 0
  if (f === 'title' || f === 'author') return 0
  return isDefault(f, rec?.[f]) ? 0 : (rec?.updatedAt ?? 0)
}

export function mergeBook(local, remote) {
  const out = { ...remote }
  const times = {}
  for (const f of BOOK_FIELDS) {
    const lt = fieldTime(local, f), rt = fieldTime(remote, f)
    if (lt > rt) { out[f] = local[f]; times[f] = lt }
    else { out[f] = remote[f]; times[f] = rt }
  }
  out.fieldTimes = times
  out.lastOpenedAt = Math.max(local.lastOpenedAt ?? 0, remote.lastOpenedAt ?? 0) || null
  out.addedAt = Math.min(local.addedAt ?? Infinity, remote.addedAt ?? Infinity)
  if (!Number.isFinite(out.addedAt)) out.addedAt = Date.now()
  out.pages = remote.pages ?? local.pages ?? null
  out.updatedAt = Math.max(local.updatedAt ?? 0, remote.updatedAt ?? 0)
  return out
}

const SKIP = new Set(['cover', '_dirty', 'hasFile', 'fileKind'])
export const sameBook = (a, b) => {
  const pick = r => JSON.stringify(Object.keys(r).filter(k => !SKIP.has(k)).sort().map(k => [k, r[k]]))
  return pick(a) === pick(b)
}
