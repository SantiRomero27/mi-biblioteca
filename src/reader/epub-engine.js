// Lector EPUB sobre foliate-js. Posiciones y subrayados con EPUB CFI (estándar),
// así un subrayado hecho en el celu cae exactamente en el mismo lugar en la web.
import '../vendor/foliate/view.js'
import { Overlayer } from '../vendor/foliate/overlayer.js'
import { COLORS } from '../books.js'
import { THEMES, listCustomFonts } from '../settings.js'
import archivoLatin from '@fontsource-variable/archivo/files/archivo-latin-wdth-normal.woff2?url'
import archivoLatinExt from '@fontsource-variable/archivo/files/archivo-latin-ext-wdth-normal.woff2?url'
import archivoLatinItalic from '@fontsource-variable/archivo/files/archivo-latin-wdth-italic.woff2?url'
import lato400 from '@fontsource/lato/files/lato-latin-400-normal.woff2?url'
import lato400i from '@fontsource/lato/files/lato-latin-400-italic.woff2?url'
import lato700 from '@fontsource/lato/files/lato-latin-700-normal.woff2?url'
import lato700i from '@fontsource/lato/files/lato-latin-700-italic.woff2?url'
import lato400ext from '@fontsource/lato/files/lato-latin-ext-400-normal.woff2?url'
import lato700ext from '@fontsource/lato/files/lato-latin-ext-700-normal.woff2?url'

const abs = u => new URL(u, location.href).href

const LINE_WIDTH = { estrecho: 560, medio: 680, ancho: 820 }

async function buildCSS(s) {
  const t = THEMES[s.theme] ?? THEMES.claro
  const custom = s.font.startsWith('custom:') ? s.font.slice(7) : null
  let customFace = ''
  if (custom) {
    const f = (await listCustomFonts()).find(x => x.name === custom)
    if (f) customFace = `@font-face { font-family: "Propia ${custom}"; src: url("${URL.createObjectURL(f.blob)}"); font-display: swap; }`
  }
  const family = s.font === 'original' ? null
    : custom ? `"Propia ${custom}", "Archivo Variable", sans-serif`
    : s.font === 'lato' ? `"Lato", sans-serif`
    : `"Archivo Variable", sans-serif`
  const LATIN = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'
  const latoFace = (w, st, url, range) =>
    `@font-face { font-family: "Lato"; font-style: ${st}; font-weight: ${w}; src: url("${abs(url)}") format("woff2");${range ? ` unicode-range: ${range};` : ''} }`
  const latoFaces = s.font === 'lato' ? [
    latoFace(400, 'normal', lato400, LATIN), latoFace(400, 'normal', lato400ext, 'U+0100-02BA,U+1E00-1EFF'),
    latoFace(700, 'normal', lato700, LATIN), latoFace(700, 'normal', lato700ext, 'U+0100-02BA,U+1E00-1EFF'),
    latoFace(400, 'italic', lato400i), latoFace(700, 'italic', lato700i),
  ].join('\n') : ''
  return `
    @namespace epub "http://www.idpf.org/2007/ops";
    @font-face { font-family: "Archivo Variable"; font-style: normal; font-weight: 100 900; font-stretch: 62% 125%;
      src: url("${abs(archivoLatin)}") format("woff2-variations");
      unicode-range: U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD; }
    @font-face { font-family: "Archivo Variable"; font-style: normal; font-weight: 100 900; font-stretch: 62% 125%;
      src: url("${abs(archivoLatinExt)}") format("woff2-variations");
      unicode-range: U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF; }
    @font-face { font-family: "Archivo Variable"; font-style: italic; font-weight: 100 900; font-stretch: 62% 125%;
      src: url("${abs(archivoLatinItalic)}") format("woff2-variations"); }
    ${customFace}
    ${latoFaces}
    html {
      color-scheme: ${s.theme === 'oscuro' || s.theme === 'noche' ? 'dark' : 'light'};
      background: ${t.bg} !important;
      color: ${t.fg} !important;
      font-size: ${s.fontSize}px !important;
    }
    body {
      background: transparent !important;
      color: inherit !important;
      font-size: 1rem !important;
      ${family ? `font-family: ${family} !important;` : ''}
      font-weight: ${s.weight};
      font-stretch: ${s.stretch}%;
    }
    ${family ? `body *:not(code):not(pre):not(kbd):not(samp) { font-family: inherit !important; }` : ''}
    body * { color: inherit !important; background-color: transparent !important; }
    p, li, blockquote, dd, div {
      line-height: ${s.lineHeight} !important;
      text-align: ${s.justify ? 'justify' : 'start'};
      hyphens: auto; -webkit-hyphens: auto;
      widows: 2; orphans: 2;
    }
    [align="center"], .center, h1, h2, h3, h4, h5, h6 { text-align: center; }
    h1, h2, h3, h4, h5, h6 { line-height: 1.25 !important; font-weight: ${Math.min(900, s.weight + 300)}; }
    a:link, a:visited { color: ${s.theme === 'oscuro' || s.theme === 'noche' ? '#8cc7d6' : '#1d6577'} !important; }
    img, svg, video { max-width: 100%; ${s.theme === 'noche' ? 'opacity: .85;' : ''} }
    pre { white-space: pre-wrap !important; }
    ::selection { background: rgba(232, 163, 61, .38); }
    aside[epub|type~="footnote"], aside[epub|type~="endnote"], aside[epub|type~="rearnote"] { display: none; }
  `
}

const flattenToc = (items = []) => items.map(it => ({
  label: (it.label ?? '').trim(),
  target: it.href,
  subitems: flattenToc(it.subitems ?? []),
}))

