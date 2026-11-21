// "Tirar para actualizar": al estar arriba de todo y arrastrar hacia abajo aparece un indicador;
// si se suelta pasando el umbral, se ejecuta onRefresh y el indicador gira hasta que termina.
const THRESHOLD = 72
const MAX = 120

export function attachPullToRefresh(indicator, onRefresh) {
  let startY = null, pull = 0, busy = false
  const set = (y, anim = false) => {
    indicator.style.transition = anim ? 'transform .25s ease, opacity .25s ease' : 'none'
    indicator.style.transform = `translate(-50%, ${y - 56}px) rotate(${y * 3}deg)`
    indicator.style.opacity = Math.min(1, y / THRESHOLD)
    indicator.classList.toggle('is-ready', y >= THRESHOLD)
  }
  const onStart = e => {
    if (busy || window.scrollY > 0 || e.touches.length !== 1) return
    if (e.target.closest('.modal-backdrop, .menu-pop, input, textarea')) return
    startY = e.touches[0].clientY
    pull = 0
  }
  const onMove = e => {
    if (startY === null) return
    const dy = e.touches[0].clientY - startY
    if (dy <= 0 || window.scrollY > 0) { if (pull) set(0); pull = 0; return }
    pull = Math.min(MAX, dy * 0.55) // resistencia
    if (e.cancelable) e.preventDefault()
    set(pull)
  }
  const onEnd = async () => {
    if (startY === null) return
    startY = null
    if (pull >= THRESHOLD) {
      busy = true
      set(THRESHOLD - 8, true)
      indicator.classList.add('is-spinning')
      try { navigator.vibrate?.(10) } catch { /* sin vibración */ }
      try { await onRefresh() } finally {
        indicator.classList.remove('is-spinning')
        set(0, true)
        busy = false
      }
    } else set(0, true)
    pull = 0
  }
  window.addEventListener('touchstart', onStart, { passive: true })
  window.addEventListener('touchmove', onMove, { passive: false })
  window.addEventListener('touchend', onEnd)
  window.addEventListener('touchcancel', onEnd)
  set(0)
  return () => {
    window.removeEventListener('touchstart', onStart)
    window.removeEventListener('touchmove', onMove)
    window.removeEventListener('touchend', onEnd)
    window.removeEventListener('touchcancel', onEnd)
  }
}
