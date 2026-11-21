// Copia a public/pdfjs los recursos que pdf.js carga aparte (y que tienen que estar disponibles sin conexión):
//  - wasm/: decodificadores de imágenes JBIG2 y JPEG 2000 (muy usados en libros escaneados)
//  - cmaps/: tipografías asiáticas y codificaciones especiales
//  - standard_fonts/: fuentes estándar para PDF que no las traen incluidas
//  - iccs/: perfiles de color
import { cpSync, rmSync, mkdirSync } from 'node:fs'
const src = 'node_modules/pdfjs-dist'
const dst = 'public/pdfjs'
rmSync(dst, { recursive: true, force: true })
mkdirSync(dst, { recursive: true })
for (const dir of ['wasm', 'cmaps', 'standard_fonts', 'iccs']) {
  cpSync(`${src}/${dir}`, `${dst}/${dir}`, { recursive: true, filter: p => !/LICENSE|quickjs/.test(p.split('/').pop()) || p.endsWith(dir) })
}
console.log('pdf.js: recursos copiados a public/pdfjs')