export async function createEpubEngine({ host, file, settings, initialLocator, onRelocate, onSelection, onAnnotationClick, onTap }) {
  const view = document.createElement('foliate-view')
  view.className = 'epub-view'
  host.append(view)
  await view.open(file)

  const byValue = new Map() // cfi → anotación
  const docs = new Map() // index → document
  let current = null
  let lastAnnClick = 0

  // ---------- Subrayados ----------
  view.addEventListener('create-overlay', e => {
    const { index } = e.detail
    for (const ann of byValue.values()) {
      try {
        if (view.resolveNavigation(ann.locator.cfi)?.index === index) view.addAnnotation({ value: ann.locator.cfi })
      } catch { /* cfi inválido */ }
    }
  })
  view.addEventListener('draw-annotation', e => {
    const { draw, annotation } = e.detail
    const ann = byValue.get(annotation.value)
    const color = COLORS[ann?.color] ?? COLORS.amarillo
    draw(Overlayer.highlight, { color })
    if (ann?.note) draw(Overlayer.underline, { color, width: 2 })
  })
  view.addEventListener('show-annotation', e => {
    const ann = byValue.get(e.detail.value)
    if (!ann) return
    lastAnnClick = Date.now()
    const { range, index } = e.detail
    const doc = docs.get(index)
    const fr = doc?.defaultView?.frameElement?.getBoundingClientRect()
    const r = range.getBoundingClientRect()
    onAnnotationClick?.(ann.id, fr ? offsetRect(r, fr) : r)
  })

  function setAnnotations(list) {
    for (const ann of byValue.values()) view.deleteAnnotation({ value: ann.locator.cfi }).catch(() => {})
    byValue.clear()
    for (const a of list) if (a.kind === 'highlight' && a.locator?.cfi) byValue.set(a.locator.cfi, a)
    for (const a of byValue.values()) view.addAnnotation({ value: a.locator.cfi }).catch(() => {})
  }
  function upsertHighlight(ann) {
    const cfi = ann.locator?.cfi
    if (!cfi) return
    if (ann.deleted) {
      byValue.delete(cfi)
      view.deleteAnnotation({ value: cfi }).catch(() => {})
    } else {
      byValue.set(cfi, ann)
      view.addAnnotation({ value: cfi }).catch(() => {})
    }
  }

  // ---------- Selección y toques ----------
  const offsetRect = (r, fr) => ({
    left: r.left + fr.left, right: r.right + fr.left,
    top: r.top + fr.top, bottom: r.bottom + fr.top,
    width: r.width, height: r.height,
  })

  view.addEventListener('load', e => {
    const { doc, index } = e.detail
    docs.set(index, doc)
    let selTimer
    doc.addEventListener('selectionchange', () => {
      clearTimeout(selTimer)
      selTimer = setTimeout(() => {
        const sel = doc.getSelection()
        if (!sel || sel.isCollapsed || !sel.rangeCount) return onSelection?.(null)
        const range = sel.getRangeAt(0)
        const text = sel.toString().replace(/\s+/g, ' ').trim()
        if (!text) return onSelection?.(null)
        const fr = doc.defaultView.frameElement.getBoundingClientRect()
        const cfi = view.getCFI(index, range)
        onSelection?.({
          text,
          rect: offsetRect(range.getBoundingClientRect(), fr),
          locator: { cfi },
          fraction: current?.fraction ?? 0,
          label: current?.label ?? '',
        })
      }, 250)
    })
    doc.addEventListener('click', ev => {
      if (ev.target.closest?.('a[href]')) return
      const sel = doc.getSelection()
      if (sel && !sel.isCollapsed) return
      const fr = doc.defaultView.frameElement.getBoundingClientRect()
      const x = ev.clientX + fr.left
      setTimeout(() => { if (Date.now() - lastAnnClick > 300) onTap?.(x / window.innerWidth) }, 0)
    })
    doc.addEventListener('keydown', ev => host.dispatchEvent(new KeyboardEvent('keydown', ev)))
  })

  // ---------- Posición ----------
  view.addEventListener('relocate', e => {
    const { fraction, tocItem, pageItem, cfi } = e.detail
    current = {
      fraction: fraction ?? 0,
      locator: { cfi },
      label: tocItem?.label?.trim() ?? '',
      pageLabel: pageItem?.label ? `pág. ${pageItem.label}` : `${Math.round((fraction ?? 0) * 100)} %`,
    }
    onRelocate?.(current)
  })

  // ---------- Ajustes ----------
  async function applySettings(s) {
    host.dataset.theme = s.theme
    const r = view.renderer
    r.setAttribute('flow', s.flow)
    r.setAttribute('max-inline-size', `${LINE_WIDTH[s.lineWidth] ?? 680}px`)
    r.setAttribute('max-column-count', s.columns === 2 ? '2' : '1')
    r.setAttribute('gap', '6%')
    r.setAttribute('margin', '44px')
    r.setStyles?.(await buildCSS(s))
  }
  await applySettings(settings)

  await view.init({ lastLocation: initialLocator?.cfi ?? null, showTextStart: !initialLocator?.cfi })

  const toc = flattenToc(view.book.toc ?? [])

  return {
    format: 'epub',
    toc,
    goTo: t => view.goTo(typeof t === 'string' ? t : t?.cfi),
    goToFraction: f => view.goToFraction(f),
    next: () => view.goRight(),
    prev: () => view.goLeft(),
    currentLocator: () => current,
    setAnnotations,
    upsertHighlight,
    clearSelection: () => { for (const d of docs.values()) d.getSelection?.()?.removeAllRanges() },
    applySettings,
    destroy() {
      view.close?.()
      view.book?.destroy?.()
      view.remove()
    },
  }
}
