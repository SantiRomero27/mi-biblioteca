// Sincronización con Firebase (plan gratuito Spark: Auth + Firestore).
// Estrategia: cada registro tiene updatedAt; gana el cambio más reciente.
// Los cambios locales quedan marcados con _dirty hasta que la nube los confirma,
// así nada se pierde si leés sin conexión.
import { initializeApp } from 'firebase/app'
import {
  getAuth, initializeAuth, indexedDBLocalPersistence, signInWithCredential, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut as fbSignOut, sendPasswordResetEmail,
  GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
} from 'firebase/auth'
import { getFirestore, collection, doc, onSnapshot, writeBatch } from 'firebase/firestore'
import { firebaseConfig, googleWebClientId } from './firebase-config.js'
import { isNative, nativeGoogleToken } from './native.js'
import { db, changes } from './db.js'

const STORES = ['books', 'annotations']

export const sync = new EventTarget()
sync.state = 'off'     // off | signed-out | syncing | ok | offline | error
sync.user = null
sync.lastError = ''

const setState = (state, err = '') => {
  sync.state = state
  sync.lastError = err
  sync.dispatchEvent(new Event('state'))
}

let auth, fs, uid = null
let unsubs = []
let pushTimer = null
let pushing = false

export function initSync() {
  if (!firebaseConfig?.apiKey) return setState('off')
  const app = initializeApp(firebaseConfig)
  // En Android no hay ventanas emergentes ni redirecciones: sesión guardada en IndexedDB y login nativo
  auth = isNative ? initializeAuth(app, { persistence: indexedDBLocalPersistence }) : getAuth(app)
  fs = getFirestore(app)
  setState('signed-out')
  // Si el ingreso con Google fue por redirección (web), acá se completa
  if (!isNative) getRedirectResult(auth).catch(e => {
    sync.lastError = friendly(e)
    sync.dispatchEvent(new Event('auth-error'))
  })
  onAuthStateChanged(auth, user => {
    stop()
    sync.user = user
    if (user) start(user)
    else setState('signed-out')
  })
  changes.addEventListener('change', e => {
    const { store, value, origin } = e.detail
    if (origin === 'local' && STORES.includes(store) && value?._dirty) schedulePush()
  })
  window.addEventListener('online', () => { if (uid) { setState('syncing'); schedulePush(0) } })
  window.addEventListener('offline', () => { if (uid) setState('offline') })
}

function start(user) {
  uid = user.uid
  setState(navigator.onLine ? 'syncing' : 'offline')
  for (const store of STORES) {
    const ref = collection(fs, 'users', uid, store)
    unsubs.push(onSnapshot(ref, { includeMetadataChanges: false }, snap => merge(store, snap), err => {
      console.error(err)
      setState('error', err.message)
    }))
  }
  schedulePush(0)
}

function stop() {
  unsubs.forEach(u => u())
  unsubs = []
  uid = null
}

// ---------- Bajar ----------
async function merge(store, snap) {
  for (const change of snap.docChanges()) {
    if (change.type === 'removed') continue
    const remote = change.doc.data()
    const local = await db.get(store, remote.id)
    if (!local || (remote.updatedAt ?? 0) > (local.updatedAt ?? 0)) {
      const next = { ...remote, _dirty: false }
      if (store === 'books') next.cover = local?.cover ?? null // la portada vive solo en el dispositivo
      await db.put(store, next, 'remote')
    } else if ((local.updatedAt ?? 0) > (remote.updatedAt ?? 0) && !local._dirty) {
      await db.put(store, { ...local, _dirty: true }, 'local')
    }
  }
  if (!pushing && navigator.onLine) setState('ok')
}

// ---------- Subir ----------
const clean = (store, rec) => {
  const { _dirty, cover, hasFile, ...rest } = rec
  return JSON.parse(JSON.stringify(rest))
}

function schedulePush(delay = 900) {
  if (!uid) return
  clearTimeout(pushTimer)
  pushTimer = setTimeout(pushDirty, delay)
}

