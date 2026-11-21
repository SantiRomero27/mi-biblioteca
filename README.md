# Mi biblioteca

Lector personal de **PDF y EPUB** con subrayados, notas, marcadores y progreso sincronizados entre la web y el celu.

## Cómo está armado

| Parte | Qué usa |
|---|---|
| EPUB | [foliate-js](https://github.com/johnfactotum/foliate-js) (en `src/vendor/foliate`). Posiciones con EPUB CFI. |
| PDF | [pdf.js](https://github.com/mozilla/pdf.js) con lector propio (`src/reader/pdf-engine.js`). Subrayados como rectángulos relativos a la página. |
| Datos locales | IndexedDB escrito a mano (`src/db.js`): archivos, libros, anotaciones, ajustes. |
| Cuenta y sync | Firebase Auth (correo/contraseña) + Firestore, plan gratuito Spark (`src/sync.js`). |
| Tipografía | Identidad en Lato; lectura de EPUB en Archivo (o Lato, o una fuente propia). Todo auto-alojado: funciona sin conexión. |

**Identidad de cada libro:** huella SHA-256 de tamaño + primeros y últimos 2 MB del archivo (`fingerprint()` en `src/books.js`). El mismo archivo en el celu y en la PC tiene el mismo ID, aunque tenga otro nombre o esté en otra carpeta.

**Qué se sincroniza:** metadatos, progreso, subrayados, notas y marcadores. **Qué no:** los archivos de los libros y las portadas (quedan en cada dispositivo).

**Conflictos:** cada registro tiene `updatedAt`; gana el cambio más reciente. Los cambios hechos sin conexión quedan marcados (`_dirty`) y se suben al volver la conexión.

## Desarrollo

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # genera dist/
```

## Firebase

1. Authentication → Correo electrónico/contraseña → habilitado.
2. Firestore → Reglas → pegar el contenido de `firestore.rules` → Publicar.

## Publicación

Cada push a `main` publica la web en GitHub Pages (`.github/workflows/deploy-web.yml`).
En el repo: Settings → Pages → Source: **GitHub Actions**.
