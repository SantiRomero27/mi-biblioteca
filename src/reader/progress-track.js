// Línea de progreso con marcas de capítulos.
// - Marcas: rayas en el inicio de cada capítulo; al pasar el mouse muestran el nombre, y al tocarlas saltan ahí.
// - Arrastrar: muestra en vivo el capítulo y la página/porcentaje del punto, y salta al soltar.
import { esc } from '../ui/dom.js'

export function createProgressTrack(host, { onSeek, onChapter, describe }) {
  host.innerHTML = `
    <div class="trk" role="slider" tabindex="0" aria-label="Progreso de lectura" aria-valuemin="0" aria-valuemax="100">
      <div class="trk-rail"><div class="trk-fill"></div></div>
      <div class="trk-marks"></div>
      <div class="trk-thumb"></div>
      <div class="trk-tip" hidden></div>
    </div>`
  const trk = host.querySelector('.trk')
  const fill = host.querySelector('.trk-fill')
  const thumb = host.querySelector('.trk-thumb')
  const marksEl = host.querySelector('.trk-marks')
  const tip = host.querySelector('.trk-tip')

  let chapters = []
  let value = 0
  let dragging = false

  const pct = f => `${(Math.min(1, Math.max(0, f)) * 100).toFixed(3)}%`
  const paint = f => {
    fill.style.width = pct(f)
    thumb.style.left = pct(f)
    trk.setAttribute('aria-valuenow', Math.round(f * 100))
  }

  const chapterAt = f => {
    let cur = null
    for (const c of chapters) { if (c.fraction <= f + 1e-6) cur = c; else break }
    return cur
  }

  function setChapters(list) {
    chapters = [...list].sort((a, b) => a.fraction - b.fraction)
    // Nivel principal: el más alto del índice que tenga al menos 3 entradas
    // (muchos libros cuelgan todos los capítulos de una sola entrada con el título del libro)
    const counts = {}
    for (const c of chapters) counts[c.level] = (counts[c.level] ?? 0) + 1
    const levels = Object.keys(counts).map(Number).sort((a, b) => a - b)
    const main = levels.find(l => counts[l] >= 3) ?? levels[0] ?? 0
    marksEl.innerHTML = chapters.map((c, i) =>
      `<button class="trk-mark ${c.level > main ? 'is-sub' : ''}" style="left:${pct(c.fraction)}" data-i="${i}" aria-label="${esc(c.label)}"></button>`).join('')
    for (const m of marksEl.children) {
      const c = chapters[Number(m.dataset.i)]
      m.addEventListener('pointerenter', () => showTip(c.fraction, c.label, c.pageLabel, true))
      m.addEventListener('pointerleave', () => { if (!dragging) hideTip() })
      m.addEventListener('pointerdown', e => e.stopPropagation())
      m.addEventListener('click', e => { e.stopPropagation(); hideTip(); onChapter(c) })
    }
    markCurrent()
  }

  function markCurrent() {
    const cur = chapterAt(value)
    for (const m of marksEl.children) m.classList.toggle('is-current', chapters[Number(m.dataset.i)] === cur)
  }

  function showTip(f, label, extra, strong = false) {
    tip.hidden = false
    tip.innerHTML = `${label ? `<strong>${esc(label)}</strong>` : ''}${extra ? `<span>${esc(extra)}</span>` : ''}`
    tip.classList.toggle('is-mark', strong)
    const w = trk.clientWidth, tw = tip.offsetWidth
    const x = Math.min(w - tw / 2, Math.max(tw / 2, f * w))
    tip.style.left = `${x}px`
  }
  const hideTip = () => { tip.hidden = true }

  const fracFromEvent = e => {
    const r = trk.getBoundingClientRect()
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
  }
  const preview = f => {
    const c = chapterAt(f)
    showTip(f, c?.label ?? '', describe(f))
  }

  trk.addEventListener('pointerdown', e => {
    dragging = true
    trk.setPointerCapture(e.pointerId)
    trk.classList.add('is-dragging')
    const f = fracFromEvent(e)
    paint(f); preview(f)
  })
  trk.addEventListener('pointermove', e => {
    const f = fracFromEvent(e)
    if (dragging) { paint(f); preview(f) }
    else if (e.pointerType === 'mouse' && !e.target.classList.contains('trk-mark')) preview(f)
  })
  trk.addEventListener('pointerleave', () => { if (!dragging) hideTip() })
  const end = e => {
    if (!dragging) return
    dragging = false
    trk.classList.remove('is-dragging')
    hideTip()
    const f = fracFromEvent(e)
    value = f
    onSeek(f)
  }
  trk.addEventListener('pointerup', end)
  trk.addEventListener('pointercancel', () => { dragging = false; trk.classList.remove('is-dragging'); hideTip(); paint(value) })
  trk.addEventListener('keydown', e => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault(); e.stopPropagation()
      const step = e.shiftKey ? 0.05 : 0.01
      value = Math.min(1, Math.max(0, value + (e.key === 'ArrowRight' ? step : -step)))
      paint(value); onSeek(value)
    }
  })

  return {
    set(f) { if (!dragging) { value = f ?? 0; paint(value); markCurrent() } },
    setChapters,
    chapters: () => chapters,
    chapterAt,
  }
}
