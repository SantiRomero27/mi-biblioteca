// Capacidades según dónde corre la app.
// En la web, el navegador no puede tocar archivos fuera de su almacenamiento.
// La app Android (Capacitor) registra acá sus funciones nativas: leer carpetas y borrar el archivo original.
export const platform = {
  isNative: false,
  // (bookId) => Promise<boolean> — borra el archivo original de la carpeta del dispositivo
  deleteOriginal: null,
}
