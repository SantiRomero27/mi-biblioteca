// Biblioteca: lista de libros estilo ReadEra, filtros, citas y cuenta.
import { $, $$, h, esc, toast, confirmDialog } from './ui/dom.js'
import { icon } from './ui/icons.js'
import { changes } from './db.js'
import {
  listBooks, importFile, updateBook, deleteBook, removeLocalFile, listAnnotations, formatSize, COLORS,
} from './books.js'
import { sync, signIn, signUp, signOut, resetPassword, syncNow } from './sync.js'

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
          <button class="icon-btn" data-act="search" title="Buscar">${icon('search')}</button>
          <label class="icon-btn" title="Agregar libros">${icon('add')}
            <input type="file" accept=".pdf,.epub,application/pdf,application/epub+zip" multiple hidden data-add />
          </label>
          <button class="icon-btn account-btn" data-act="account" title="Cuenta y sincronización"></button>
        </div>
        <div class="lib-search" hidden>
          <input type="search" placeholder="Buscar por título o autor" />
        </div>
        <nav class="chips"></nav>
      </header>
      <main class="lib-main"></main>
      <div class="drop-hint">${icon('upload')}<span>Soltá los PDF o EPUB para agregarlos</span></div>
    </div>`)
  root.replaceChildren(el)

  const main = $('.lib-main', el)

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
  accountBtn.onclick = openAccount

  // ---------- Render ----------
  async function render() {
    const [books, anns] = await Promise.all([listBooks(), listAnnotations()])
    const notesBy = new Map()
    for (const a of anns) if (a.kind === 'highlight') notesBy.set(a.bookId, (notesBy.get(a.bookId) ?? 0) + 1)

    const counts = {
      todos: books.length,
      leyendo: books.filter(b => !b.finished && (b.progress?.fraction ?? 0) > 0).length,
      favoritos: books.filter(b => b.favorite).length,
      terminados: books.filter(b => b.finished).length,
      citas: anns.filter(a => a.kind === 'highlight' && books.some(b => b.id === a.bookId)).length,
    }
    const chips = [['todos', 'Todos'], ['leyendo', 'Leyendo'], ['favoritos', 'Favoritos'], ['terminados', 'Terminados'], ['citas', 'Citas']]
    $('.chips', el).innerHTML = chips.map(([k, l]) =>
      `<button class="chip ${filter === k ? 'is-active' : ''}" data-f="${k}">${l}<span>${counts[k]}</span></button>`).join('')
    $$('.chip', el).forEach(c => c.onclick = () => { filter = c.dataset.f; render() })

    if (filter === 'citas') return renderQuotes(books, anns)

    let list = books
    if (filter === 'leyendo') list = list.filter(b => !b.finished && (b.progress?.fraction ?? 0) > 0)
    if (filter === 'favoritos') list = list.filter(b => b.favorite)
    if (filter === 'terminados') list = list.filter(b => b.finished)
    if (query) list = list.filter(b => `${b.title} ${b.author}`.toLowerCase().includes(query))
    list.sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0) || b.addedAt - a.addedAt)

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

    main.innerHTML = `<ul class="books">${list.map(b => {
      const pct = Math.round((b.progress?.fraction ?? 0) * 100)
      const notes = notesBy.get(b.id) ?? 0
      return `
      <li class="book" data-id="${b.id}">
        <button class="book-open">
          ${coverHTML(b)}
          <div class="book-info">
            <h3 class="book-title">${esc(b.title)}</h3>
            ${b.author ? `<p class="book-author">${esc(b.author)}</p>` : ''}
            <p class="book-meta">${b.format.toUpperCase()}${b.size ? ' · ' + formatSize(b.size) : ''}${b.hasFile ? '' : ' · <span class="not-here">no está en este dispositivo</span>'}</p>
            <div class="book-progress">
              <div class="bar"><span style="width:${b.finished ? 100 : pct}%"></span></div>
              <span class="pct">${b.finished ? 'Terminado' : pct ? pct + ' %' : 'Sin empezar'}</span>
            </div>
          </div>
        </button>
        <div class="book-actions">
          <button class="icon-btn sm ${b.favorite ? 'is-on' : ''}" data-act="fav" title="Favorito">${icon(b.favorite ? 'star' : 'starOutline')}</button>
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
      $('[data-act=done]', li).onclick = async () => { await updateBook(id, { finished: !b.finished }); render() }
      $('[data-act=notes]', li).onclick = () => { filter = 'citas'; query = b.title.toLowerCase(); render() }
      $('[data-act=more]', li).onclick = e => bookMenu(e.currentTarget, b)
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
              </button>
            </li>`).join('')}</ul>
        </section>`
    }).join('')
    $$('.ann-go', main).forEach(b => b.onclick = () => openBook(b.dataset.book, b.dataset.ann))
  }

  // ---------- Menú del libro ----------
  function bookMenu(anchor, b) {
    $('.menu-pop')?.remove()
    const r = anchor.getBoundingClientRect()
    const menu = h(`
      <div class="menu-pop" role="menu">
        ${b.hasFile ? `<button data-m="local">Quitar de este dispositivo</button>` : ''}
        <button data-m="delete" class="danger">Eliminar de la biblioteca</button>
      </div>`)
    document.body.append(menu)
    menu.style.top = `${Math.min(window.innerHeight - menu.offsetHeight - 8, r.bottom + 4)}px`
    menu.style.left = `${Math.max(8, r.right - menu.offsetWidth)}px`
    const close = () => { menu.remove(); document.removeEventListener('pointerdown', outside, true) }
    const outside = e => { if (!menu.contains(e.target)) close() }
    setTimeout(() => document.addEventListener('pointerdown', outside, true))
    $('[data-m=local]', menu)?.addEventListener('click', async () => {
      close()
      const ok = await confirmDialog({ title: 'Quitar de este dispositivo', body: 'Se borra el archivo de acá. El progreso, las notas y los subrayados quedan en tu cuenta.', ok: 'Quitar' })
      if (ok) { await removeLocalFile(b.id); render() }
    })
    $('[data-m=delete]', menu).onclick = async () => {
      close()
      const ok = await confirmDialog({ title: 'Eliminar libro', body: `Se elimina "${b.title}" con todas sus notas y subrayados, en todos tus dispositivos.`, ok: 'Eliminar', danger: true })
      if (ok) { await deleteBook(b.id); render() }
    }
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
  return () => {
    changes.removeEventListener('change', onChange)
    sync.removeEventListener('state', paintAccount)
    $('.menu-pop')?.remove()
  }
}
