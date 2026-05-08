# Buscador local de competidores de Powerlifting Spain

Esta app crea un índice local con las competiciones publicadas en Powerlifting Spain y te deja buscar por nombre y apellidos para ver:

- qué competiciones ha hecho un atleta;
- los 9 intentos (sentadilla, banca y peso muerto);
- si cada intento fue válido o nulo;
- enlace a la página de la competición y al documento de resultados.

## Cómo funciona

1. El backend recorre las páginas de campeonatos por año.
2. Entra en cada página de competición.
3. Detecta documentos de resultados (`.pdf`, `.xls`, `.xlsx`).
4. Prioriza Excel cuando existe, porque suele traer mejor estructura.
5. Si no hay Excel, parsea el PDF.
6. Guarda un `data/index.json` local en tu PC.
7. El frontend busca dentro de ese índice.

## Requisitos

- Node.js 20 o superior.

## Arranque rápido

### Opción 1: Windows

1. Instala Node.js.
2. Abre una terminal dentro de la carpeta del proyecto.
3. Ejecuta:

```bash
npm install
npm start
```

4. Abre en el navegador:

```text
http://localhost:3000
```

### Opción 2: macOS / Linux

```bash
npm install
npm start
```

Y abre `http://localhost:3000`.

## Primer uso

1. Pulsa **Actualizar índice**.
2. Espera a que termine la indexación.
3. Busca un nombre y apellidos.

## Qué guarda en local

- `data/index.json`: el índice final.
- `cache/docs/`: copia local de los PDFs y Excel descargados.

## Limitaciones reales

La app está pensada para ser muy robusta, pero hay tres límites que dependen de cómo publique la web cada competición:

1. Si una competición no tiene documento de resultados enlazado, no hay nada que indexar.
2. Si un PDF viene muy mal maquetado o escaneado como imagen, el parser puede perder precisión.
3. Si hay dos atletas con el mismo nombre, tendrás que distinguirlos por club, fecha o categoría.

## Mejora futura recomendable

Si más adelante quieres subirla de nivel, el siguiente paso sería añadir:

- OCR para PDFs escaneados;
- base de datos SQLite;
- botón para exportar el historial a Word o Excel;
- filtros por club, año, categoría y sexo.
