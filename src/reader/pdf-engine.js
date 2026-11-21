// Lector PDF propio sobre pdf.js: desplazamiento vertical continuo, capa de texto seleccionable,
// subrayados guardados como rectángulos relativos a la página (0–1), así se ven igual en cualquier pantalla o zoom.
import { loadPdf, closePdf, pdfjsLib } from './pdfjs.js'
import { COLORS } from '../books.js'

export async function createPdfEngine({ host, file, settings, initialLocator, onRelocate, onSelection, onAnnotationClick, onTap }) {
  const pdf = await loadPdf(file)
  const n = pdf.numPages
  const first = await pdf.getPage(1)
  const base = first.getViewport({ scale: 1 })

  const scroller = document.createElement('div')
  scroller.className = 'pdf-scroll'
  const column = document.createElement('div')
  column.className = 'pdf-pages'
  scroller.append(column)
  host.append(scroller)

  let zoom = settings.pdfZoom || 1
  let scale = 1
  const pages = [] // { el, canvas, text, hl, w, h, state, task, pageProxy }
  const annotations = new Map()

  for (let i = 0; i < n; i++) {
    const el = document.createElement('div')
    el.className = 'pdf-page'
    el.dataset.p = i + 1
    el.innerHTML = '<canvas></canvas><div class="textLayer"></div><div class="hl-layer"></div><span class="pdf-page-num"></span>'
    el.querySelector('.pdf-page-num').textContent = i + 1
    column.append(el)
    pages.push({
      el,
      canvas: el.querySelector('canvas'),
      text: el.querySelector('.textLayer'),
      hl: el.querySelector('.hl-layer'),
      w: base.width, h: base.height,
      state: 'empty', task: null, textTask: null,
    })
  }

  // ---------- Tamaños ----------
  function computeScale() {
    const avail = Math.min(scroller.clientWidth - 24, 980)
    scale = (avail / base.width) * zoom
  }
  function layout() {
    computeScale()
    for (const pg of pages) {
      pg.el.style.width = `${pg.w * scale}px`
      pg.el.style.height = `${pg.h * scale}px`
      pg.el.style.setProperty('--scale-factor', scale)
      pg.el.style.setProperty('--user-unit', 1)
      pg.el.style.setProperty('--total-scale-factor', scale)
    }
  }

  // ---------- Renderizado perezoso ----------
  async function renderPage(i) {
    const pg = pages[i]
    if (pg.state === 'rendering' || pg.state === `done@${scale}`) return
    pg.state = 'rendering'
    const myScale = scale
    try {
      const page = pg.proxy ?? (pg.proxy = await pdf.getPage(i + 1))
      const vp1 = page.getViewport({ scale: 1 })
      if (vp1.width !== pg.w || vp1.height !== pg.h) {
        pg.w = vp1.width; pg.h = vp1.height
        pg.el.style.width = `${pg.w * scale}px`
        pg.el.style.height = `${pg.h * scale}px`
      }
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const viewport = page.getViewport({ scale: myScale * dpr })
      const canvas = document.createElement('canvas')
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      pg.task?.cancel?.()
      pg.task = page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport })
      await pg.task.promise
      if (myScale !== scale) { pg.state = 'empty'; return renderPage(i) }
      pg.canvas.replaceWith(canvas)
      pg.canvas = canvas

      pg.text.replaceChildren()
      const tl = new pdfjsLib.TextLayer({
        textContentSource: page.streamTextContent(),
        container: pg.text,
        viewport: page.getViewport({ scale: myScale }),
      })
      pg.textTask = tl
      await tl.render()
      const end = document.createElement('div')
      end.className = 'endOfContent'
      pg.text.append(end)
      pg.state = `done@${myScale}`
      drawPage(i)
    } catch (e) {
      if (e?.name !== 'RenderingCancelledException') console.error(e)
      pg.state = 'empty'
    }
  }

  function releasePage(i) {
    const pg = pages[i]
    if (pg.state === 'empty') return
    pg.task?.cancel?.()
    pg.textTask?.cancel?.()
    const blank = document.createElement('canvas')
    pg.canvas.replaceWith(blank)
    pg.canvas = blank
    pg.text.replaceChildren()
    pg.state = 'empty'
  }

  const visible = new Set()
  const io = new IntersectionObserver(entries => {
    for (const e of entries) {
      const i = Number(e.target.dataset.p) - 1
      if (e.isIntersecting) { visible.add(i); renderPage(i) }
      else visible.delete(i)
    }
    // liberar memoria de páginas lejanas
    const cur = currentIndex()
    pages.forEach((_, i) => { if (Math.abs(i - cur) > 6 && !visible.has(i)) releasePage(i) })
  }, { root: scroller, rootMargin: '120% 0px' })

  layout()
  pages.forEach(pg => io.observe(pg.el))

  // ---------- Posición ----------
  function currentIndex() {
    const y = scroller.scrollTop + scroller.clientHeight * 0.25
    let lo = 0, hi = n - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (pages[mid].el.offsetTop <= y) lo = mid
      else hi = mid - 1
    }
    return lo
  }
  function currentLocator() {
    const i = currentIndex()
    const el = pages[i].el
    const offset = Math.min(1, Math.max(0, (scroller.scrollTop - el.offsetTop) / el.offsetHeight))
    return { page: i + 1, offset: Number(offset.toFixed(4)) }
  }

  // Índice (outline)
  const toc = []
  const flat = []
  async function resolveDest(dest) {
    try {
      const d = typeof dest === 'string' ? await pdf.getDestination(dest) : dest
      if (!d) return null
      const ref = d[0]
      const idx = typeof ref === 'number' ? ref : await pdf.getPageIndex(ref)
      return idx + 1
    } catch { return null }
  }
  async function buildToc(items, out, level) {
    for (const it of items ?? []) {
      const page = it.dest ? await resolveDest(it.dest) : null
      const node = { label: it.title, target: page ? { page, offset: 0 } : null, page, subitems: [] }
      out.push(node)
      if (page) flat.push({ label: it.title, page, level })
      await buildToc(it.items, node.subitems, level + 1)
    }
  }
  await buildToc(await pdf.getOutline().catch(() => null), toc, 0)
  flat.sort((a, b) => a.page - b.page)
  const sectionLabel = page => {
    let label = ''
    for (const f of flat) { if (f.page <= page) label = f.label; else break }
    return label
  }

  let relocTimer
  function report() {
    clearTimeout(relocTimer)
    relocTimer = setTimeout(() => {
      const loc = currentLocator()
      const fraction = n > 1 ? (loc.page - 1 + loc.offset) / n : loc.offset
      onRelocate?.({
        fraction: Math.min(1, fraction),
        locator: loc,
        label: sectionLabel(loc.page),
        pageLabel: `${loc.page} de ${n}`,
      })
    }, 120)
  }
  scroller.addEventListener('scroll', report, { passive: true })

  function goTo(locator) {
    if (!locator?.page) return
    const i = Math.min(n, Math.max(1, locator.page)) - 1
    const el = pages[i].el
    scroller.scrollTop = el.offsetTop + (locator.offset ?? 0) * el.offsetHeight - (locator.offset ? 0 : 8)
    report()
  }
  const goToFraction = f => {
    const x = Math.min(0.99999, Math.max(0, f)) * n
    goTo({ page: Math.floor(x) + 1, offset: x - Math.floor(x) })
  }

  // ---------- Subrayados ----------
  function drawPage(i) {
    const pg = pages[i]
    pg.hl.replaceChildren()
    for (const ann of annotations.values()) {
      if (ann.kind !== 'highlight') continue
      for (const r of ann.locator?.rects ?? []) {
        if (r.p !== i + 1) continue
        const d = document.createElement('div')
        d.className = 'hl'
        d.dataset.id = ann.id
        if (ann.note) d.classList.add('has-note')
        Object.assign(d.style, {
          left: `${r.x * 100}%`, top: `${r.y * 100}%`,
          width: `${r.w * 100}%`, height: `${r.h * 100}%`,
          background: COLORS[ann.color] ?? COLORS.amarillo,
        })
        pg.hl.append(d)
      }
    }
  }
  const pagesOf = ann => new Set((ann.locator?.rects ?? []).map(r => r.p - 1))

  function setAnnotations(list) {
    annotations.clear()
    for (const a of list) if (a.kind === 'highlight') annotations.set(a.id, a)
    pages.forEach((_, i) => drawPage(i))
  }
  function upsertHighlight(ann) {
    const old = annotations.get(ann.id)
    if (ann.deleted) annotations.delete(ann.id)
    else annotations.set(ann.id, ann)
    const touched = new Set([...(old ? pagesOf(old) : []), ...pagesOf(ann)])
    touched.forEach(drawPage)
  }

  // ---------- Selección ----------
  function selectionRects() {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null
    const range = sel.getRangeAt(0)
    if (!scroller.contains(range.commonAncestorContainer)) return null
    const text = sel.toString().replace(/\s+/g, ' ').trim()
    if (!text) return null
    const raw = Array.from(range.getClientRects()).filter(r => r.width > 1 && r.height > 1)
    if (!raw.length) return null
    const hs = raw.map(r => r.height).sort((a, b) => a - b)
    const median = hs[hs.length >> 1]
    const pageBoxes = pages.map(pg => pg.el.getBoundingClientRect())
    const out = []
    for (const r of raw) {
      if (r.height > median * 3) continue // descarta el bloque invisible de fin de contenido
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2
      const p = pageBoxes.findIndex(b => cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom)
      if (p < 0) continue
      const b = pageBoxes[p]
      out.push({ p: p + 1, x: (r.left - b.left) / b.width, y: (r.top - b.top) / b.height, w: r.width / b.width, h: r.height / b.height })
    }
    // une rectángulos de la misma línea
    out.sort((a, b) => a.p - b.p || a.y - b.y || a.x - b.x)
    const merged = []
    for (const r of out) {
      const last = merged[merged.length - 1]
      if (last && last.p === r.p && Math.abs(last.y - r.y) < last.h * 0.5 && r.x <= last.x + last.w + last.h * 1.2) {
        const right = Math.max(last.x + last.w, r.x + r.w)
        const top = Math.min(last.y, r.y), bottom = Math.max(last.y + last.h, r.y + r.h)
        last.x = Math.min(last.x, r.x); last.w = right - last.x
        last.y = top; last.h = bottom - top
      } else merged.push({ ...r })
    }
    const round = v => Number(v.toFixed(5))
    const rects = merged.map(r => ({ p: r.p, x: round(r.x), y: round(r.y), w: round(r.w), h: round(r.h) }))
    const box = range.getBoundingClientRect()
    const firstPage = rects[0]?.p ?? currentIndex() + 1
    const firstY = rects[0]?.y ?? 0
    return {
      text,
      rect: box,
      locator: { page: firstPage, rects },
      fraction: (firstPage - 1 + firstY) / n,
      label: sectionLabel(firstPage),
    }
  }

  let selTimer
  const checkSelection = () => {
    clearTimeout(selTimer)
    selTimer = setTimeout(() => onSelection?.(selectionRects()), 220)
  }
  document.addEventListener('selectionchange', checkSelection)

  let downAt = null
  scroller.addEventListener('pointerdown', e => { downAt = { x: e.clientX, y: e.clientY, t: Date.now() } })
  scroller.addEventListener('pointerup', e => {
    if (!downAt) return
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 8
    const long = Date.now() - downAt.t > 400
    downAt = null
    if (moved || long) return
    const sel = window.getSelection()
    if (sel && !sel.isCollapsed) return
    // ¿tocó un subrayado?
    const pageEl = e.target.closest?.('.pdf-page')
    if (pageEl) {
      const b = pageEl.getBoundingClientRect()
      const x = (e.clientX - b.left) / b.width, y = (e.clientY - b.top) / b.height
      const p = Number(pageEl.dataset.p)
      for (const ann of annotations.values()) {
        const hit = (ann.locator?.rects ?? []).some(r => r.p === p && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)
        if (hit) {
          const el = pageEl.querySelector(`.hl[data-id="${ann.id}"]`)
          onAnnotationClick?.(ann.id, el?.getBoundingClientRect() ?? { left: e.clientX, top: e.clientY, right: e.clientX, bottom: e.clientY, width: 0, height: 0 })
          return
        }
      }
    }
    onTap?.(e.clientX / window.innerWidth)
  })

  // ---------- Ajustes ----------
  function applySettings(s) {
    host.dataset.theme = s.theme
    if ((s.pdfZoom || 1) !== zoom) {
      const loc = currentLocator()
      zoom = s.pdfZoom || 1
      layout()
      pages.forEach((_, i) => { if (pages[i].state !== 'empty') pages[i].state = 'stale' })
      goTo(loc)
      visible.forEach(i => renderPage(i))
    }
  }
  applySettings(settings)

  const ro = new ResizeObserver(() => {
    const loc = currentLocator()
    const before = scale
    layout()
    if (Math.abs(before - scale) > 0.001) {
      goTo(loc)
      visible.forEach(i => { pages[i].state = 'stale'; renderPage(i) })
    }
  })
  ro.observe(scroller)

  // posición inicial
  requestAnimationFrame(() => {
    if (initialLocator?.page) goTo(initialLocator)
    else report()
  })

  return {
    format: 'pdf',
    toc,
    pageCount: n,
    goTo: t => goTo(t),
    goToFraction,
    next: () => scroller.scrollBy({ top: scroller.clientHeight * 0.9, behavior: 'smooth' }),
    prev: () => scroller.scrollBy({ top: -scroller.clientHeight * 0.9, behavior: 'smooth' }),
    currentLocator: () => {
      const loc = currentLocator()
      return { locator: loc, fraction: (loc.page - 1 + loc.offset) / n, label: sectionLabel(loc.page), pageLabel: `${loc.page} de ${n}` }
    },
    setAnnotations,
    upsertHighlight,
    clearSelection: () => window.getSelection()?.removeAllRanges(),
    applySettings,
    destroy() {
      io.disconnect(); ro.disconnect()
      document.removeEventListener('selectionchange', checkSelection)
      pages.forEach((_, i) => releasePage(i))
      scroller.remove()
      closePdf(pdf)
    },
  }
}