async function pushDirty() {
  if (!uid || pushing) return
  if (!navigator.onLine) return setState('offline')
  pushing = true
  try {
    const pending = []
    for (const store of STORES) {
      for (const rec of await db.all(store)) if (rec._dirty) pending.push([store, rec])
    }
    if (pending.length) setState('syncing')
    // Firestore admite hasta 500 escrituras por lote
    for (let i = 0; i < pending.length; i += 400) {
      const chunk = pending.slice(i, i + 400)
      const batch = writeBatch(fs)
      for (const [store, rec] of chunk) batch.set(doc(fs, 'users', uid, store, rec.id), clean(store, rec))
      await batch.commit()
      for (const [store, rec] of chunk) {
        const now = await db.get(store, rec.id)
        if (now && now.updatedAt === rec.updatedAt) await db.put(store, { ...now, _dirty: false }, 'sync')
      }
    }
    setState('ok')
  } catch (err) {
    console.error(err)
    setState(navigator.onLine ? 'error' : 'offline', err.message)
  } finally {
    pushing = false
  }
}

// ---------- Cuenta ----------
const ERRORS = {
  'auth/invalid-email': 'El correo no es válido.',
  'auth/missing-password': 'Falta la contraseña.',
  'auth/weak-password': 'La contraseña tiene que tener al menos 6 caracteres.',
  'auth/email-already-in-use': 'Ya existe una cuenta con ese correo. Probá ingresar.',
  'auth/invalid-credential': 'Correo o contraseña incorrectos.',
  'auth/user-not-found': 'No hay una cuenta con ese correo.',
  'auth/wrong-password': 'Contraseña incorrecta.',
  'auth/too-many-requests': 'Demasiados intentos. Esperá un rato y probá de nuevo.',
  'auth/network-request-failed': 'Sin conexión. Probá cuando tengas internet.',
  'auth/operation-not-allowed': 'Ese método de ingreso no está habilitado en Firebase (Authentication → Método de acceso).',
  'auth/unauthorized-domain': 'Este dominio no está autorizado en Firebase (Authentication → Configuración → Dominios autorizados).',
  'auth/account-exists-with-different-credential': 'Ese correo ya tiene cuenta con contraseña. Ingresá con correo y contraseña.',
  'auth/popup-closed-by-user': '',
  'auth/cancelled-popup-request': '',
}
const friendly = err => ERRORS[err?.code] ?? err?.message ?? 'Algo salió mal.'

export async function signIn(email, password) {
  try { await signInWithEmailAndPassword(auth, email, password) }
  catch (e) { throw new Error(friendly(e)) }
}
// Google: ventana emergente; si el navegador la bloquea, redirección a la página de Google
export async function signInWithGoogle() {
  if (isNative) {
    if (!googleWebClientId) throw new Error('Falta configurar el ID de cliente web de Google en la app.')
    try {
      const idToken = await nativeGoogleToken(googleWebClientId)
      await signInWithCredential(auth, GoogleAuthProvider.credential(idToken))
      return
    } catch (e) {
      if (e?.message === 'cancelled' || e?.code === 'cancelled') throw Object.assign(new Error(''), { cancelled: true })
      throw new Error(friendly(e) || e?.message || 'No se pudo ingresar con Google')
    }
  }
  const provider = new GoogleAuthProvider()
  provider.setCustomParameters({ prompt: 'select_account' })
  try {
    await signInWithPopup(auth, provider)
  } catch (e) {
    if (e?.code === 'auth/popup-blocked' || e?.code === 'auth/operation-not-supported-in-this-environment') {
      return signInWithRedirect(auth, provider)
    }
    const msg = friendly(e)
    if (msg) throw new Error(msg)
    throw Object.assign(new Error(''), { cancelled: true })
  }
}

export async function signUp(email, password) {
  try { await createUserWithEmailAndPassword(auth, email, password) }
  catch (e) { throw new Error(friendly(e)) }
}
export async function resetPassword(email) {
  try { await sendPasswordResetEmail(auth, email) }
  catch (e) { throw new Error(friendly(e)) }
}
export const signOut = () => fbSignOut(auth)
export const syncNow = () => schedulePush(0)
