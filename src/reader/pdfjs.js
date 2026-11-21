// Carga de pdf.js con su worker y recursos empaquetados (funciona offline).
import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

export { pdfjsLib }

// Carpeta con wasm (JBIG2 / JPEG 2000 de los escaneos), cmaps y fuentes estándar: ver scripts/copy-pdfjs.mjs
const assets = new URL('pdfjs/', document.baseURI).href

export async function loadPdf(file) {
  const data = new Uint8Array(await file.arrayBuffer())
  return pdfjsLib.getDocument({
    data,
    isEvalSupported: false,
    wasmUrl: `${assets}wasm/`,
    cMapUrl: `${assets}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${assets}standard_fonts/`,
    iccUrl: `${assets}iccs/`,
  }).promise
}

// En pdf.js 6 el documento se cierra desde su loadingTask
export const closePdf = pdf => pdf?.loadingTask?.destroy?.()
