// Pantalla de lectura: barras, panel de índice/notas, ajustes y menú de selección.
// El motor (PDF o EPUB) se encarga de dibujar; esta capa es igual para los dos formatos.
import { $, $$, h, esc, toast, promptNote, confirmDialog } from '../ui/dom.js'
import { icon } from '../ui/icons.js'
import { changes } from '../db.js'
import {
  getBook, getFile, updateBook, importFile, listAnnotations, addAnnotation,
  updateAnnotation, removeAnnotation, COLORS,
} from '../books.js'
import { loadSettings, saveSettings, THEMES, listCustomFonts, addCustomFont } from '../settings.js'

export async function renderReader(root, bookId, { onExit, annId = null }) {
  const book = await getBook(bookId)
  if (!book || book.deleted) { onExit(); return () => {} }

  let settings = await loadSettings()
  const el = h(`
    <div class="reader" data-theme="${settings.theme}">
      <header class="rd-top">
        <button class="icon-btn" data-act="back" title="Volver a la biblioteca">${icon('back')}</button>
        <div class="rd-title">
          <div class="rd-book">${esc(book.title)}</div>
          <div class="rd-section"></div>
        </div>
        <button class="icon-btn" data-act="bookmark" title="Marcador">${icon('bookmarkOutline')}</button>
        <button class="icon-btn" data-act="panel" title="Índice y notas">${icon('toc')}</button>
        <button class="icon-btn" data-act="settings" title="Ajustes de lectura">${icon('tune')}</button>
      </header>
      <div class="rd-stage"></div>
      <footer class="rd-bottom">
        <div class="rd-progress-row">
          <span class="rd-label"></span>
          <span class="rd-page"></span>
        </div>
        <input class="rd-slider" type="range" min="0" max="1" step="0.0005" value="0" aria-label="Progreso" />
      </footer>
      <div class="rd-scrim"></div>
      <aside class="rd-panel" aria-label="Índice y notas">
        <div class="rd-panel-head">
          <div class="tabs">
            <button class="tab is-active" data-tab="toc">Índice</button>
            <button class="tab" data-tab="notes">Notas</button>
            <button class="tab" data-tab="marks">Marcadores</button>
          </div>
          <button class="icon-btn" data-act="close-panel">${icon('close')}</button>
        </div>
        <div class="rd-panel-body"></div>
      </aside>
      <div class="rd-settings" aria-label="Ajustes de lectura"></div>
      <div class="sel-pop" hidden></div>
    </div>`)
  root.replaceChildren(el)

  const stage = $('.rd-stage', el)
  const slider = $('.rd-slider', el)
  const popEl = $('.sel-pop', el)
  let engine = null
  let annotations = []
  let position = book.progress ?? { fraction: 0 }
  let panelTab = 'toc'
  let saveTimer
  let lastSaved = JSON.stringify(book.progress?.locator ?? null)

  // ---------- Archivo ----------
  const fileRow = await getFile(bookId)
  if (!fileRow) {
    stage.innerHTML = `
      <div class="missing">
        ${icon('folder', 'missing-ic')}
        <h2>Este libro no está en este dispositivo</h2>
        <p>Tus notas, subrayados y progreso están guardados en tu cuenta. Elegí el mismo archivo
        (<strong>${esc(book.fileName || book.title)}</strong>) para seguir leyendo donde quedaste.</p>
        <label class="btn-filled">${icon('upload')} Elegir archivo
          <input type="file" accept=".pdf,.epub,application/pdf,application/epub+zip" hidden />
        </label>
      </div>`
    $('input', stage).onchange = async e => {
      const f = e.target.files[0]
      if (!f) return
      try {
        const res = await importFile(f)
        if (res.book.id !== bookId) {
          toast('Ese archivo es otro libro: lo agregué a la biblioteca')
          return
        }
        renderReader(root, bookId, { onExit })
      } catch (err) { toast(err.message) }
    }
    wireTop()
    return () => {}
  }

  // ---------- Motor ----------
  const common = {
    host: stage,
    file: fileRow.blob,
    settings,
    initialLocator: book.progress?.locator ?? null,
    onRelocate: pos => { position = pos; updateProgressUI(); scheduleSave() },
    onSelection: sel => sel ? showSelectionPop(sel) : (popMode === 'selection' && hidePop()),
    onAnnotationClick: (id, rect) => showAnnotationPop(id, rect),
    onTap: x => {
      if (!popEl.hidden) return hidePop()
      if (el.classList.contains('panel-open') || el.classList.contains('settings-open')) return closeOverlays()
      if (engine?.format === 'epub' && settings.flow === 'paginated') {
        if (x < 0.25) return engine.prev()
        if (x > 0.75) return engine.next()
      }
      el.classList.toggle('chrome-hidden')
    },
  }
  stage.innerHTML = '<div class="loading">Abriendo…</div>'
  try {
    const { createPdfEngine } = book.format === 'pdf' ? await import('./pdf-engine.js') : {}
    const { createEpubEngine } = book.format === 'epub' ? await import('./epub-engine.js') : {}
    stage.replaceChildren()
    engine = book.format === 'pdf' ? await createPdfEngine(common) : await createEpubEngine(common)
  } catch (err) {
    console.error(err)
    stage.innerHTML = `<div class="missing"><h2>No se pudo abrir el libro</h2><p>${esc(err.message)}</p></div>`
    wireTop()
    return () => {}
  }

  annotations = await listAnnotations(bookId)
  engine.setAnnotations(annotations)
  updateBook(bookId, { lastOpenedAt: Date.now() })
  if (annId) {
    const target = annotations.find(a => a.id === annId)
    if (target) setTimeout(() => engine.goTo(target.locator), 150)
  }

  // ---------- Progreso ----------
  function updateProgressUI() {
    slider.value = position.fraction ?? 0
    $('.rd-label', el).textContent = position.label || ''
    $('.rd-section', el).textContent = position.label || ''
    $('.rd-page', el).textContent = position.pageLabel || ''
    refreshBookmarkBtn()
    if (panelTab === 'toc' && el.classList.contains('panel-open')) markCurrentToc()
  }
  slider.addEventListener('input', () => engine.goToFraction(parseFloat(slider.value)))

  function scheduleSave() {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(saveNow, 1500)
  }
  async function saveNow() {
    clearTimeout(saveTimer)
    if (!position?.locator) return
    const key = JSON.stringify(position.locator)
    if (key === lastSaved) return
    lastSaved = key
    await updateBook(bookId, {
      progress: { fraction: Number((position.fraction ?? 0).toFixed(5)), locator: position.locator, label: position.label ?? '' },
      lastOpenedAt: Date.now(),
    })
  }

  // ---------- Barras ----------
  function wireTop() {
    $('[data-act=back]', el).onclick = async () => { await saveNow?.(); onExit() }
  }
  wireTop()
  $('[data-act=panel]', el).onclick = () => openPanel(panelTab)
  $('[data-act=close-panel]', el).onclick = closeOverlays
  $('.rd-scrim', el).onclick = closeOverlays
  $('[data-act=settings]', el).onclick = () => {
    const open = !el.classList.contains('settings-open')
    closeOverlays()
    if (open) { renderSettings(); el.classList.add('settings-open') }
  }
  $('[data-act=bookmark]', el).onclick = toggleBookmark
  $$('.tab', el).forEach(t => t.onclick = () => openPanel(t.dataset.tab))

  function closeOverlays() {
    el.classList.remove('panel-open', 'settings-open')
  }

  // ---------- Panel: índice, notas, marcadores ----------
  function openPanel(tab) {
    panelTab = tab
    $$('.tab', el).forEach(t => t.classList.toggle('is-active', t.dataset.tab === tab))
    el.classList.remove('settings-open')
    el.classList.add('panel-open')
    renderPanel()
  }

  function renderPanel() {
    const body = $('.rd-panel-body', el)
    if (panelTab === 'toc') {
      if (!engine.toc.length) {
        body.innerHTML = `<p class="empty-note">Este ${book.format === 'pdf' ? 'PDF' : 'libro'} no trae índice.</p>`
        return
      }
      const tree = (items, level) => items.map(it => `
        <li>
          <button class="toc-item" style="--lvl:${level}" ${it.target ? '' : 'disabled'} data-target='${esc(JSON.stringify(it.target))}'>
            <span>${esc(it.label)}</span>${it.page ? `<span class="toc-page">${it.page}</span>` : ''}
          </button>
          ${it.subitems?.length ? `<ul>${tree(it.subitems, level + 1)}</ul>` : ''}
        </li>`).join('')
      body.innerHTML = `<ul class="toc">${tree(engine.toc, 0)}</ul>`
      $$('.toc-item', body).forEach(b => b.onclick = () => {
        engine.goTo(JSON.parse(b.dataset.target))
        closeOverlays()
      })
      markCurrentToc()
      return
    }
    const kind = panelTab === 'notes' ? 'highlight' : 'bookmark'
    const list = annotations.filter(a => a.kind === kind && !a.deleted)
    if (!list.length) {
      body.innerHTML = `<p class="empty-note">${kind === 'highlight'
        ? 'Todavía no subrayaste nada. Seleccioná un texto para marcarlo o dejar una nota.'
        : 'Sin marcadores. Tocá el ícono de marcador arriba para guardar esta página.'}</p>`
      return
    }
    body.innerHTML = `<ul class="ann-list">${list.map(a => `
      <li class="ann" data-id="${a.id}" style="--c:${COLORS[a.color] ?? COLORS.amarillo}">
        <button class="ann-go">
          <span class="ann-meta">${esc(a.label || '')}${a.label ? ' · ' : ''}${book.format === 'pdf' && a.locator?.page ? `pág. ${a.locator.page}` : `${Math.round((a.fraction ?? 0) * 100)} %`}</span>
          ${a.text ? `<span class="ann-text">${esc(a.text)}</span>` : ''}
          ${a.note ? `<span class="ann-note">${esc(a.note)}</span>` : ''}
        </button>
        <div class="ann-actions">
          ${kind === 'highlight' ? `<button class="icon-btn sm" data-act="edit" title="Editar nota">${icon('edit')}</button>` : ''}
          <button class="icon-btn sm" data-act="del" title="Borrar">${icon('delete')}</button>
        </div>
      </li>`).join('')}</ul>`
    $$('.ann', body).forEach(li => {
      const a = annotations.find(x => x.id === li.dataset.id)
      $('.ann-go', li).onclick = () => { engine.goTo(a.locator); closeOverlays() }
      $('[data-act=edit]', li)?.addEventListener('click', () => editNote(a.id))
      $('[data-act=del]', li).onclick = () => deleteAnn(a.id)
    })
  }

  function markCurrentToc() {
    const label = position.label
    $$('.toc-item', el).forEach(b => b.classList.toggle('is-current', !!label && b.textContent.trim().startsWith(label.trim())))
  }

  // ---------- Marcadores ----------
  function bookmarkHere() {
    const loc = position.locator
    return annotations.find(a => a.kind === 'bookmark' && !a.deleted && (
      book.format === 'pdf' ? a.locator?.page === loc?.page : Math.abs((a.fraction ?? -1) - (position.fraction ?? 0)) < 0.003
    ))
  }
  function refreshBookmarkBtn() {
    const on = !!bookmarkHere()
    const btn = $('[data-act=bookmark]', el)
    btn.innerHTML = icon(on ? 'bookmark' : 'bookmarkOutline')
    btn.classList.toggle('is-on', on)
  }
  async function toggleBookmark() {
    const existing = bookmarkHere()
    if (existing) {
      await removeAnnotation(existing.id)
      annotations = annotations.filter(a => a.id !== existing.id)
      toast('Marcador quitado')
    } else {
      const pos = engine.currentLocator() ?? position
      const locator = book.format === 'pdf' ? { page: pos.locator.page, offset: pos.locator.offset } : pos.locator
      const ann = await addAnnotation({ bookId, kind: 'bookmark', locator, fraction: pos.fraction ?? 0, label: pos.label ?? '', text: pos.pageLabel ?? '' })
      annotations.push(ann)
      toast('Marcador guardado')
    }
    refreshBookmarkBtn()
    if (el.classList.contains('panel-open')) renderPanel()
  }

  // ---------- Menú de selección ----------
  let pendingSel = null
  let popMode = null

  function placePop(rect) {
    popEl.hidden = false
    const pw = popEl.offsetWidth, ph = popEl.offsetHeight
    const vw = window.innerWidth
    let left = (rect.left + rect.right) / 2 - pw / 2
    left = Math.max(8, Math.min(vw - pw - 8, left))
    let top = rect.top - ph - 12
    if (top < 64) top = rect.bottom + 12
    popEl.style.left = `${left}px`
    popEl.style.top = `${top}px`
  }
  const colorButtons = active => Object.entries(COLORS).map(([k, c]) =>
    `<button class="dot ${k === active ? 'is-active' : ''}" data-color="${k}" style="--c:${c}" title="${k}"></button>`).join('')

  function showSelectionPop(sel) {
    pendingSel = sel
    popMode = 'selection'
    popEl.innerHTML = `
      <div class="pop-row">${colorButtons()}</div>
      <div class="pop-row">
        <button class="pop-btn" data-act="note">${icon('notes')}<span>Nota</span></button>
        <button class="pop-btn" data-act="copy">${icon('copy')}<span>Copiar</span></button>
      </div>`
    $$('.dot', popEl).forEach(d => d.onclick = () => createHighlight(d.dataset.color))
    $('[data-act=note]', popEl).onclick = async () => {
      const s = pendingSel
      hidePop()
      const note = await promptNote({ title: 'Nueva nota', quote: s.text })
      if (note === null) return
      pendingSel = s
      createHighlight('amarillo', note)
    }
    $('[data-act=copy]', popEl).onclick = () => copyText(pendingSel.text)
    placePop(sel.rect)
  }

  async function createHighlight(color, note = '') {
    const s = pendingSel
    if (!s) return
    const ann = await addAnnotation({
      bookId, kind: 'highlight', color, note, text: s.text,
      locator: s.locator, fraction: s.fraction ?? position.fraction ?? 0, label: s.label || position.label || '',
    })
    annotations.push(ann)
    engine.upsertHighlight(ann)
    engine.clearSelection()
    hidePop()
    if (el.classList.contains('panel-open')) renderPanel()
  }

  function showAnnotationPop(id, rect) {
    const a = annotations.find(x => x.id === id)
    if (!a) return
    popMode = 'annotation'
    popEl.innerHTML = `
      ${a.note ? `<p class="pop-note">${esc(a.note)}</p>` : ''}
      <div class="pop-row">${colorButtons(a.color)}</div>
      <div class="pop-row">
        <button class="pop-btn" data-act="note">${icon('notes')}<span>${a.note ? 'Editar' : 'Nota'}</span></button>
        <button class="pop-btn" data-act="copy">${icon('copy')}<span>Copiar</span></button>
        <button class="pop-btn" data-act="del">${icon('delete')}<span>Borrar</span></button>
      </div>`
    $$('.dot', popEl).forEach(d => d.onclick = async () => {
      const next = await updateAnnotation(id, { color: d.dataset.color })
      replaceAnn(next); hidePop()
    })
    $('[data-act=note]', popEl).onclick = () => { hidePop(); editNote(id) }
    $('[data-act=copy]', popEl).onclick = () => copyText(a.text)
    $('[data-act=del]', popEl).onclick = () => { hidePop(); deleteAnn(id, true) }
    placePop(rect)
  }

  function hidePop() { popEl.hidden = true; pendingSel = null; popMode = null }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast('Copiado') }
    catch { toast('No se pudo copiar') }
    engine.clearSelection(); hidePop()
  }

  function replaceAnn(next) {
    annotations = annotations.map(a => a.id === next.id ? next : a)
    if (next.kind === 'highlight') engine.upsertHighlight(next)
    if (el.classList.contains('panel-open')) renderPanel()
  }

  async function editNote(id) {
    const a = annotations.find(x => x.id === id)
    const note = await promptNote({ title: a.note ? 'Editar nota' : 'Nota', quote: a.text, value: a.note })
    if (note === null) return
    replaceAnn(await updateAnnotation(id, { note }))
  }

  async function deleteAnn(id, skipConfirm = false) {
    const a = annotations.find(x => x.id === id)
    if (!skipConfirm && a.kind === 'highlight' && a.note) {
      const ok = await confirmDialog({ title: 'Borrar subrayado', body: 'También se borra la nota asociada.', ok: 'Borrar', danger: true })
      if (!ok) return
    }
    const next = await removeAnnotation(id)
    annotations = annotations.filter(x => x.id !== id)
    if (a.kind === 'highlight') engine.upsertHighlight(next)
    refreshBookmarkBtn()
    if (el.classList.contains('panel-open')) renderPanel()
  }

  // ---------- Ajustes ----------
  async function renderSettings() {
    const box = $('.rd-settings', el)
    const fonts = await listCustomFonts()
    const isEpub = book.format === 'epub'
    const seg = (key, options) => `<div class="seg">${options.map(([v, l]) =>
      `<button class="${String(settings[key]) === String(v) ? 'is-active' : ''}" data-key="${key}" data-val="${v}">${l}</button>`).join('')}</div>`
    box.innerHTML = `
      <div class="set-head">Ajustes de ${isEpub ? 'EPUB' : 'PDF'}</div>
      <div class="set-group">
        <div class="set-label">Modo de color</div>
        <div class="swatches">${Object.entries(THEMES).map(([k, t]) =>
          `<button class="swatch ${settings.theme === k ? 'is-active' : ''}" data-theme-pick="${k}" style="--bg:${t.bg};--fg:${t.fg}"><span>Aa</span><small>${t.label}</small></button>`).join('')}</div>
      </div>
      ${isEpub ? `
      <div class="set-group">
        <div class="set-label">Fuente</div>
        <select class="set-select" data-key="font">
          <option value="archivo" ${settings.font === 'archivo' ? 'selected' : ''}>Archivo</option>
          <option value="lato" ${settings.font === 'lato' ? 'selected' : ''}>Lato</option>
          <option value="original" ${settings.font === 'original' ? 'selected' : ''}>Original del libro</option>
          ${fonts.map(f => `<option value="custom:${esc(f.name)}" ${settings.font === 'custom:' + f.name ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}
        </select>
        <label class="link-btn">+ Cargar fuente (.ttf, .otf, .woff2)<input type="file" accept=".ttf,.otf,.woff,.woff2" hidden data-font-upload /></label>
      </div>
      <div class="set-group">
        <div class="set-label">Tamaño</div>
        <div class="stepper"><button data-step="fontSize" data-d="-1">${icon('remove')}</button><span>${settings.fontSize}</span><button data-step="fontSize" data-d="1">${icon('add')}</button></div>
      </div>
      ${settings.font === 'archivo' || settings.font.startsWith('custom:') ? `
      <div class="set-group">
        <div class="set-label">Grosor <span class="set-val">${settings.weight}</span></div>
        <input type="range" min="250" max="650" step="10" value="${settings.weight}" data-range="weight" />
      </div>
      <div class="set-group">
        <div class="set-label">Ancho de letra <span class="set-val">${settings.stretch} %</span></div>
        <input type="range" min="75" max="125" step="1" value="${settings.stretch}" data-range="stretch" />
      </div>` : ''}
      <div class="set-group">
        <div class="set-label">Interlineado</div>
        <div class="stepper"><button data-step="lineHeight" data-d="-0.05">${icon('remove')}</button><span>${Math.round(settings.lineHeight * 100)} %</span><button data-step="lineHeight" data-d="0.05">${icon('add')}</button></div>
      </div>
      <div class="set-group">
        <div class="set-label">Largo de línea</div>
        ${seg('lineWidth', [['estrecho', 'Estrecho'], ['medio', 'Medio'], ['ancho', 'Ancho']])}
      </div>
      <div class="set-group">
        <div class="set-label">Alineación</div>
        ${seg('justify', [['true', 'Justificado'], ['false', 'Izquierda']])}
      </div>
      <div class="set-group">
        <div class="set-label">Paso de página</div>
        ${seg('flow', [['paginated', 'Páginas'], ['scrolled', 'Continuo']])}
      </div>
      <div class="set-group">
        <div class="set-label">Columnas</div>
        ${seg('columns', [['1', 'Una'], ['2', 'Dos']])}
      </div>` : `
      <div class="set-group">
        <div class="set-label">Zoom</div>
        <div class="stepper"><button data-step="pdfZoom" data-d="-0.1">${icon('remove')}</button><span>${Math.round(settings.pdfZoom * 100)} %</span><button data-step="pdfZoom" data-d="0.1">${icon('add')}</button></div>
      </div>
      <p class="set-hint">En PDF la tipografía es parte de la página, por eso no se puede cambiar.</p>`}
    `
    $$('[data-theme-pick]', box).forEach(b => b.onclick = () => update({ theme: b.dataset.themePick }))
    $$('.seg button', box).forEach(b => b.onclick = () => {
      const raw = b.dataset.val
      const v = raw === 'true' ? true : raw === 'false' ? false : /^\d+$/.test(raw) ? Number(raw) : raw
      update({ [b.dataset.key]: v })
    })
    $$('[data-step]', box).forEach(b => b.onclick = () => {
      const k = b.dataset.step, d = Number(b.dataset.d)
      const limits = { fontSize: [12, 40], lineHeight: [1, 2.4], pdfZoom: [0.5, 3] }
      const [lo, hi] = limits[k]
      update({ [k]: Math.round(Math.min(hi, Math.max(lo, settings[k] + d)) * 100) / 100 })
    })
    $$('[data-range]', box).forEach(r => {
      r.oninput = () => { r.previousElementSibling.querySelector('.set-val').textContent = r.value + (r.dataset.range === 'stretch' ? ' %' : '') }
      r.onchange = () => update({ [r.dataset.range]: Number(r.value) })
    })
    $('select[data-key=font]', box)?.addEventListener('change', e => update({ font: e.target.value }))
    $('[data-font-upload]', box)?.addEventListener('change', async e => {
      const f = e.target.files[0]
      if (!f) return
      const name = await addCustomFont(f)
      update({ font: 'custom:' + name })
    })
  }

  async function update(patch) {
    settings = { ...settings, ...patch }
    el.dataset.theme = settings.theme
    await saveSettings(settings)
    await engine.applySettings(settings)
    renderSettings()
  }

  // ---------- Teclado ----------
  const onKey = e => {
    if (e.target.closest?.('input, textarea, select')) return
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || (e.key === ' ' && engine.format === 'epub')) { e.preventDefault(); engine.next() }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); engine.prev() }
    else if (e.key === 'Escape') { hidePop(); closeOverlays() }
  }
  document.addEventListener('keydown', onKey)
  stage.addEventListener('keydown', onKey)

  // ---------- Cambios que llegan de otro dispositivo ----------
  const onChange = async e => {
    const { store, value, origin } = e.detail
    if (origin !== 'remote') return
    if (store === 'annotations' && value.bookId === bookId) {
      const exists = annotations.some(a => a.id === value.id)
      if (value.deleted) annotations = annotations.filter(a => a.id !== value.id)
      else if (exists) annotations = annotations.map(a => a.id === value.id ? value : a)
      else annotations.push(value)
      if (value.kind === 'highlight') engine.upsertHighlight(value)
      refreshBookmarkBtn()
      if (el.classList.contains('panel-open')) renderPanel()
    }
  }
  changes.addEventListener('change', onChange)

  const onHide = () => { if (document.visibilityState === 'hidden') saveNow() }
  document.addEventListener('visibilitychange', onHide)

  return async () => {
    await saveNow()
    document.removeEventListener('keydown', onKey)
    document.removeEventListener('visibilitychange', onHide)
    changes.removeEventListener('change', onChange)
    engine?.destroy()
  }
}
