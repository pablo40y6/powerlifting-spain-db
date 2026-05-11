# Powerlifting Spain DB

Web estática para consultar resultados publicados en Powerlifting Spain. El scraper/crawler sigue siendo Node.js, pero solo se ejecuta en local o en GitHub Actions para generar `data/index.json`; la web publicada en GitHub Pages no necesita Express ni un servidor Node.

## Estructura

```text
scraper/                 crawler, parser, utilidades y CLI de indexación
web/                     HTML, CSS y JS estáticos
data/                    contiene `index.json` generado (ignorado por git)
dist/                    salida publicable en GitHub Pages (ignorada por git)
tests/                   regresiones del parser
.github/workflows/       actualización semanal/manual y deploy a Pages
```

## Requisitos

- Node.js 20 o superior para desarrollo local.
- No se usa OpenIPF como fuente externa.
- No se usa Excel COM.
- LibreOffice solo queda como fallback opcional del parser y no bloquea la indexación si no existe.

## Comandos principales

```bash
npm ci
npm run build:index
npm run build:web
npm run audit:index
npm test
```

- `npm run build:index` recorre PowerliftingSpain, descarga PDFs/Excels a una carpeta temporal del sistema, parsea los documentos y escribe `data/index.json`.
- `npm run build:web` copia `web/index.html`, `web/app.js`, `web/styles.css` y `data/index.json` a `dist/`.
- `npm run audit:index` analiza `data/index.json`, imprime un resumen de calidad de datos y genera `data/audit-report.json` y `data/audit-report.md`; por defecto no falla si encuentra warnings.
- `npm run audit:index -- --strict` devuelve exit code 1 si la auditoría encuentra errores críticos.
- `npm test` ejecuta pruebas de regresión sobre casos problemáticos del parser y helpers de auditoría.

## Desarrollo local

Para probar la web estática con los mismos archivos que se publicarán:

```bash
npm run build:index
npm run build:web
npx serve dist
```

También se mantiene el arranque local Express para compatibilidad:

```bash
npm start
```

`npm start` sirve la carpeta `web/` y conserva los endpoints locales de API para quien los siga usando, pero producción en GitHub Pages lee directamente `data/index.json`.

## GitHub Pages

El workflow `.github/workflows/update-and-deploy.yml` se puede lanzar manualmente (`workflow_dispatch`) y también corre semanalmente. Sus pasos son:

1. instalar Node;
2. ejecutar `npm ci`;
3. ejecutar `npm test`;
4. ejecutar `npm run build:index`;
5. ejecutar `npm run build:web`;
6. publicar `dist/` con GitHub Pages.

## Datos y cachés

No se versionan documentos descargados ni salidas generadas:

- `data/index.json` se genera en cada build;
- `data/audit-report.json` y `data/audit-report.md` se generan con `npm run audit:index`;
- `dist/` se genera para Pages;
- `cache/` queda ignorado por compatibilidad histórica;
- las descargas del scraper van por defecto a `os.tmpdir()` o a `PLS_DOCS_DIR` si se define.
