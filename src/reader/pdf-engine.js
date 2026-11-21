// Lector PDF sobre pdf.js.
//
// · Dos modos: "continuo" (vertical, ajustado al ancho) y "paginas" (horizontal, una página por pantalla).
// · Páginas dobles: los escaneos con dos páginas del libro en una hoja se dividen en dos "páginas visibles".
//   Cada mitad muestra la hoja completa recortada, así subrayados y posiciones siguen guardándose en
//   coordenadas de la hoja real (0–1): no cambian si activás o desactivás la división.
// · Gestos: pellizcar para zoom, doble toque para acercar/alejar, Ctrl+rueda en la PC.
// · Subrayados: rectángulos relativos a la hoja, iguales en cualquier pantalla o zoom.
import { loadPdf, closePdf, pdfjsLib } from './pdfjs.js'
import { COLORS } from '../books.js'

const MAX_WIDTH = 980

export async function createPdfEngine(opts) {
  const { host, file, settings, initialLocator, onRelocate, onSelection, onAnnotationClick, onTap, onZoom, onLoading } = opts
  const pdf = await loadPdf(file)
  const n = pdf.numPages

  // ---------- Tamaño de cada hoja (para detectar páginas dobles) ----------
  const sizes = new Array(n)
  for (let i = 0; i < n; i += 24) {
    const batch = []
    for (let j = i; j < Math.min(n, i + 24); j++) {
      batch.push(pdf.getPage(j + 1).then(p => { const v = p.getViewport({ scale: 1 }); sizes[j] = { w: v.width, h: v.height } }))
    }
    await Promise.all(batch)
    onLoading?.(Math.min(n, i + 24) / n)
  }

  const isSpread = s => s.w / s.h > 1.15 && s.w / s.h < 1.65
  function planPages(mode) {
    const spreads = sizes.filter(isSpread).length
    const split = mode === 'siempre' ? s => s.w / s.h > 1.15
      : mode === 'nunca' ? () => false
      : spreads >= Math.max(2, n * 0.3) ? isSpread : () => false
    const out = []
    sizes.forEach((s, i) => {
      if (split(s)) {
        out.push({ real: i + 1, half: 0, fw: s.w, fh: s.h, w: s.w / 2, h: s.h })
        out.push({ real: i + 1, half: 1, fw: s.w, fh: s.h, w: s.w / 2, h: s.h })
      } else out.push({ real: i + 1, half: null, fw: s.w, fh: s.h, w: s.w, h: s.h })
    })
    return out
  }

  // ---------- DOM ----------
  const scroller = document.createElement('div')
  scroller.className = 'pdf-scroll'
  const column = document.createElement('div')
  column.className = 'pdf-pages'
  scroller.append(column)
  host.append(scroller)

  let flow = settings.pdfFlow || 'continuo'
  let splitMode = settings.pdfSplit || 'auto'
  let zoom = settings.pdfZoom || 1
  let vps = []           // páginas visibles
  const annotations = new Map()
  const pageCache = new Map()
  const getPage = i => pageCache.get(i) ?? pageCache.set(i, pdf.getPage(i)).get(i)

  function build() {
    column.replaceChildren()
    vps = planPages(splitMode).map((vp, idx) => {
      const slot = document.createElement('div')
      slot.className = 'pdf-slot'
      const el = document.createElement('div')
      el.className = 'pdf-page is-loading'
      el.dataset.v = idx
      el.innerHTML = `<div class="pdf-inner"><div class="pdf-canvas"></div><div class="hl-layer"></div><div class="textLayer"></div></div><span class="pdf-page-num">${idx + 1}</span>`
      slot.append(el)
      column.append(slot)
      return { ...vp, idx, slot, el, inner: el.firstElementChild, canvasBox: el.querySelector('.pdf-canvas'), text: el.querySelector('.textLayer'), hl: el.querySelector('.hl-layer'), state: 'empty', scale: 1 }
    })
    scroller.dataset.flow = flow
    layout()
    vps.forEach(vp => { io.observe(vp.el); drawPage(vp) })
  }

  // ---------- Medidas ----------
  const horizontal = () => flow === 'paginas'
  function layout() {
    const W = scroller.clientWidth, H = scroller.clientHeight
    const gutter = horizontal() ? 16 : 24
    scroller.classList.toggle('is-zoomed', zoom > 1.001)
    for (const vp of vps) {
      const fit = horizontal()
        ? Math.min((W - gutter) / vp.w, (H - gutter) / vp.h)
        : Math.min(W - gutter, MAX_WIDTH) / vp.w
      const s = fit * zoom
      vp.scale = s
      const w = vp.w * s, h = vp.h * s
      Object.assign(vp.el.style, { width: `${w}px`, height: `${h}px` })
      Object.assign(vp.inner.style, { width: `${vp.fw * s}px`, height: `${vp.fh * s}px`, left: vp.half === 1 ? `${-w}px` : '0px' })
      vp.inner.style.setProperty('--scale-factor', s)
      vp.inner.style.setProperty('--user-unit', 1)
      vp.inner.style.setProperty('--total-scale-factor', s)
      if (horizontal()) Object.assign(vp.slot.style, { width: `${Math.max(W, w + gutter)}px`, height: `${Math.max(H, h + gutter)}px` })
      else Object.assign(vp.slot.style, { width: '', height: '' })
      if (vp.state === 'done' && Math.abs(vp.renderedScale - s) > 0.001) vp.state = 'stale'
    }
  }

  // ---------- Renderizado perezoso ----------
  async function render(vp) {
    if (vp.state === 'rendering' || vp.state === 'done') return
    const myScale = vp.scale
    vp.state = 'rendering'
    try {
      const page = await getPage(vp.real)
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5)
      // solo se dibuja la mitad visible de la hoja
      const full = page.getViewport({ scale: myScale * dpr })
      const offsetX = vp.half === 1 ? -full.width / 2 : 0
      const viewport = page.getViewport({ scale: myScale * dpr, offsetX })
      const canvas = document.createElement('canvas')
      canvas.width = Math.floor(vp.half === null ? full.width : full.width / 2)
      canvas.height = Math.floor(full.height)
      Object.assign(canvas.style, { width: `${vp.w * myScale}px`, height: `${vp.h * myScale}px`, left: vp.half === 1 ? `${vp.w * myScale}px` : '0px' })
      vp.task?.cancel?.()
      vp.task = page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport })
      await vp.task.promise
      if (Math.abs(myScale - vp.scale) > 0.001) { vp.state = 'stale'; return render(vp) }
      canvas.classList.add('is-in')
      vp.canvasBox.replaceChildren(canvas)

      vp.text.replaceChildren()
      const tl = new pdfjsLib.TextLayer({ textContentSource: page.streamTextContent(), container: vp.text, viewport: page.getViewport({ scale: myScale }) })
      vp.textTask = tl
      await tl.render()
      // en una mitad, se quita el texto de la otra mitad (si no, la selección lo arrastraría)
      if (vp.half !== null) {
        for (const span of vp.text.querySelectorAll('span[style*="left"]')) {
          const left = parseFloat(span.style.left)
          if (vp.half === 0 ? left >= 50 : left < 50) span.remove()
        }
      }
      const end = document.createElement('div')
      end.className = 'endOfContent'
      vp.text.append(end)
      vp.state = 'done'
      vp.renderedScale = myScale
      vp.el.classList.remove('is-loading')
    } catch (e) {
      if (e?.name !== 'RenderingCancelledException') console.error(e)
      vp.state = 'empty'
    }
  }

  function release(vp) {
    if (vp.state === 'empty') return
    vp.task?.cancel?.()
    vp.textTask?.cancel?.()
    vp.canvasBox.replaceChildren()
    vp.text.replaceChildren()
    vp.state = 'empty'
    vp.el.classList.add('is-loading')
  }

  const visible = new Set()
  const io = new IntersectionObserver(entries => {
    for (const e of entries) {
      const vp = vps[Number(e.target.dataset.v)]
      if (!vp || vp.el !== e.target) continue
      if (e.isIntersecting) { visible.add(vp.idx); render(vp) } else visible.delete(vp.idx)
    }
    const cur = currentIndex()
    for (const vp of vps) if (Math.abs(vp.idx - cur) > 8 && !visible.has(vp.idx)) release(vp)
  }, { root: scroller, rootMargin: '100%' })

  // ---------- Posición ----------
  const startOf = vp => horizontal() ? vp.slot.offsetLeft : vp.slot.offsetTop
  const sizeOf = vp => horizontal() ? vp.slot.offsetWidth : vp.slot.offsetHeight
  const scrollPos = () => horizontal() ? scroller.scrollLeft : scroller.scrollTop
  const viewSize = () => horizontal() ? scroller.clientWidth : scroller.clientHeight

  function currentIndex() {
    if (!vps.length) return 0
    const y = scrollPos() + viewSize() * (horizontal() ? 0.5 : 0.25)
    let lo = 0, hi = vps.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (startOf(vps[mid]) <= y) lo = mid; else hi = mid - 1
    }
    return lo
  }
  function currentLocator() {
    const vp = vps[currentIndex()]
    const offset = horizontal() ? 0 : Math.min(1, Math.max(0, (scrollPos() - startOf(vp)) / sizeOf(vp)))
    const loc = { page: vp.real, offset: Number(offset.toFixed(4)) }
    if (vp.half !== null) loc.half = vp.half
    return { loc, vp, offset }
  }
  const vpFor = (page, half = 0) =>
    vps.find(v => v.real === page && (v.half === null || v.half === (half ?? 0))) ?? vps[Math.min(vps.length, Math.max(1, page)) - 1]

  // ---------- Índice ----------
  const toc = []
  const flat = []
  async function resolveDest(dest) {
    try {
      const d = typeof dest === 'string' ? await pdf.getDestination(dest) : dest
      if (!d) return null
      const ref = d[0]
      return (typeof ref === 'number' ? ref : await pdf.getPageIndex(ref)) + 1
    } catch { return null }
  }
  async function buildToc(items, out, level) {
    for (const it of items ?? []) {
      const label = (it.title ?? '').replace(/\s+/g, ' ').trim()
      if (!label) { await buildToc(it.items, out, level); continue }
      const page = it.dest ? await resolveDest(it.dest) : null
      const node = { label, target: page ? { page, offset: 0 } : null, page, subitems: [] }
      out.push(node)
      if (page) flat.push({ label, page, level })
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

  const fractionOf = (vpIdx, offset = 0) => vps.length > 1 ? Math.min(1, (vpIdx + offset) / vps.length) : offset
  let relocTimer
  function report() {
    clearTimeout(relocTimer)
    relocTimer = setTimeout(() => {
      if (!vps.length) return
      const { loc, vp, offset } = currentLocator()
      onRelocate?.({ fraction: fractionOf(vp.idx, offset), locator: loc, label: sectionLabel(vp.real), pageLabel: `${vp.idx + 1} de ${vps.length}` })
    }, 100)
  }
  scroller.addEventListener('scroll', report, { passive: true })

  function goTo(target, { smooth = false } = {}) {
    if (!target?.page) return
    let vp, offset = target.offset ?? 0
    // si es una cita, se va al rectángulo exacto
    const r = target.rects?.[0]
    if (r) {
      const half = vps.some(v => v.real === r.p && v.half !== null) ? (r.x + r.w / 2 >= 0.5 ? 1 : 0) : null
      vp = vpFor(r.p, half)
      offset = Math.max(0, r.y - 0.15)
    } else vp = vpFor(target.page, target.half)
    if (!vp) return
    const pos = horizontal() ? startOf(vp) : startOf(vp) + offset * sizeOf(vp) - (offset ? 0 : 8)
    scroller.scrollTo({ [horizontal() ? 'left' : 'top']: pos, behavior: smooth ? 'smooth' : 'instant' })
    report()
  }
  function goToFraction(f) {
    const x = Math.min(0.99999, Math.max(0, f)) * vps.length
    const vp = vps[Math.floor(x)]
    const pos = horizontal() ? startOf(vp) : startOf(vp) + (x - Math.floor(x)) * sizeOf(vp)
    scroller.scrollTo({ [horizontal() ? 'left' : 'top']: pos, behavior: 'instant' })
    report()
  }
  function step(dir) {
    if (horizontal()) {
      const i = Math.min(vps.length - 1, Math.max(0, currentIndex() + dir))
      scroller.scrollTo({ left: startOf(vps[i]), behavior: 'smooth' })
    } else scroller.scrollBy({ top: dir * scroller.clientHeight * 0.88, behavior: 'smooth' })
  }

  // Mantiene en su lugar el punto (x,y de pantalla) al cambiar el zoom o la disposición
  function anchorAt(clientX, clientY) {
    const vp = vps.find(v => { const b = v.el.getBoundingClientRect(); return clientY >= b.top && clientY <= b.bottom && clientX >= b.left - 20 && clientX <= b.right + 20 }) ?? vps[currentIndex()]
    const b = vp.el.getBoundingClientRect()
    return { vp, rx: (clientX - b.left) / b.width, ry: (clientY - b.top) / b.height, clientX, clientY }
  }
  function restoreAnchor(a) {
    const b = a.vp.el.getBoundingClientRect()
    scroller.scrollLeft += b.left + a.rx * b.width - a.clientX
    scroller.scrollTop += b.top + a.ry * b.height - a.clientY
  }

  function setZoom(z, anchor) {
    z = Math.round(Math.min(4, Math.max(0.5, z)) * 100) / 100
    if (Math.abs(z - zoom) < 0.001) return
    const sb = scroller.getBoundingClientRect()
    const a = anchor ?? anchorAt(sb.left + scroller.clientWidth / 2, sb.top + scroller.clientHeight / 3)
    zoom = z
    layout()
    restoreAnchor(a)
    vps.forEach(vp => { if (visible.has(vp.idx)) render(vp) })
    report()
    onZoom?.(zoom)
  }

  // ---------- Subrayados ----------
  function drawPage(vp) {
    vp.hl.replaceChildren()
    for (const ann of annotations.values()) {
      for (const r of ann.locator?.rects ?? []) {
        if (r.p !== vp.real) continue
        const d = document.createElement('div')
        d.className = 'hl'
        d.dataset.id = ann.id
        if (ann.note) d.classList.add('has-note')
        Object.assign(d.style, { left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%`, background: COLORS[ann.color] ?? COLORS.amarillo })
        vp.hl.append(d)
      }
    }
  }
  const pagesOf = ann => new Set((ann.locator?.rects ?? []).map(r => r.p))
  const redrawReal = (reals, newId) => vps.forEach(vp => {
    if (!reals.has(vp.real)) return
    drawPage(vp)
    if (newId) vp.hl.querySelectorAll(`.hl[data-id="${newId}"]`).forEach(d => d.classList.add('is-new'))
  })

  function setAnnotations(list) {
    annotations.clear()
    for (const a of list) if (a.kind === 'highlight') annotations.set(a.id, a)
    vps.forEach(drawPage)
  }
  function upsertHighlight(ann) {
    const old = annotations.get(ann.id)
    if (ann.deleted) annotations.delete(ann.id)
    else annotations.set(ann.id, ann)
    redrawReal(new Set([...(old ? pagesOf(old) : []), ...pagesOf(ann)]), !old && !ann.deleted ? ann.id : null)
  }

  // ---------- Selección ----------
  function selectionInfo() {
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
    const boxes = vps.map(vp => ({ vp, box: vp.el.getBoundingClientRect() })).filter(x => x.box.bottom > -200 && x.box.top < innerHeight + 200)
    const out = []
    for (const r of raw) {
      if (r.height > median * 3) continue
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2
      const hit = boxes.find(({ box }) => cx >= box.left && cx <= box.right && cy >= box.top && cy <= box.bottom)
      if (!hit) continue
      const ib = hit.vp.inner.getBoundingClientRect() // coordenadas de la hoja completa
      out.push({ p: hit.vp.real, x: (r.left - ib.left) / ib.width, y: (r.top - ib.top) / ib.height, w: r.width / ib.width, h: r.height / ib.height })
    }
    out.sort((a, b) => a.p - b.p || a.y - b.y || a.x - b.x)
    const merged = []
    for (const r of out) {
      const last = merged[merged.length - 1]
      if (last && last.p === r.p && Math.abs(last.y - r.y) < last.h * 0.5 && r.x <= last.x + last.w + last.h * 1.2) {
        const right = Math.max(last.x + last.w, r.x + r.w)
        const top = Math.min(last.y, r.y), bottom = Math.max(last.y + last.h, r.y + r.h)
        last.x = Math.min(last.x, r.x); last.w = right - last.x; last.y = top; last.h = bottom - top
      } else merged.push({ ...r })
    }
    if (!merged.length) return null
    const round = v => Number(v.toFixed(5))
    const rects = merged.map(r => ({ p: r.p, x: round(r.x), y: round(r.y), w: round(r.w), h: round(r.h) }))
    const first = rects[0]
    const vp = vpFor(first.p, vps.some(v => v.real === first.p && v.half !== null) ? (first.x >= 0.5 ? 1 : 0) : 0)
    return { text, rect: range.getBoundingClientRect(), locator: { page: first.p, rects }, fraction: fractionOf(vp.idx, first.y), label: sectionLabel(first.p) }
  }

  let selTimer
  const checkSelection = () => { clearTimeout(selTimer); selTimer = setTimeout(() => onSelection?.(selectionInfo()), 220) }
  document.addEventListener('selectionchange', checkSelection)

  // ---------- Toques, doble toque y pellizco ----------
  let down = null, lastTap = null, tapTimer = null, pinch = null
  // Mientras se arrastra una selección, el "fin de contenido" de la capa de texto cubre la hoja:
  // así la selección no salta a todo el resto de la página al pasar por espacios vacíos (truco de pdf.js)
  scroller.addEventListener('pointerdown', e => {
    down = { x: e.clientX, y: e.clientY, t: Date.now() }
    e.target.closest?.('.textLayer')?.classList.add('selecting')
  })
  const stopSelecting = () => { mouseSel = null; scroller.querySelectorAll('.textLayer.selecting').forEach(t => t.classList.remove('selecting')) }

  // Selección con mouse que empieza en un espacio en blanco (entre líneas o en el margen):
  // el navegador no la inicia sola, así que se ancla al texto más cercano y se extiende al mover.
  let mouseSel = null
  const nearestText = (layer, x, y) => {
    let best = null, bestD = Infinity
    for (const sp of layer.querySelectorAll('span')) {
      const node = sp.firstChild
      if (!node || node.nodeType !== 3 || !node.length) continue
      const r = sp.getBoundingClientRect()
      if (!r.width) continue
      const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0
      const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0
      const d = dy * 4 + dx // prioriza la misma línea
      if (d < bestD) { bestD = d; best = { node, r } }
    }
    if (!best) return null
    const { node, r } = best
    const t = Math.min(1, Math.max(0, (x - r.left) / r.width))
    return { node, offset: Math.round(t * node.length) }
  }
  const caretAt = (x, y, layer) => {
    const cr = document.caretRangeFromPoint?.(x, y)
    if (cr && cr.startContainer.nodeType === 3 && layer.contains(cr.startContainer)) return { node: cr.startContainer, offset: cr.startOffset }
    const cp = document.caretPositionFromPoint?.(x, y)
    if (cp && cp.offsetNode?.nodeType === 3 && layer.contains(cp.offsetNode)) return { node: cp.offsetNode, offset: cp.offset }
    return nearestText(layer, x, y)
  }
  scroller.addEventListener('mousedown', e => {
    if (e.button !== 0) return
    const layer = e.target.closest?.('.textLayer')
    if (!layer || e.target.tagName === 'SPAN') return
    const start = nearestText(layer, e.clientX, e.clientY)
    if (!start) return
    e.preventDefault()
    window.getSelection().setBaseAndExtent(start.node, start.offset, start.node, start.offset)
    mouseSel = { layer: scroller }
  })
  document.addEventListener('mousemove', e => {
    if (!mouseSel) return
    const pageEl = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.pdf-page')
    const layer = pageEl?.querySelector('.textLayer')
    if (!layer) return
    const pos = caretAt(e.clientX, e.clientY, layer)
    if (pos) window.getSelection().extend(pos.node, pos.offset)
  })
  document.addEventListener('pointerup', stopSelecting)
  document.addEventListener('mouseup', stopSelecting)
  document.addEventListener('pointercancel', stopSelecting)
  scroller.addEventListener('pointerup', e => {
    if (!down || pinch) { down = null; return }
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 10
    const long = Date.now() - down.t > 450
    down = null
    if (moved || long) return
    const sel = window.getSelection()
    if (sel && !sel.isCollapsed) return
    // ¿tocó un subrayado?
    const pageEl = e.target.closest?.('.pdf-page')
    if (pageEl) {
      const vp = vps[Number(pageEl.dataset.v)]
      const ib = vp.inner.getBoundingClientRect()
      const x = (e.clientX - ib.left) / ib.width, y = (e.clientY - ib.top) / ib.height
      for (const ann of annotations.values()) {
        const hit = (ann.locator?.rects ?? []).some(r => r.p === vp.real && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)
        if (hit) {
          const hl = pageEl.querySelector(`.hl[data-id="${ann.id}"]`)
          onAnnotationClick?.(ann.id, hl?.getBoundingClientRect() ?? { left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY, width: 0, height: 0 })
          return
        }
      }
    }
    // doble toque → acercar en ese punto / volver al ajuste
    const now = Date.now()
    if (lastTap && now - lastTap.t < 300 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
      clearTimeout(tapTimer); lastTap = null
      setZoom(zoom > 1.05 ? 1 : 2, anchorAt(e.clientX, e.clientY))
      return
    }
    lastTap = { t: now, x: e.clientX, y: e.clientY }
    const x = e.clientX / window.innerWidth
    tapTimer = setTimeout(() => {
      lastTap = null
      if (horizontal() && zoom <= 1.001 && x < 0.22) return step(-1)
      if (horizontal() && zoom <= 1.001 && x > 0.78) return step(1)
      onTap?.(x)
    }, 260)
  })

  const dist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)
  scroller.addEventListener('touchstart', e => {
    if (e.touches.length === 2) {
      const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2
      const my = (e.touches[0].clientY + e.touches[1].clientY) / 2
      const sb = scroller.getBoundingClientRect()
      pinch = { d0: dist(e.touches), z0: zoom, anchor: anchorAt(mx, my), s: 1 }
      column.style.transformOrigin = `${mx - sb.left + scroller.scrollLeft}px ${my - sb.top + scroller.scrollTop}px`
    }
  }, { passive: true })
  scroller.addEventListener('touchmove', e => {
    if (!pinch || e.touches.length !== 2) return
    e.preventDefault()
    pinch.s = Math.min(4 / pinch.z0, Math.max(0.5 / pinch.z0, dist(e.touches) / pinch.d0))
    column.style.transform = `scale(${pinch.s})`
  }, { passive: false })
  const endPinch = () => {
    if (!pinch) return
    const p = pinch
    pinch = null
    column.style.transform = ''
    setZoom(p.z0 * p.s, p.anchor)
  }
  scroller.addEventListener('touchend', e => { if (e.touches.length < 2) endPinch() })
  scroller.addEventListener('touchcancel', endPinch)

  // ---------- Ajustes ----------
  function applySettings(s) {
    host.dataset.theme = s.theme
    const nf = s.pdfFlow || 'continuo', ns = s.pdfSplit || 'auto'
    if (nf !== flow || ns !== splitMode) {
      const { loc } = currentLocator()
      flow = nf; splitMode = ns
      vps.forEach(vp => { io.unobserve(vp.el); release(vp) })
      visible.clear()
      build()
      requestAnimationFrame(() => goTo(loc))
    }
    if (Math.abs((s.pdfZoom || 1) - zoom) > 0.001) setZoom(s.pdfZoom || 1)
  }

  let lastW = 0, lastH = 0
  const ro = new ResizeObserver(() => {
    if (!vps.length) return
    if (scroller.clientWidth === lastW && scroller.clientHeight === lastH) return
    lastW = scroller.clientWidth; lastH = scroller.clientHeight
    const sb = scroller.getBoundingClientRect()
    const a = anchorAt(sb.left + 10, sb.top + 10)
    layout()
    restoreAnchor(a)
    vps.forEach(vp => { if (visible.has(vp.idx)) render(vp) })
  })

  host.dataset.theme = settings.theme
  build()
  lastW = scroller.clientWidth; lastH = scroller.clientHeight
  ro.observe(scroller)
  requestAnimationFrame(() => { if (initialLocator?.page) goTo(initialLocator); else report() })

  const chapters = () => flat.map(f => {
    const vp = vpFor(f.page, 0)
    return { label: f.label, level: f.level, fraction: fractionOf(vp?.idx ?? f.page - 1), target: { page: f.page, offset: 0 }, pageLabel: `pág. ${(vp?.idx ?? f.page - 1) + 1}` }
  })

  return {
    format: 'pdf',
    toc,
    get chapters() { return chapters() },
    get paged() { return horizontal() && zoom <= 1.001 },
    get hasSpreads() { return sizes.some(isSpread) },
    describe: f => `pág. ${Math.min(vps.length, Math.floor(f * vps.length) + 1)} de ${vps.length}`,
    zoom: () => zoom,
    pageCount: n,
    goTo: (t, o) => goTo(t, o),
    goToFraction,
    next: () => step(1),
    prev: () => step(-1),
    currentLocator: () => {
      const { loc, vp, offset } = currentLocator()
      return { locator: loc, fraction: fractionOf(vp.idx, offset), label: sectionLabel(vp.real), pageLabel: `${vp.idx + 1} de ${vps.length}` }
    },
    setAnnotations,
    upsertHighlight,
    clearSelection: () => window.getSelection()?.removeAllRanges(),
    applySettings,
    destroy() {
      io.disconnect(); ro.disconnect()
      document.removeEventListener('selectionchange', checkSelection)
      document.removeEventListener('pointerup', stopSelecting)
      document.removeEventListener('mouseup', stopSelecting)
      document.removeEventListener('pointercancel', stopSelecting)
      vps.forEach(release)
      scroller.remove()
      closePdf(pdf)
    },
  }
}
