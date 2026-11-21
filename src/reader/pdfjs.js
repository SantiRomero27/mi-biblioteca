// Carga de pdf.js con su worker empaquetado (funciona offline).
import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

export { pdfjsLib }

export async function loadPdf(file) {
  const data = new Uint8Array(await file.arrayBuffer())
  return pdfjsLib.getDocument({ data, isEvalSupported: false }).promise
}

// En pdf.js 6 el documento se cierra desde su loadingTask
export const closePdf = pdf => pdf?.loadingTask?.destroy?.()
