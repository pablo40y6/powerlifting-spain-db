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


## Ranking Top 50 vigente

La web ofrece dos vistas, Buscador y Ranking Top 50. El ranking reúne hasta 50
atletas por sexo, categoría de peso y equipamiento. Selecciona la mejor marca de
cada atleta para el criterio elegido. Total, IPF GL, sentadilla y peso muerto
usan resultados completos. Banca reúne los mejores levantamientos válidos de
powerlifting completo y banca sola con el mismo equipamiento.

La ventana se calcula para el día de España con 18 meses naturales y conserva
la marca hasta el día de vencimiento inclusive. Al caducar una marca, el
ranking toma la siguiente mejor que siga vigente. Si la fuente solo publica un
intervalo, la web identifica el día de inicio como referencia. Los resultados
internacionales se incorporan al historial desde 2021 cuando la fuente identifica
al atleta con España. La importación parte de las fichas de Mundiales y Europeos
del [calendario de Powerlifting Spain](https://powerliftingspain.es/campeonatos-ano-2026/).
Da prioridad a las actas que publica la AEP y enlaza sus fichas a las marcas
obtenidas del [portal oficial de la IPF](https://ipf.powerlifting.sport/results)
y de los archivos abiertos IPF y EPF de [OpenPowerlifting](https://gitlab.com/openpowerlifting/opl-data).
En el archivo abierto los
puntos GL se calculan con [la fórmula oficial de la IPF](https://www.powerlifting.sport/rules/codes/info/ipf-formula).

La [normativa AEP de 2025](https://powerliftingspain.es/wp-content/uploads/2025/02/Campeonatos_Clasificacion_2025-02-25.pdf)
define la marca histórica como el mejor total obtenido en competición AEP. La
[Guía AEP 2026](https://powerliftingspain.es/wp-content/uploads/2025/12/GUIA-AEP-1.pdf)
establece una mínima regional permanente y una mínima nacional con 18 meses de
vigencia. Para el Open también se aplican requisitos sobre pruebas admitidas,
temporada y plazas. Los campeonatos internacionales reconocidos por la EPF o la
IPF figuran entre las pruebas admitidas por la guía para acreditar la mínima Open.
La vigencia que muestra el Top 50 se refiere a su ventana temporal. Cada
convocatoria determina los requisitos definitivos de inscripción.
