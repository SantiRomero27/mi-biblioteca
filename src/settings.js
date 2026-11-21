// Ajustes de lectura (por dispositivo: el celu y la PC pueden tener tamaños distintos)
import { kv } from './db.js'

export const DEFAULT_SETTINGS = {
  theme: 'claro',          // claro | sepia | oscuro | noche
  font: 'archivo',         // archivo | original | custom:<nombre>
  fontSize: 19,            // px (EPUB)
  weight: 400,             // eje wght de Archivo
  stretch: 100,            // eje wdth de Archivo (62–125)
  lineHeight: 1.55,
  justify: true,
  lineWidth: 'medio',      // estrecho | medio | ancho (largo de línea, EPUB)
  columns: 1,              // 1 | 2 (EPUB en pantallas anchas)
  flow: 'paginated',       // paginated | scrolled (EPUB)
  pdfZoom: 1,              // 1 = ajustar (al ancho en continuo, a la pantalla en páginas)
  pdfFlow: 'continuo',     // continuo (vertical) | paginas (horizontal, de a una)
  pdfSplit: 'auto',        // auto | siempre | nunca — escaneos con dos páginas por hoja
}

export const THEMES = {
  claro:  { bg: '#fbfaf7', fg: '#1f1d1a', muted: '#6d6860', label: 'Claro' },
  sepia:  { bg: '#f3e7cf', fg: '#3b2f22', muted: '#7d6a52', label: 'Sepia' },
  oscuro: { bg: '#1e2124', fg: '#d9d4cb', muted: '#8f8a82', label: 'Oscuro' },
  noche:  { bg: '#000000', fg: '#b9b2a6', muted: '#6f6a62', label: 'Noche' },
}

export async function loadSettings() {
  return { ...DEFAULT_SETTINGS, ...(await kv.get('reader-settings', {})) }
}
export const saveSettings = s => kv.set('reader-settings', s)

// ---------- Fuentes propias ----------
// Se guardan en el dispositivo (IndexedDB) y se usan en los EPUB.
export const listCustomFonts = () => kv.get('custom-fonts', [])

export async function addCustomFont(file) {
  const name = file.name.replace(/\.(ttf|otf|woff2?)$/i, '').replace(/[-_]+/g, ' ').trim()
  const fonts = await listCustomFonts()
  const next = fonts.filter(f => f.name !== name).concat({ name, blob: file })
  await kv.set('custom-fonts', next)
  return name
}

export async function removeCustomFont(name) {
  const fonts = await listCustomFonts()
  await kv.set('custom-fonts', fonts.filter(f => f.name !== name))
}
