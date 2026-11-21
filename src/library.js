// Biblioteca: lista de libros estilo ReadEra, filtros, citas y cuenta.
import { $, $$, h, esc, toast, confirmDialog } from './ui/dom.js'
import { icon } from './ui/icons.js'
import { changes, kv } from './db.js'
import {
  listBooks, importFile, updateBook, deleteBook, removeLocalFile, listAnnotations, formatSize, COLORS,
} from './books.js'
import { platform } from './platform.js'
import { isNative, scanFolders, listFolders, pickFolder, removeFolder } from './native.js'
import { sync, signIn, signUp, signOut, resetPassword, syncNow, signInWithGoogle } from './sync.js'
import { attachPullToRefresh } from './ui/pull-refresh.js'

let filter = 'todos'
let query = ''

const coverColors = ['#123f4b', '#5b3a29', '#2f4a32', '#4a2f4f', '#3a3f58', '#6a4a1c']
const hashIdx = (s, n) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % n

const urls = new Map()
const coverUrl = book => {
  if (!book.cover) return null
  const key = book.id + ':' + (book.cover.size ?? 0)
  if (!urls.has(key)) urls.set(key, URL.createObjectURL(book.cover))
  return urls.get(key)
}

function coverHTML(book) {
  const url = coverUrl(book)
  if (url) return `<img class="cover" src="${url}" alt="" loading="lazy" />`
  const bg = coverColors[hashIdx(book.id, coverColors.length)]
  return `<div class="cover cover-gen" style="--bg:${bg}"><span>${esc(book.title)}</span><small>${esc(book.author)}</small></div>`
}

const STATE_LABEL = {
  off: 'Sin sincronizar',
  'signed-out': 'Sin cuenta',
  syncing: 'Sincronizando…',
  ok: 'Sincronizado',
  offline: 'Sin conexión: se sube después',
  error: 'Error al sincronizar',
}

