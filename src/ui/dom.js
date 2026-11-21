// Ayudas mínimas de DOM
export const $ = (sel, root = document) => root.querySelector(sel)
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel))

export const h = (html) => {
  const t = document.createElement('template')
  t.innerHTML = html.trim()
  return t.content.firstElementChild
}

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

let toastTimer
export function toast(msg) {
  let el = $('#toast')
  if (!el) {
    el = h('<div id="toast" role="status"></div>')
    document.body.append(el)
  }
  el.textContent = msg
  el.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600)
}

// Diálogo simple para notas. Devuelve el texto o null si se cancela.
export function promptNote({ title = 'Nota', quote = '', value = '' } = {}) {
  return new Promise(resolve => {
    const el = h(`
      <div class="modal-backdrop">
        <form class="modal" method="dialog">
          <h2 class="modal-title">${esc(title)}</h2>
          ${quote ? `<blockquote class="modal-quote">${esc(quote.length > 280 ? quote.slice(0, 280) + '…' : quote)}</blockquote>` : ''}
          <textarea class="modal-text" rows="5" placeholder="Escribí tu nota…">${esc(value)}</textarea>
          <div class="modal-actions">
            <button type="button" class="btn-text" data-act="cancel">Cancelar</button>
            <button type="submit" class="btn-filled">Guardar</button>
          </div>
        </form>
      </div>`)
    const done = v => { el.remove(); resolve(v) }
    el.addEventListener('click', e => { if (e.target === el) done(null) })
    $('[data-act=cancel]', el).onclick = () => done(null)
    $('form', el).onsubmit = e => { e.preventDefault(); done($('textarea', el).value.trim()) }
    document.body.append(el)
    $('textarea', el).focus()
  })
}

export function confirmDialog({ title, body, ok = 'Aceptar', danger = false }) {
  return new Promise(resolve => {
    const el = h(`
      <div class="modal-backdrop">
        <div class="modal">
          <h2 class="modal-title">${esc(title)}</h2>
          <p class="modal-body">${esc(body)}</p>
          <div class="modal-actions">
            <button class="btn-text" data-act="cancel">Cancelar</button>
            <button class="btn-filled ${danger ? 'danger' : ''}" data-act="ok">${esc(ok)}</button>
          </div>
        </div>
      </div>`)
    const done = v => { el.remove(); resolve(v) }
    el.addEventListener('click', e => { if (e.target === el) done(false) })
    $('[data-act=cancel]', el).onclick = () => done(false)
    $('[data-act=ok]', el).onclick = () => done(true)
    document.body.append(el)
  })
}
