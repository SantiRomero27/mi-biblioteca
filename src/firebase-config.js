// Configuración web de Firebase. Estos valores no son secretos: identifican el proyecto.
// La protección de los datos está en firestore.rules (cada usuario solo accede a lo suyo).
export const firebaseConfig = {
  apiKey: 'AIzaSyA2OvePgD78shWB0nE_vDUeUEpoY2Bv224',
  authDomain: 'mi-biblioteca-6bb5b.firebaseapp.com',
  projectId: 'mi-biblioteca-6bb5b',
  storageBucket: 'mi-biblioteca-6bb5b.firebasestorage.app',
  messagingSenderId: '401266204478',
  appId: '1:401266204478:web:de911a2c2b9a0fd7f2d66f',
}

// ID de cliente web de Google (Firebase → Authentication → Google → Configuración del SDK web).
// Lo usa el ingreso con Google nativo de la app Android.
export const googleWebClientId = ''