export async function renderLibrary(root, { openBook }) {
  const el = h(`
    <div class="library">
      <header class="lib-top">
        <div class="lib-bar">
          <h1 class="lib-title">Mi biblioteca</h1>
          <button class="icon-btn" data-act="view" title="Cambiar vista"></button>
          <button class="icon-btn" data-act="search" title="Buscar">${icon('search')}</button>
          ${isNative
            ? `<button class="icon-btn" data-act="folders" title="Carpetas de libros">${icon('folder')}</button>`
            : ''}
          <label class="icon-btn" title="Agregar libros" ${isNative ? 'hidden' : ''}>${icon('add')}
            <input type="file" accept=".pdf,.epub,application/pdf,application/epub+zip" multiple hidden data-add />
          </label>
          <button class="icon-btn account-btn" data-act="account" title="Cuenta y sincronización"></button>
          <button class="icon-btn" data-act="lib-menu" title="Más opciones">${icon('more')}</button>
          <input type="file" ${isNative ? '' : 'accept=".bak,.json"'} hidden data-readera />
        </div>
        <div class="lib-search" hidden>
          <input type="search" placeholder="Buscar por título, autor o descripción" />
        </div>
        <nav class="chips"></nav>
        <div class="scan-status" hidden></div>
      </header>
      <div class="ptr" aria-hidden="true"><span class="ptr-ic">${icon('refresh')}</span></div>
      <main class="lib-main is-first"></main>
      <div class="drop-hint">${icon('upload')}<span>Soltá los PDF o EPUB para agregarlos</span></div>
    </div>`)
  root.replaceChildren(el)

  const main = $('.lib-main', el)

  // ---------- Vista: tapas (cuadrícula) o lista ----------
  let view = await kv.get('lib-view', 'tapas')
  const viewBtn = $('[data-act=view]', el)
  const paintView = () => {
    viewBtn.innerHTML = icon(view === 'tapas' ? 'list' : 'grid')
    viewBtn.title = view === 'tapas' ? 'Ver como lista' : 'Ver tapas'
  }
  paintView()
  viewBtn.onclick = async () => {
    view = view === 'tapas' ? 'lista' : 'tapas'
    await kv.set('lib-view', view)
    paintView()
    render()
  }

  // ---------- Agregar ----------
  async function addFiles(files) {
    const list = Array.from(files).filter(f => /\.(pdf|epub)$/i.test(f.name))
    if (!list.length) return toast('Solo PDF o EPUB')
    let added = 0
    for (const f of list) {
      toast(`Agregando ${f.name}…`)
      try {
        const r = await importFile(f)
        if (r.status !== 'existente') added++
      } catch (e) {
        console.error(e)
        toast(`No se pudo abrir ${f.name}`)
      }
    }
    toast(added ? `${added} ${added === 1 ? 'libro agregado' : 'libros agregados'}` : 'Ya estaban en la biblioteca')
    render()
  }
  $('[data-add]', el).onchange = e => { addFiles(e.target.files); e.target.value = '' }
  el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('dragging') })
  el.addEventListener('dragleave', e => { if (e.target === el || !el.contains(e.relatedTarget)) el.classList.remove('dragging') })
  el.addEventListener('drop', e => { e.preventDefault(); el.classList.remove('dragging'); addFiles(e.dataTransfer.files) })

  // ---------- Carpetas (Android) ----------
  const scanEl = $('.scan-status', el)
  let lastScan = 0
  async function runScan({ quiet = false } = {}) {
    if (!isNative) return
    lastScan = Date.now()
    const folders = await listFolders()
    if (!folders.length) return
    scanEl.hidden = false
    scanEl.textContent = 'Buscando libros…'
    try {
      const r = await scanFolders((i, n, name) => { scanEl.textContent = `Leyendo ${i} de ${n} · ${name}` })
      if (r.failed) {
        await confirmDialog({
          title: 'Algunos libros no se pudieron abrir',
          body: `${r.failed} de ${r.total} archivos no se pudieron leer.\n\nPrimer error: ${r.firstError}`,
          ok: 'Entendido', cancel: false,
        })
      } else if (!r.total) {
        toast('No encontré PDF ni EPUB en esa carpeta (ni en sus subcarpetas)')
      } else if (!quiet || r.added || r.linked) {
        const parts = []
        if (r.added) parts.push(`${r.added} ${r.added === 1 ? 'libro nuevo' : 'libros nuevos'}`)
        if (r.linked) parts.push(`${r.linked} vinculados con tu cuenta`)
        toast(parts.length ? parts.join(' · ') : `${r.total} libros en tus carpetas`)
      }
    } catch (e) {
      console.error(e)
      toast('No se pudieron leer las carpetas')
    } finally {
      scanEl.hidden = true
      render()
    }
  }

  async function addFolder() {
    try {
      const f = await pickFolder()
      toast(`Carpeta agregada: ${f.name}`)
      await runScan()
    } catch (e) {
      if (e?.message !== 'cancelled') toast('No se pudo agregar la carpeta')
    }
  }

  async function openFolders() {
    const folders = await listFolders()
    const sheet = h(`
      <div class="modal-backdrop">
        <div class="modal">
          <h2 class="modal-title">Carpetas de libros</h2>
          <p class="modal-hint">La app lee los PDF y EPUB de estas carpetas (y sus subcarpetas) sin copiarlos.</p>
          <ul class="folder-list">${folders.length ? folders.map(f => `
            <li><span class="folder-ic">${icon('folder')}</span><span class="folder-name">${esc(f.name)}</span>
              <button class="icon-btn sm" data-remove="${esc(f.uri)}" title="Quitar carpeta">${icon('close')}</button></li>`).join('')
            : '<li class="empty-note">Todavía no elegiste ninguna carpeta.</li>'}
          </ul>
          <div class="modal-actions">
            <label class="btn-text">Agregar archivo suelto
              <input type="file" accept=".pdf,.epub,application/pdf,application/epub+zip" multiple hidden data-loose />
            </label>
            ${folders.length ? `<button class="btn-text" data-act="rescan">Buscar de nuevo</button>` : ''}
            <button class="btn-filled" data-act="add-folder">${icon('add')} Carpeta</button>
          </div>
        </div>
      </div>`)
    const close = () => sheet.remove()
    sheet.addEventListener('click', e => { if (e.target === sheet) close() })
    document.body.append(sheet)
    $('[data-act=add-folder]', sheet).onclick = () => { close(); addFolder() }
    $('[data-act=rescan]', sheet)?.addEventListener('click', () => { close(); runScan() })
    $('[data-loose]', sheet).onchange = e => { close(); addFiles(e.target.files) }
    $$('[data-remove]', sheet).forEach(b => b.onclick = async () => {
      const ok = await confirmDialog({ title: 'Quitar carpeta', body: 'La app deja de leer esta carpeta. No se borra ningún archivo, y tus notas y progreso quedan en la cuenta.', ok: 'Quitar' })
      if (!ok) return
      await removeFolder(b.dataset.remove)
      close()
      await runScan({ quiet: true })
      render()
    })
  }
  $('[data-act=folders]', el)?.addEventListener('click', openFolders)

  const onVisible = () => {
    if (document.visibilityState === 'visible' && Date.now() - lastScan > 20000) runScan({ quiet: true })
  }
  if (isNative) document.addEventListener('visibilitychange', onVisible)

  // ---------- Importar desde ReadEra ----------
  $('[data-act=lib-menu]', el).onclick = async e => {
    $('.menu-pop')?.remove()
    const r = e.currentTarget.getBoundingClientRect()
    const { listPending } = await import('./readera.js')
    const pending = await listPending()
    const menu = h(`
      <div class="menu-pop" role="menu">
        <button data-m="readera">Importar desde ReadEra…</button>
        ${pending.length ? `<button data-m="pending">Pendientes de ReadEra (${pending.length})</button>` : ''}
      </div>`)
    document.body.append(menu)
    menu.style.top = `${r.bottom + 4}px`
    menu.style.left = `${Math.max(8, r.right - menu.offsetWidth)}px`
    const close = () => { menu.remove(); document.removeEventListener('pointerdown', outside, true) }
    const outside = ev => { if (!menu.contains(ev.target)) close() }
    setTimeout(() => document.addEventListener('pointerdown', outside, true))
    $('[data-m=readera]', menu).onclick = () => { close(); $('[data-readera]', el).click() }
    $('[data-m=pending]', menu)?.addEventListener('click', () => { close(); showPending(pending) })
  }

  $('[data-readera]', el).onchange = async e => {
    const f = e.target.files[0]
    e.target.value = ''
    if (!f) return
    const { importBackup } = await import('./readera.js')
    scanEl.hidden = false
    scanEl.textContent = 'Leyendo la copia de ReadEra…'
    try {
      const st = await importBackup(f, (i, n, title) => { scanEl.textContent = `Pasando datos de ReadEra ${i} de ${n} · ${title}` })
      scanEl.hidden = true
      await render()
      const lines = [
        `Encontré ${st.books} libros en la copia de ReadEra.`,
        st.applied ? `Ya pasé los datos de ${st.applied} ${st.applied === 1 ? 'libro' : 'libros'} que están en tu biblioteca: progreso, leídos, por leer y favoritos, ${st.placed + st.unplaced ? `${st.placed} citas marcadas en su lugar${st.unplaced ? ` y ${st.unplaced} guardadas como nota sin marcar (no encontré el texto exacto en la página)` : ''}` : 'sin citas nuevas'}${st.bookmarks ? `, ${st.bookmarks} marcadores` : ''}.` : 'Todavía no hay en tu biblioteca ningún libro de esa copia.',
        st.pending ? `${st.pending === 1 ? 'Queda 1 libro pendiente: se completa solo' : `Quedan ${st.pending} libros pendientes: se completan solos`} cuando agregues ${st.pending === 1 ? 'ese archivo' : 'esos archivos'}${isNative ? ' a tus carpetas' : ''}.` : '',
      ].filter(Boolean)
      await confirmDialog({ title: 'Importación de ReadEra', body: lines.join('\n\n'), ok: 'Listo', cancel: false })
    } catch (err) {
      console.error(err)
      scanEl.hidden = true
      toast(err.message || 'No se pudo leer la copia')
    }
  }

  function showPending(pending) {
    const sheet = h(`
      <div class="modal-backdrop">
        <div class="modal">
          <h2 class="modal-title">Pendientes de ReadEra</h2>
          <p class="modal-hint">Estos libros tienen datos de ReadEra esperando. Cuando agregues el mismo archivo, se pasan solos el progreso y las citas.</p>
          <ul class="pending-list">${pending.map(p => `
            <li><strong>${esc(p.title)}</strong><span>${p.format.toUpperCase()}${p.citations.length ? ` · ${p.citations.length} citas` : ''}${p.position ? ` · ${Math.round(p.position.ratio * 100)} %` : ''}${p.finished ? ' · leído' : p.toRead ? ' · por leer' : ''}</span></li>`).join('')}
          </ul>
          <div class="modal-actions"><button class="btn-filled" data-act="ok">Cerrar</button></div>
        </div>
      </div>`)
    sheet.addEventListener('click', ev => { if (ev.target === sheet || ev.target.dataset.act === 'ok') sheet.remove() })
    document.body.append(sheet)
  }

  const onReadEra = e => {
    const { placed, unplaced } = e.detail
    toast(`Datos de ReadEra aplicados${placed + unplaced ? ` · ${placed + unplaced} citas` : ''}`)
  }
  changes.addEventListener('readera-applied', onReadEra)

  // ---------- Buscar ----------
  $('[data-act=search]', el).onclick = () => {
    const box = $('.lib-search', el)
    box.hidden = !box.hidden
    if (!box.hidden) $('input', box).focus()
    else { query = ''; $('input', box).value = ''; render() }
  }
  $('.lib-search input', el).oninput = e => { query = e.target.value.trim().toLowerCase(); render() }

  // ---------- Cuenta ----------
  const accountBtn = $('[data-act=account]', el)
  const paintAccount = () => {
    const s = sync.state
    accountBtn.innerHTML = icon(s === 'ok' || s === 'syncing' ? 'cloud' : s === 'off' || s === 'signed-out' ? 'person' : 'cloudOff')
    accountBtn.dataset.state = s
    accountBtn.title = STATE_LABEL[s] ?? ''
  }
  paintAccount()
  sync.addEventListener('state', paintAccount)
  const onAuthError = () => toast(sync.lastError)
  sync.addEventListener('auth-error', onAuthError)
  accountBtn.onclick = openAccount

  // ---------- Render ----------
  async function render() {
    const [books, anns] = await Promise.all([listBooks(), listAnnotations()])
    const notesBy = new Map()
    for (const a of anns) if (a.kind === 'highlight') notesBy.set(a.bookId, (notesBy.get(a.bookId) ?? 0) + 1)

    const counts = {
      todos: books.length,
      leyendo: books.filter(b => !b.finished && (b.progress?.fraction ?? 0) > 0).length,
      porleer: books.filter(b => b.toRead && !b.finished).length,
      favoritos: books.filter(b => b.favorite).length,
      terminados: books.filter(b => b.finished).length,
      citas: anns.filter(a => a.kind === 'highlight' && books.some(b => b.id === a.bookId)).length,
    }
    const chips = [['todos', 'Todos'], ['leyendo', 'Leyendo'], ['porleer', 'Por leer'], ['favoritos', 'Favoritos'], ['terminados', 'Terminados'], ['citas', 'Citas']]
    $('.chips', el).innerHTML = chips.map(([k, l]) =>
      `<button class="chip ${filter === k ? 'is-active' : ''}" data-f="${k}">${l}<span>${counts[k]}</span></button>`).join('')
    $$('.chip', el).forEach(c => c.onclick = () => { filter = c.dataset.f; render() })

    if (filter === 'citas') return renderQuotes(books, anns)

    let list = books
    if (filter === 'leyendo') list = list.filter(b => !b.finished && (b.progress?.fraction ?? 0) > 0)
    if (filter === 'porleer') list = list.filter(b => b.toRead && !b.finished)
    if (filter === 'favoritos') list = list.filter(b => b.favorite)
    if (filter === 'terminados') list = list.filter(b => b.finished)
    if (query) list = list.filter(b => `${b.title} ${b.author} ${b.description ?? ''}`.toLowerCase().includes(query))
    list.sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0) || b.addedAt - a.addedAt)

    const folders = isNative && !books.length ? await listFolders() : []
    if (!books.length && isNative && folders.length) {
      main.innerHTML = `
        <div class="empty">
          ${icon('folder', 'empty-ic')}
          <h2>Todavía no hay libros</h2>
          <p>Estoy leyendo ${folders.map(f => `<strong>${esc(f.name)}</strong>`).join(', ')}.
          Si ahí no hay PDF ni EPUB, elegí otra carpeta.</p>
          <div class="empty-actions">
            <button class="btn-filled" data-act="rescan">Buscar de nuevo</button>
            <button class="btn-text" data-act="other-folder">Elegir otra carpeta</button>
          </div>
        </div>`
      $('[data-act=rescan]', main).onclick = () => runScan()
      $('[data-act=other-folder]', main).onclick = addFolder
      return
    }
    if (!books.length && isNative) {
      main.innerHTML = `
        <div class="empty">
          ${icon('folder', 'empty-ic')}
          <h2>Elegí dónde están tus libros</h2>
          <p>Indicá la carpeta del celu o de la tarjeta SD donde guardás tus PDF y EPUB.
          La app los lee ahí mismo, sin copiarlos, y detecta los nuevos cada vez que la abrís.</p>
          <button class="btn-filled" data-act="first-folder">${icon('folder')} Elegir carpeta</button>
        </div>`
      $('[data-act=first-folder]', main).onclick = addFolder
      return
    }
    if (!books.length) {
      main.innerHTML = `
        <div class="empty">
          ${icon('book', 'empty-ic')}
          <h2>Tu biblioteca está vacía</h2>
          <p>Agregá libros PDF o EPUB con el botón + o arrastrándolos acá.
          Tus subrayados, notas y el punto donde quedaste se guardan en tu cuenta.</p>
          <label class="btn-filled">${icon('add')} Agregar libros
            <input type="file" accept=".pdf,.epub,application/pdf,application/epub+zip" multiple hidden />
          </label>
        </div>`
      $('input', main).onchange = e => addFiles(e.target.files)
      return
    }
    if (!list.length) {
      main.innerHTML = `<p class="empty-note">No hay libros en esta vista.</p>`
      return
    }

    if (view === 'tapas') return renderTiles(list, notesBy)

    main.innerHTML = `<ul class="books">${list.map(b => {
      const pct = Math.round((b.progress?.fraction ?? 0) * 100)
      const notes = notesBy.get(b.id) ?? 0
      return `
      <li class="book" data-id="${b.id}" style="--i:${Math.min(list.indexOf(b), 12)}">
        <button class="book-open">
          ${coverHTML(b)}
          <div class="book-info">
            <h3 class="book-title">${esc(b.title)}</h3>
            ${b.author ? `<p class="book-author">${esc(b.author)}</p>` : ''}
            ${b.description ? `<p class="book-desc">${esc(b.description)}</p>` : ''}
            <p class="book-meta">${b.format.toUpperCase()}${b.size ? ' · ' + formatSize(b.size) : ''}${b.hasFile ? '' : ' · <span class="not-here">no está en este dispositivo</span>'}</p>
            <div class="book-progress">
              <div class="bar"><span style="width:${b.finished ? 100 : pct}%"></span></div>
              <span class="pct">${b.finished ? 'Terminado' : pct ? pct + ' %' : b.toRead ? 'Por leer' : 'Sin empezar'}</span>
            </div>
          </div>
        </button>
        <div class="book-actions">
          <button class="icon-btn sm ${b.favorite ? 'is-on' : ''}" data-act="fav" title="Favorito">${icon(b.favorite ? 'star' : 'starOutline')}</button>
          <button class="icon-btn sm ${b.toRead && !b.finished ? 'is-on' : ''}" data-act="toread" title="Por leer">${icon('schedule')}</button>
          <button class="icon-btn sm ${b.finished ? 'is-on' : ''}" data-act="done" title="Marcar como terminado">${icon('doneAll')}</button>
          <button class="icon-btn sm notes-count" data-act="notes" title="Notas y subrayados">${icon('notes')}${notes ? `<span>${notes}</span>` : ''}</button>
          <button class="icon-btn sm" data-act="more" title="Más opciones">${icon('more')}</button>
        </div>
      </li>`
    }).join('')}</ul>`

    $$('.book', main).forEach(li => {
      const id = li.dataset.id
      const b = list.find(x => x.id === id)
      $('.book-open', li).onclick = () => openBook(id)
      $('[data-act=fav]', li).onclick = async () => { await updateBook(id, { favorite: !b.favorite }); render() }
      $('[data-act=done]', li).onclick = async () => {
        // terminar un libro lo saca de "Por leer"
        await updateBook(id, b.finished ? { finished: false } : { finished: true, toRead: false }); render()
      }
      $('[data-act=toread]', li).onclick = async () => {
        const on = !(b.toRead && !b.finished)
        await updateBook(id, on ? { toRead: true, finished: false } : { toRead: false })
        toast(on ? 'Agregado a Por leer' : 'Quitado de Por leer')
        render()
      }
      $('[data-act=notes]', li).onclick = () => { filter = 'citas'; query = b.title.toLowerCase(); render() }
      $('[data-act=more]', li).onclick = e => bookMenu(e.currentTarget, b)
    })
  }

  function renderTiles(list, notesBy) {
    main.innerHTML = `<ul class="tiles">${list.map(b => {
      const pct = Math.round((b.progress?.fraction ?? 0) * 100)
      const notes = notesBy.get(b.id) ?? 0
      const badges = [
        b.favorite ? `<span class="badge is-fav" title="Favorito">${icon('star')}</span>` : '',
        b.finished ? `<span class="badge" title="Terminado">${icon('doneAll')}</span>`
          : b.toRead ? `<span class="badge" title="Por leer">${icon('schedule')}</span>` : '',
      ].join('')
      return `
      <li class="tile ${b.hasFile ? '' : 'is-away'}" data-id="${b.id}" style="--i:${Math.min(list.indexOf(b), 18)}">
        <button class="tile-open" aria-label="${esc(b.title)}">
          <div class="tile-cover">
            ${coverHTML(b)}
            ${badges ? `<div class="badges">${badges}</div>` : ''}
            ${notes ? `<span class="tile-notes" title="${notes} subrayados">${icon('notes')}${notes}</span>` : ''}
            ${b.hasFile ? '' : `<span class="tile-away" title="No está en este dispositivo">${icon('cloud')}</span>`}
            ${pct || b.finished ? `<div class="tile-bar"><span style="width:${b.finished ? 100 : pct}%"></span></div>` : ''}
          </div>
        </button>
        <div class="tile-info">
          <div class="tile-text">
            <h3 class="tile-title">${esc(b.title)}</h3>
            <p class="tile-sub">${b.finished ? 'Terminado' : pct ? `${pct} %` : b.toRead ? 'Por leer' : esc(b.author || b.format.toUpperCase())}</p>
          </div>
          <button class="icon-btn sm" data-act="more" title="Más opciones">${icon('more')}</button>
        </div>
      </li>`
    }).join('')}</ul>`
    $$('.tile', main).forEach(li => {
      const b = list.find(x => x.id === li.dataset.id)
      $('.tile-open', li).onclick = () => openBook(b.id)
      $('[data-act=more]', li).onclick = e => bookMenu(e.currentTarget, b, true)
    })
  }

  function renderQuotes(books, anns) {
    const byId = new Map(books.map(b => [b.id, b]))
    let quotes = anns.filter(a => a.kind === 'highlight' && byId.has(a.bookId))
    if (query) quotes = quotes.filter(a => `${a.text} ${a.note} ${byId.get(a.bookId).title}`.toLowerCase().includes(query))
    if (!quotes.length) {
      main.innerHTML = `<p class="empty-note">${query ? 'Nada coincide con la búsqueda.' : 'Acá van a aparecer todos tus subrayados y notas, de todos los libros.'}</p>`
      return
    }
    const groups = new Map()
    for (const q of quotes) {
      if (!groups.has(q.bookId)) groups.set(q.bookId, [])
      groups.get(q.bookId).push(q)
    }
    main.innerHTML = [...groups.entries()].map(([bookId, qs]) => {
      const b = byId.get(bookId)
      return `
        <section class="quote-group">
          <h2 class="quote-book">${esc(b.title)}<small>${esc(b.author)}</small></h2>
          <ul class="ann-list">${qs.map(a => `
            <li class="ann" style="--c:${COLORS[a.color] ?? COLORS.amarillo}">
              <button class="ann-go" data-book="${bookId}" data-ann="${a.id}">
                <span class="ann-meta">${esc(a.label || '')}${a.label ? ' · ' : ''}${new Date(a.createdAt).toLocaleDateString('es-AR')}</span>
                <span class="ann-text">${esc(a.text)}</span>
                ${a.note ? `<span class="ann-note">${esc(a.note)}</span>` : ''}
                ${a.unplaced ? `<span class="ann-tag">De ReadEra · sin marcar en la página</span>` : ''}
              </button>
            </li>`).join('')}</ul>
        </section>`
    }).join('')
    $$('.ann-go', main).forEach(b => b.onclick = () => openBook(b.dataset.book, b.dataset.ann))
  }

  // ---------- Menú del libro ----------
  function bookMenu(anchor, b, withStates = false) {
    $('.menu-pop')?.remove()
    const r = anchor.getBoundingClientRect()
    const menu = h(`
      <div class="menu-pop" role="menu">
        ${withStates ? `
        <div class="menu-head"><strong>${esc(b.title)}</strong>${b.author ? `<span>${esc(b.author)}</span>` : ''}</div>
        <button data-m="fav">${b.favorite ? 'Quitar de favoritos' : 'Agregar a favoritos'}</button>
        <button data-m="toread">${b.toRead && !b.finished ? 'Quitar de Por leer' : 'Agregar a Por leer'}</button>
        <button data-m="done">${b.finished ? 'Marcar como no terminado' : 'Marcar como terminado'}</button>
        <button data-m="notes">Ver sus citas</button>
        <hr />` : ''}
        <button data-m="edit">Editar nombre y descripción</button>
        ${b.fileKind === 'copia' ? `<button data-m="local">Quitar de este dispositivo</button>` : ''}
        <button data-m="delete" class="danger">Eliminar de la biblioteca</button>
      </div>`)
    document.body.append(menu)
    menu.style.top = `${Math.min(window.innerHeight - menu.offsetHeight - 8, r.bottom + 4)}px`
    menu.style.left = `${Math.max(8, r.right - menu.offsetWidth)}px`
    const close = () => { menu.remove(); document.removeEventListener('pointerdown', outside, true) }
    const outside = e => { if (!menu.contains(e.target)) close() }
    setTimeout(() => document.addEventListener('pointerdown', outside, true))
    $('[data-m=edit]', menu).onclick = () => { close(); editBook(b) }
    $('[data-m=fav]', menu)?.addEventListener('click', async () => { close(); await updateBook(b.id, { favorite: !b.favorite }); render() })
    $('[data-m=toread]', menu)?.addEventListener('click', async () => {
      close()
      const on = !(b.toRead && !b.finished)
      await updateBook(b.id, on ? { toRead: true, finished: false } : { toRead: false }); render()
    })
    $('[data-m=done]', menu)?.addEventListener('click', async () => {
      close(); await updateBook(b.id, b.finished ? { finished: false } : { finished: true, toRead: false }); render()
    })
    $('[data-m=notes]', menu)?.addEventListener('click', () => { close(); filter = 'citas'; query = b.title.toLowerCase(); render() })
    $('[data-m=local]', menu)?.addEventListener('click', async () => {
      close()
      const ok = await confirmDialog({ title: 'Quitar de este dispositivo', body: 'Se borra el archivo de acá. El progreso, las notas y los subrayados quedan en tu cuenta.', ok: 'Quitar' })
      if (ok) { await removeLocalFile(b.id); render() }
    })
    $('[data-m=delete]', menu).onclick = async () => {
      close()
      const native = platform.isNative && platform.deleteOriginal && b.fileKind === 'carpeta'
      const res = await confirmDialog({
        title: 'Eliminar libro',
        body: `Se elimina "${b.title}" de la biblioteca, con todas sus notas y subrayados, en todos tus dispositivos.`,
        check: native ? 'Borrar también el archivo de la carpeta del celu' : null,
        hint: native ? '' : (b.hasFile ? 'La copia guardada en este navegador se borra. El archivo original en tu computadora no se toca: el navegador no tiene permiso para eso.' : ''),
        ok: 'Eliminar', danger: true,
      })
      const ok = native ? res.ok : res
      if (!ok) return
      if (native && res.checked) {
        const done = await platform.deleteOriginal(b.id).catch(() => false)
        if (!done) toast('No se pudo borrar el archivo original')
      }
      await deleteBook(b.id)
      toast('Libro eliminado')
      render()
    }
  }

  // ---------- Editar nombre y descripción ----------
  function editBook(b) {
    const sheet = h(`
      <div class="modal-backdrop">
        <form class="modal edit-book">
          <h2 class="modal-title">Editar libro</h2>
          <label>Nombre<input name="title" required maxlength="200" value="${esc(b.title)}" /></label>
          <label>Autor<input name="author" maxlength="200" value="${esc(b.author)}" /></label>
          <label>Descripción<textarea name="description" rows="5" maxlength="2000" placeholder="De qué trata, por qué lo leés, quién te lo recomendó…">${esc(b.description ?? '')}</textarea></label>
          <p class="modal-hint">Archivo: ${esc(b.fileName || '')}. Los cambios se sincronizan con tus otros dispositivos; el archivo no se modifica.</p>
          <div class="modal-actions">
            <button type="button" class="btn-text" data-act="cancel">Cancelar</button>
            <button type="submit" class="btn-filled">Guardar</button>
          </div>
        </form>
      </div>`)
    const close = () => sheet.remove()
    sheet.addEventListener('click', e => { if (e.target === sheet) close() })
    $('[data-act=cancel]', sheet).onclick = close
    $('form', sheet).onsubmit = async e => {
      e.preventDefault()
      const data = Object.fromEntries(new FormData(e.target))
      const title = data.title.trim()
      if (!title) return
      await updateBook(b.id, { title, author: data.author.trim(), description: data.description.trim() })
      close()
      toast('Libro actualizado')
      render()
    }
    document.body.append(sheet)
    $('input[name=title]', sheet).focus()
  }

  // ---------- Panel de cuenta ----------
  function openAccount() {
    const s = sync.state
    const signedIn = !!sync.user
    const sheet = h(`
      <div class="modal-backdrop">
        <div class="modal account">
          <h2 class="modal-title">Cuenta</h2>
          ${s === 'off' ? `<p class="modal-body">La sincronización no está configurada. La biblioteca funciona solo en este dispositivo.</p>`
          : signedIn ? `
            <p class="modal-body"><strong>${esc(sync.user.email)}</strong></p>
            <p class="sync-state" data-state="${s}">${STATE_LABEL[s]}${sync.lastError && s === 'error' ? `<br><small>${esc(sync.lastError)}</small>` : ''}</p>
            <p class="modal-hint">Se sincronizan el progreso, los subrayados, las notas y los marcadores. Los archivos de los libros quedan en cada dispositivo.</p>
            <div class="modal-actions">
              <button class="btn-text" data-act="sync">Sincronizar ahora</button>
              <button class="btn-text" data-act="logout">Cerrar sesión</button>
              <button class="btn-filled" data-act="close">Listo</button>
            </div>`
          : `
            <button class="btn-google" data-act="google">
              <svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
              Continuar con Google
            </button>
            <div class="or"><span>o con tu correo</span></div>
            <form class="login">
              <label>Correo<input type="email" name="email" autocomplete="email" required /></label>
              <label>Contraseña<input type="password" name="password" autocomplete="current-password" minlength="6" required /></label>
              <p class="form-error" hidden></p>
              <div class="modal-actions">
                <button type="button" class="btn-text" data-act="reset">Olvidé la contraseña</button>
                <button type="button" class="btn-text" data-act="signup">Crear cuenta</button>
                <button type="submit" class="btn-filled">Ingresar</button>
              </div>
            </form>`}
        </div>
      </div>`)
    const close = () => sheet.remove()
    sheet.addEventListener('click', e => { if (e.target === sheet) close() })
    document.body.append(sheet)
    $('[data-act=close]', sheet)?.addEventListener('click', close)
    $('[data-act=sync]', sheet)?.addEventListener('click', () => { syncNow(); toast('Sincronizando…'); close() })
    $('[data-act=logout]', sheet)?.addEventListener('click', async () => { await signOut(); close(); toast('Sesión cerrada') })
    const form = $('form.login', sheet)
    if (!form) return
    const err = $('.form-error', sheet)
    $('[data-act=google]', sheet).onclick = async () => {
      err.hidden = true
      try { await signInWithGoogle(); close(); toast('Listo: sincronizando tu biblioteca') }
      catch (e) { if (!e.cancelled) { err.textContent = e.message; err.hidden = false } }
    }
    const run = async fn => {
      err.hidden = true
      const { email, password } = Object.fromEntries(new FormData(form))
      try { await fn(email.trim(), password); close(); toast('Listo: sincronizando tu biblioteca') }
      catch (e) { err.textContent = e.message; err.hidden = false }
    }
    form.onsubmit = e => { e.preventDefault(); run(signIn) }
    $('[data-act=signup]', sheet).onclick = () => { if (form.reportValidity()) run(signUp) }
    $('[data-act=reset]', sheet).onclick = async () => {
      const email = form.email.value.trim()
      if (!email) { err.textContent = 'Escribí tu correo primero.'; err.hidden = false; return }
      try { await resetPassword(email); toast('Te mandamos un correo para cambiarla') }
      catch (e) { err.textContent = e.message; err.hidden = false }
    }
  }

  // Re-render cuando cambian datos (incluye lo que llega de otros dispositivos)
  let t
  const onChange = e => {
    if (!['books', 'annotations', 'files'].includes(e.detail.store)) return
    clearTimeout(t)
    t = setTimeout(render, 250)
  }
  changes.addEventListener('change', onChange)

  await render()
  setTimeout(() => main.classList.remove('is-first'), 900) // la aparición escalonada solo al entrar
  if (isNative && Date.now() - lastScan > 20000) runScan({ quiet: true })

  // Tirar hacia abajo para actualizar (celu): vuelve a buscar en las carpetas y sincroniza
  const detachPtr = attachPullToRefresh($('.ptr', el), async () => {
    if (sync.user) syncNow()
    if (isNative) await runScan({ quiet: false })
    else { await render(); toast(sync.user ? 'Biblioteca sincronizada' : 'Biblioteca actualizada') }
  })
  return () => {
    detachPtr()
    document.removeEventListener('visibilitychange', onVisible)
    changes.removeEventListener('readera-applied', onReadEra)
    changes.removeEventListener('change', onChange)
    sync.removeEventListener('state', paintAccount)
    sync.removeEventListener('auth-error', onAuthError)
    $('.menu-pop')?.remove()
  }
}
