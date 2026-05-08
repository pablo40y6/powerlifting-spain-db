const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const BaseXLSX = require('xlsx');
let XLSX;
try {
  // Optional: this fork reads XLSX styles more reliably. For old .xls files,
  // the parser can also convert them to .xlsx first so styles are preserved.
  XLSX = require('xlsx-js-style');
} catch {
  XLSX = BaseXLSX;
}
let CFBModule = null;
function getCFBModule() {
  if (CFBModule !== null) return CFBModule;
  try {
    CFBModule = require('cfb');
  } catch {
    // If xlsx-js-style is being used as XLSX, it may not expose CFB.
    // The base xlsx package normally does, and it is already a dependency.
    CFBModule = BaseXLSX.CFB || XLSX.CFB || null;
  }
  return CFBModule;
}
const { PDFParse } = require('pdf-parse');
const {
  attemptsFromValues,
  cleanCompetitionTitle,
  firstNonEmpty,
  formatDateISO,
  normalizeName,
  normalizeSpaces,
  parseLocaleNumber,
  parseSpanishDate,
} = require('./utils');

function buildCompetitionMeta(baseMeta = {}, partial = {}) {
  const name = cleanCompetitionTitle(
    partial.name ||
      baseMeta.pageTitle ||
      baseMeta.title ||
      'Competición sin nombre'
  );
  const subtitle = normalizeSpaces(partial.subtitle || baseMeta.subtitle || '');
  const locationDateText = normalizeSpaces(
    partial.locationDateText || baseMeta.locationDateText || ''
  );
  const parsedDate =
    partial.date ||
    baseMeta.date ||
    parseSpanishDate(locationDateText) ||
    parseSpanishDate(baseMeta.pageTitle || '') ||
    null;

  return {
    name,
    subtitle,
    locationDateText,
    date: formatDateISO(parsedDate),
    meetPageUrl: baseMeta.meetPageUrl || null,
    meetPageTitle: baseMeta.pageTitle || null,
    resultsUrl: baseMeta.resultsUrl || null,
    resultsLabel: baseMeta.resultsLabel || null,
    sourceType: baseMeta.sourceType || null,
    sourcePriority: baseMeta.sourcePriority || 0,
  };
}

function makeAthleteEntry({
  competition,
  sex,
  category,
  placing,
  lifterName,
  yearOfBirth,
  club,
  bodyweight,
  coefficient,
  order,
  attempts,
  total,
  ipfgl,
  liftType,
  movementRanks,
}) {
  const athleteName = normalizeSpaces(lifterName);
  return {
    athleteName,
    athleteNameNormalized: normalizeName(athleteName),
    sex: sex || null,
    category: formatCategoryToken(category) || null,
    placing: placing || null,
    yearOfBirth: yearOfBirth || null,
    club: club || null,
    bodyweight: bodyweight ?? null,
    coefficient: coefficient ?? null,
    order: order ?? null,
    total: total ?? null,
    ipfgl: ipfgl ?? null,
    attempts,
    liftType: liftType || 'powerlifting',
    movementRanks: movementRanks || null,
    competition,
  };
}

function attemptsObjectFromList(values) {
  const attempts = attemptsFromValues(values);
  return {
    squat: attempts.slice(0, 3),
    bench: attempts.slice(3, 6),
    deadlift: attempts.slice(6, 9),
    __labels: { ...DEFAULT_LIFT_LABELS },
  };
}

function emptyAttemptsObject(labels = {}) {
  const empty = () => [
    { raw: null, weight: null, good: null },
    { raw: null, weight: null, good: null },
    { raw: null, weight: null, good: null },
  ];
  return {
    squat: empty(),
    bench: empty(),
    deadlift: empty(),
    __labels: { ...labels },
  };
}

function attemptsObjectForLiftType(values, liftType, label = null) {
  const attempts = emptyAttemptsObject();
  const parsed = attemptsFromValues(values.slice(0, 3));

  if (liftType === 'bench') {
    attempts.bench = parsed;
    attempts.__labels.bench = label || DEFAULT_LIFT_LABELS.bench;
    return attempts;
  }

  if (liftType === 'deadlift') {
    attempts.deadlift = parsed;
    attempts.__labels.deadlift = label || DEFAULT_LIFT_LABELS.deadlift;
    return attempts;
  }

  if (liftType === 'squat') {
    attempts.squat = parsed;
    attempts.__labels.squat = label || DEFAULT_LIFT_LABELS.squat;
    return attempts;
  }

  return attemptsObjectFromList(values);
}

const DEFAULT_LIFT_LABELS = {
  squat: 'Sentadilla',
  bench: 'Banca',
  deadlift: 'Peso muerto',
};

function movementFromHeaderCell(value) {
  const normalized = normalizeName(value);
  if (!normalized) return null;

  // No dependas del nombre exacto. En los Excel de AEP aparecen variantes
  // como SENTADILLA, SENTADILLAS, SQUAT, PRESS BANCA, BANCA, PESO MUERTO, etc.
  // Leemos el titulo real de la cabecera y solo lo mapeamos internamente para
  // almacenar los intentos en la clave correcta.
  if (/sentadill|squat/.test(normalized)) return 'squat';
  if (/press\s*(de\s*)?banca|\bbanca(s)?\b|bench/.test(normalized)) return 'bench';
  if (/peso\s*muert|dead\s*lift|deadlift/.test(normalized)) return 'deadlift';

  return null;
}

function displayLiftLabelFromHeader(value, movement) {
  const text = normalizeSpaces(value);
  if (text) return text;
  return DEFAULT_LIFT_LABELS[movement] || movement;
}

function layoutTypeFromMovements(movements) {
  const key = movements.join('+');
  if (key === 'squat+bench+deadlift') return 'powerlifting';
  if (key === 'bench') return 'bench';
  if (key === 'deadlift') return 'deadlift';
  if (key === 'squat') return 'squat';
  return key || 'custom';
}

function detectLiftTypeFromText(text) {
  const normalized = normalizeName(text);

  // Normal full meets often say "Powerlifting y Press Banca". Do not treat
  // that as bench-only unless a results header/table says it is bench-only.
  if (/powerlifting/.test(normalized) && /press\s+banca|banca/.test(normalized)) {
    return 'powerlifting';
  }

  if (/hombres\s+press\s+banca|mujeres\s+press\s+banca|campeonato.*press\s+banca|absoluto.*press\s+banca|nacional.*press\s+banca/.test(normalized)) {
    return 'bench';
  }

  if (/hombres\s+peso\s+muerto|mujeres\s+peso\s+muerto|campeonato.*peso\s+muerto|absoluto.*peso\s+muerto|nacional.*peso\s+muerto/.test(normalized)) {
    return 'deadlift';
  }

  return 'powerlifting';
}

function findHeaderIndex(row, matcher) {
  for (let index = 0; index < row.length; index += 1) {
    if (matcher(normalizeName(row[index]), row[index], index)) return index;
  }
  return -1;
}

function getCellValue(cell) {
  if (!cell) return '';
  if (cell.v !== undefined && cell.v !== null) return cell.v;
  if (cell.w !== undefined && cell.w !== null) return cell.w;
  return '';
}

function getSheetRows(sheet) {
  const ref = sheet && sheet['!ref'];
  if (!ref) return [];

  const range = XLSX.utils.decode_range(ref);
  const rows = [];

  for (let r = range.s.r; r <= range.e.r; r += 1) {
    const values = [];
    const cells = [];
    let hasValue = false;

    for (let c = range.s.c; c <= range.e.c; c += 1) {
      const address = XLSX.utils.encode_cell({ r, c });
      const cell = sheet[address] || null;
      const value = getCellValue(cell);

      values.push(value);
      cells.push(cell);

      if (normalizeSpaces(value)) hasValue = true;
    }

    if (hasValue) {
      rows.push({
        values,
        cells,
        excelRowIndex: r,
      });
    }
  }

  return rows;
}


function isLegacyXlsBuffer(buffer) {
  if (!buffer || buffer.length < 8) return false;
  return buffer.slice(0, 8).toString('hex') === 'd0cf11e0a1b11ae1';
}

function fileUrlFromPath(targetPath) {
  const resolved = path.resolve(targetPath).replace(/\\/g, '/');
  if (process.platform === 'win32') return 'file:///' + resolved;
  return 'file://' + resolved;
}

function executableExists(command) {
  if (!command) return false;
  if (command.includes('\\') || command.includes('/') || path.isAbsolute(command)) {
    return fs.existsSync(command);
  }

  try {
    const checker = process.platform === 'win32' ? 'where' : 'which';
    execFileSync(checker, [command], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function libreOfficeCandidates() {
  const candidates = [];

  if (process.env.LIBREOFFICE_PATH) candidates.push(process.env.LIBREOFFICE_PATH);
  if (process.env.SOFFICE_PATH) candidates.push(process.env.SOFFICE_PATH);

  if (process.platform === 'win32') {
    candidates.push(
      'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
      'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
      'soffice.exe',
      'soffice',
      'libreoffice.exe',
      'libreoffice'
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/LibreOffice.app/Contents/MacOS/soffice',
      'soffice',
      'libreoffice'
    );
  } else {
    candidates.push('soffice', 'libreoffice');
  }

  return [...new Set(candidates.filter(Boolean))];
}

function findLibreOfficeExecutable() {
  for (const command of libreOfficeCandidates()) {
    if (executableExists(command)) return command;
  }
  return null;
}

function convertWithLibreOffice(inputPath, outputDir) {
  const command = findLibreOfficeExecutable();
  if (!command) return null;

  const profileDir = path.join(outputDir, 'lo-profile');
  fs.mkdirSync(profileDir, { recursive: true });

  const args = [
    '--headless',
    '--nologo',
    '--nodefault',
    '--nofirststartwizard',
    '--nolockcheck',
    '--norestore',
    '-env:UserInstallation=' + fileUrlFromPath(profileDir),
    '--convert-to',
    'xlsx',
    '--outdir',
    outputDir,
    inputPath,
  ];

  try {
    execFileSync(command, args, {
      stdio: 'pipe',
      timeout: 20000,
      windowsHide: true,
      env: {
        ...process.env,
        HOME: outputDir,
        USERPROFILE: process.platform === 'win32' ? (process.env.USERPROFILE || outputDir) : outputDir,
      },
    });

    const expected = path.join(outputDir, path.basename(inputPath, path.extname(inputPath)) + '.xlsx');
    if (fs.existsSync(expected)) return expected;

    const converted = fs.readdirSync(outputDir)
      .find((name) => name.toLowerCase().endsWith('.xlsx'));
    if (converted) return path.join(outputDir, converted);
  } catch {
    return null;
  }

  return null;
}

function convertWithExcelCom() {
  // Deliberately disabled. Excel COM can hang during full indexing on Windows
  // when Excel is not fully installed/configured. For old .xls files this app
  // uses LibreOffice only.
  return null;
}

function convertLegacyXlsToXlsxBuffer(buffer) {
  if (!isLegacyXlsBuffer(buffer)) return null;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pls-xls-'));
  const inputPath = path.join(tempDir, 'input.xls');

  try {
    fs.writeFileSync(inputPath, buffer);

    const convertedPath = convertWithLibreOffice(inputPath, tempDir);
    if (!convertedPath || !fs.existsSync(convertedPath)) return null;

    return fs.readFileSync(convertedPath);
  } catch {
    return null;
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}

function readExcelWorkbookPreservingStyles(buffer) {
  const readOptions = {
    type: 'buffer',
    cellStyles: true,
    cellNF: true,
    cellHTML: true,
    raw: true,
  };

  // v14: no convertimos .xls con Excel COM ni LibreOffice durante la
  // indexacion. En los .xls antiguos donde los nulos solo son visuales, la
  // solucion robusta es procesar tambien el PDF oficial del mismo campeonato y
  // usar sus intentos cuando el Excel sale todo valido.
  return {
    workbook: XLSX.read(buffer, readOptions),
    convertedLegacyXls: false,
  };
}


function workbookStreamFromLegacyXls(buffer) {
  if (!buffer || buffer.length < 8) return null;

  // OLE Compound File signature used by old .xls BIFF workbooks.
  const oleSignature = 'd0cf11e0a1b11ae1';
  if (buffer.slice(0, 8).toString('hex') !== oleSignature) return null;

  const CFB = getCFBModule();
  if (!CFB || typeof CFB.read !== 'function') return null;

  let cfb;
  try {
    cfb = CFB.read(buffer, { type: 'buffer' });
  } catch {
    return null;
  }

  const names = ['Workbook', '/Workbook', 'Book', '/Book'];
  for (const name of names) {
    try {
      if (typeof CFB.find === 'function') {
        const found = CFB.find(cfb, name);
        if (found && found.content) return Buffer.from(found.content);
      }
    } catch {
      // continue with manual lookup below
    }
  }

  for (const entry of cfb.FileIndex || []) {
    const entryName = String(entry.name || entry.path || '').replace(/^\//, '');
    if ((entryName === 'Workbook' || entryName === 'Book') && entry.content) {
      return Buffer.from(entry.content);
    }
  }

  return null;
}

function readUInt16Safe(buffer, offset) {
  if (!buffer || offset + 2 > buffer.length) return null;
  return buffer.readUInt16LE(offset);
}

function fontIndexToArrayIndex(fontIndex, fonts) {
  if (!fonts || fontIndex === null || fontIndex === undefined) return null;
  const direct = Number(fontIndex);
  if (fonts[direct]) return direct;

  // In BIFF, font index 4 is reserved, so XF font index >= 5 maps to
  // fonts array index - 1 when FONT records are stored sequentially.
  if (direct > 4 && fonts[direct - 1]) return direct - 1;
  return direct;
}

function parseBiffFontRecord(data) {
  if (!data || data.length < 6) return { strike: false, red: false };

  const optionFlags = readUInt16Safe(data, 2) || 0;
  const colorIndex = readUInt16Safe(data, 4);

  return {
    // grbit bit 3 = struck out text in BIFF font records.
    strike: Boolean(optionFlags & 0x0008),
    // AEP sheets use red font for null attempts in old .xls files.
    red: indexedColorLooksRed(colorIndex),
    colorIndex,
  };
}

function parseBiffXfRecord(data, fonts) {
  if (!data || data.length < 2) return { failedAttemptStyle: false, fontIndex: null };
  const fontIndex = readUInt16Safe(data, 0);
  const fontArrayIndex = fontIndexToArrayIndex(fontIndex, fonts);
  const font = fonts[fontArrayIndex] || null;
  return {
    fontIndex,
    failedAttemptStyle: Boolean(font && (font.strike || font.red)),
  };
}

function buildLegacyXlsFailStyleMaps(buffer) {
  const stream = workbookStreamFromLegacyXls(buffer);
  if (!stream) return [];

  const fonts = [];
  const xfs = [];
  const sheetMaps = [];
  let offset = 0;
  let inWorksheet = false;
  let sheetIndex = -1;

  function ensureSheetMap() {
    if (!sheetMaps[sheetIndex]) sheetMaps[sheetIndex] = new Set();
    return sheetMaps[sheetIndex];
  }

  function markCellIfFailed(row, col, xfIndex) {
    if (!inWorksheet || sheetIndex < 0) return;
    const xf = xfs[Number(xfIndex)];
    if (xf && xf.failedAttemptStyle) {
      ensureSheetMap().add(`${row}:${col}`);
    }
  }

  while (offset + 4 <= stream.length) {
    const sid = stream.readUInt16LE(offset);
    const length = stream.readUInt16LE(offset + 2);
    const dataStart = offset + 4;
    const dataEnd = dataStart + length;
    if (dataEnd > stream.length) break;

    const data = stream.slice(dataStart, dataEnd);

    if (sid === 0x0809) {
      const substreamType = readUInt16Safe(data, 2);
      if (substreamType === 0x0010) {
        sheetIndex += 1;
        inWorksheet = true;
        ensureSheetMap();
      } else {
        inWorksheet = false;
      }
    } else if (sid === 0x000a) {
      inWorksheet = false;
    } else if (!inWorksheet && sid === 0x0031) {
      fonts.push(parseBiffFontRecord(data));
    } else if (!inWorksheet && sid === 0x00e0) {
      xfs.push(parseBiffXfRecord(data, fonts));
    } else if (inWorksheet) {
      if ([0x0203, 0x00fd, 0x0006, 0x0406, 0x027e, 0x0201, 0x0205].includes(sid) && data.length >= 6) {
        const row = data.readUInt16LE(0);
        const col = data.readUInt16LE(2);
        const xfIndex = data.readUInt16LE(4);
        markCellIfFailed(row, col, xfIndex);
      } else if (sid === 0x00bd && data.length >= 8) {
        // MULRK: row, first col, repeated (xf, rk), last col.
        const row = data.readUInt16LE(0);
        const firstCol = data.readUInt16LE(2);
        const lastCol = data.readUInt16LE(data.length - 2);
        for (let col = firstCol; col <= lastCol; col += 1) {
          const pairOffset = 4 + (col - firstCol) * 6;
          if (pairOffset + 2 <= data.length - 2) {
            const xfIndex = data.readUInt16LE(pairOffset);
            markCellIfFailed(row, col, xfIndex);
          }
        }
      } else if (sid === 0x00be && data.length >= 8) {
        // MULBLANK: row, first col, repeated XF, last col.
        const row = data.readUInt16LE(0);
        const firstCol = data.readUInt16LE(2);
        const lastCol = data.readUInt16LE(data.length - 2);
        for (let col = firstCol; col <= lastCol; col += 1) {
          const xfOffset = 4 + (col - firstCol) * 2;
          if (xfOffset + 2 <= data.length - 2) {
            const xfIndex = data.readUInt16LE(xfOffset);
            markCellIfFailed(row, col, xfIndex);
          }
        }
      }
    }

    offset = dataEnd;
  }

  return sheetMaps;
}


function getWorkbookStyles(workbook) {
  return workbook && (workbook.Styles || workbook.styles || workbook.stylesheet || null);
}

function getStyleArray(styles, names) {
  if (!styles) return null;
  for (const name of names) {
    if (Array.isArray(styles[name])) return styles[name];
  }
  return null;
}

function styleObjectsForCell(cell, workbook) {
  const objects = [];
  if (!cell) return objects;

  const styles = getWorkbookStyles(workbook);
  const cellStyle = cell.s;
  if (cellStyle !== undefined && cellStyle !== null) {
    objects.push(cellStyle);
  }

  if (typeof cellStyle === 'number' && styles) {
    const xfs = getStyleArray(styles, ['CellXf', 'cellXf', 'CellXfs', 'cellXfs']);
    const xf = xfs && xfs[cellStyle];
    if (xf) {
      objects.push(xf);

      const fontId = xf.fontId ?? xf.fontID ?? xf.font;
      const fonts = getStyleArray(styles, ['Fonts', 'fonts']);
      if (fontId !== undefined && fontId !== null && fonts && fonts[Number(fontId)]) {
        objects.push(fonts[Number(fontId)]);
      }
    }
  }

  if (typeof cellStyle === 'object' && cellStyle) {
    if (cellStyle.font) objects.push(cellStyle.font);
    const fontId = cellStyle.fontId ?? cellStyle.fontID;
    const fonts = getStyleArray(styles, ['Fonts', 'fonts']);
    if (fontId !== undefined && fontId !== null && fonts && fonts[Number(fontId)]) {
      objects.push(fonts[Number(fontId)]);
    }
  }

  return objects;
}

function colorStringLooksRed(value) {
  if (!value) return false;
  let text = String(value).trim().toLowerCase();
  if (!text) return false;
  if (text === 'red') return true;

  text = text.replace(/^#/, '').replace(/^0x/, '');
  const match = text.match(/[0-9a-f]{6,8}/i);
  if (!match) return false;

  let hex = match[0];
  if (hex.length === 8) {
    // Common Excel style is AARRGGBB. Keep the RGB part.
    hex = hex.slice(2);
  }

  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);

  return Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b) && r >= 150 && g <= 120 && b <= 120;
}

function indexedColorLooksRed(value) {
  const index = Number(value);
  if (!Number.isFinite(index)) return false;

  // BIFF/XLS and OOXML indexed palettes commonly use 2 or 10 for red.
  // We only use this on attempt cells, never on headers.
  return index === 2 || index === 10;
}

function inspectStyleObject(style, seen = new Set()) {
  const result = { strike: false, red: false };
  if (!style || seen.has(style)) return result;

  if (typeof style === 'string') {
    if (colorStringLooksRed(style)) result.red = true;
    if (/strike|line-through|tachad/i.test(style)) result.strike = true;
    return result;
  }

  if (typeof style === 'number') {
    return result;
  }

  if (typeof style !== 'object') {
    return result;
  }

  seen.add(style);

  for (const [keyRaw, value] of Object.entries(style)) {
    const key = String(keyRaw || '').toLowerCase();

    if (
      /(strike|strikethrough|tachad)/.test(key) &&
      (value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true')
    ) {
      result.strike = true;
    }

    if ((key === 'rgb' || key === 'argb' || key === 'color') && colorStringLooksRed(value)) {
      result.red = true;
    }

    if ((key === 'indexed' || key === 'index' || key === 'colorindex') && indexedColorLooksRed(value)) {
      result.red = true;
    }

    if (typeof value === 'string' && colorStringLooksRed(value)) {
      result.red = true;
    }

    if (value && typeof value === 'object') {
      const child = inspectStyleObject(value, seen);
      if (child.strike) result.strike = true;
      if (child.red) result.red = true;
    }
  }

  return result;
}

function cellHtmlIndicatesFailedAttempt(cell) {
  const html = normalizeSpaces(`${cell?.h || ''} ${cell?.r || ''}`);
  if (!html) return false;

  return /strike|line-through|text-decoration:\s*line-through|<s>|<strike/i.test(html);
}

function cellStyleIndicatesFailedAttempt(cell, workbook) {
  if (!cell) return false;

  if (cellHtmlIndicatesFailedAttempt(cell)) return true;

  const styleObjects = styleObjectsForCell(cell, workbook);
  let hasStrike = false;
  let hasRed = false;

  for (const style of styleObjects) {
    const info = inspectStyleObject(style);
    if (info.strike) hasStrike = true;
    if (info.red) hasRed = true;
  }

  // Tachado es señal inequívoca. Rojo también se usa en las hojas AEP para nulos,
  // pero solo evaluamos esta regla en columnas de intentos, no en cabeceras ni totales.
  return hasStrike || hasRed;
}

function attemptFromExcelCell(cell, workbook, failedByLegacyStyle = false) {
  const attempt = attemptsFromValues([getCellValue(cell)])[0];
  if (!attempt || attempt.weight === null) return attempt;

  if (failedByLegacyStyle || cellStyleIndicatesFailedAttempt(cell, workbook)) {
    return {
      raw: `-${attempt.weight}`,
      weight: attempt.weight,
      good: false,
    };
  }

  return attempt;
}

function buildExcelLayoutFromHeaderRow(row) {
  const lifterIndex = findHeaderIndex(row, (text) => /levantador|levantadora/.test(text));
  if (lifterIndex < 0) return null;

  const yearIndex = findHeaderIndex(row, (text) => /^ano$|^año$/.test(text));
  const clubIndex = findHeaderIndex(row, (text) => /^club$/.test(text));
  const bodyweightIndex = findHeaderIndex(row, (text) => /^peso$/.test(text));
  const coefficientIndex = findHeaderIndex(row, (text) => /^coef|coeficiente/.test(text));
  const orderIndex = findHeaderIndex(row, (text) => /^ord/.test(text));

  const liftStarts = [];
  for (let index = 0; index < row.length; index += 1) {
    const movement = movementFromHeaderCell(row[index]);
    if (!movement) continue;
    if (liftStarts.some((item) => item.movement === movement)) continue;
    liftStarts.push({
      movement,
      start: index,
      label: displayLiftLabelFromHeader(row[index], movement),
    });
  }

  liftStarts.sort((a, b) => a.start - b.start);
  if (!liftStarts.length) return null;

  const movements = liftStarts.map((item) => item.movement);
  const lastAttemptColumn = Math.max(...liftStarts.map((item) => item.start + 2));

  let totalIndex = -1;
  for (let index = lastAttemptColumn + 1; index < row.length; index += 1) {
    const text = normalizeName(row[index]);
    if (/^total$|^mpm$|^mejor\s+peso\s+muerto$|^mejor\s+marca$/.test(text)) {
      totalIndex = index;
      break;
    }
  }

  let ipfglIndex = -1;
  for (let index = (totalIndex >= 0 ? totalIndex + 1 : lastAttemptColumn + 1); index < row.length; index += 1) {
    const text = normalizeName(row[index]).replace(/\s+/g, '');
    if (/^ipfgl$/.test(text) || /^gl$/.test(text)) {
      ipfglIndex = index;
      break;
    }
  }

  for (let index = 0; index < liftStarts.length; index += 1) {
    const item = liftStarts[index];
    const boundary = index + 1 < liftStarts.length
      ? liftStarts[index + 1].start
      : (totalIndex >= 0 ? totalIndex : item.start + 3);
    item.rankIndex = boundary - item.start >= 4 ? boundary - 1 : null;
  }

  return {
    lifterIndex,
    placingIndex: lifterIndex > 0 ? lifterIndex - 1 : 0,
    yearIndex,
    clubIndex,
    bodyweightIndex,
    coefficientIndex,
    orderIndex,
    liftStarts,
    movements,
    liftType: layoutTypeFromMovements(movements),
    totalIndex,
    ipfglIndex,
  };
}

const VALID_CATEGORY_LIMITS = new Set([
  43, 47, 52, 53, 57, 59, 63, 66, 69, 74, 76, 83, 84, 93, 105, 120,
]);

function parseCategoryParts(raw) {
  const clean = normalizeSpaces(raw).replace(/\s+/g, '');
  if (!clean) return null;

  const match =
    clean.match(/^([+-]?)(\d{1,3})(\+?)kg$/i) ||
    clean.match(/^([+-]?)(\d{1,3})(\+?)$/);
  if (!match) return null;

  const value = Number(match[2]);
  if (!Number.isInteger(value)) return null;
  if (!VALID_CATEGORY_LIMITS.has(value)) return null;

  const sign = match[1] === '+' || match[3] === '+' ? '+' : '-';
  return { sign, value };
}

function detectCategoryInRow(row) {
  // Solo aceptamos categorias reales de powerlifting (-74, -83, +84, +120...).
  // Antes cualquier numero suelto podia convertirse en categoria. En algunos XLS
  // antiguos la fecha aparece como serial Excel, por ejemplo 45739, y eso acababa
  // guardandose como -45739kg.
  for (const cell of row) {
    const formatted = formatCategoryToken(cell);
    if (formatted) return formatted;
  }
  return null;
}

function sexFromRow(row) {
  const text = normalizeName(row.join(' '));
  if (/\bmujeres\b|\bfemenin/.test(text)) return 'F';
  if (/\bhombres\b|\bmasculin/.test(text)) return 'M';
  return null;
}

function attemptsObjectFromExcelRow(row, layout, cells = [], workbook = null, legacyFailMap = null, excelRowIndex = null) {
  const labels = {};
  for (const item of layout.liftStarts) {
    labels[item.movement] = item.label || DEFAULT_LIFT_LABELS[item.movement] || item.movement;
  }

  const attempts = emptyAttemptsObject(labels);
  for (const item of layout.liftStarts) {
    const movementAttempts = [];
    for (let offset = 0; offset < 3; offset += 1) {
      const cell = cells[item.start + offset] || null;
      if (cell) {
        const legacyFailed = Boolean(legacyFailMap && excelRowIndex !== null && legacyFailMap.has(`${excelRowIndex}:${item.start + offset}`));
        movementAttempts.push(attemptFromExcelCell(cell, workbook, legacyFailed));
      } else {
        movementAttempts.push(attemptsFromValues([row[item.start + offset]])[0]);
      }
    }
    attempts[item.movement] = movementAttempts;
  }
  return attempts;
}

function movementRanksFromExcelRow(row, layout) {
  const ranks = {};
  if (!layout || !layout.liftStarts) return ranks;

  for (const item of layout.liftStarts) {
    if (item.rankIndex === null || item.rankIndex === undefined) continue;
    const value = parseLocaleNumber(row[item.rankIndex]);
    if (value !== null && Number.isInteger(value) && value > 0 && value < 100000) {
      ranks[item.movement] = value;
    }
  }

  return Object.keys(ranks).length ? ranks : null;
}

function parseExcelDocument(buffer, baseMeta) {
  const { workbook, convertedLegacyXls } = readExcelWorkbookPreservingStyles(buffer);
  const legacyFailStyleMaps = convertedLegacyXls ? [] : buildLegacyXlsFailStyleMaps(buffer);
  const entries = [];

  for (let sheetIndex = 0; sheetIndex < workbook.SheetNames.length; sheetIndex += 1) {
    const sheetName = workbook.SheetNames[sheetIndex];
    const sheet = workbook.Sheets[sheetName];
    const legacyFailMap = legacyFailStyleMaps[sheetIndex] || null;
    const sheetRows = getSheetRows(sheet);
    const rows = sheetRows.map((item) => item.values);

    if (!rows.length) continue;

    const name = firstNonEmpty(rows[1] || []);
    const subtitle = firstNonEmpty(rows[2] || []);
    const locationDateText = firstNonEmpty(rows[3] || []);
    const competition = buildCompetitionMeta(baseMeta, { name, subtitle, locationDateText });

    let category = null;
    let sex = null;
    let currentLayout = null;

    for (let index = 0; index < sheetRows.length; index += 1) {
      const rowData = sheetRows[index] || { values: [], cells: [] };
      const row = rowData.values || [];
      const cells = rowData.cells || [];

      const rowSex = sexFromRow(row);
      if (rowSex) sex = rowSex;

      const headerLayout = buildExcelLayoutFromHeaderRow(row);
      if (headerLayout) {
        currentLayout = headerLayout;
        continue;
      }

      const rowCategory = detectCategoryInRow(row);
      const hasLifterCell = currentLayout ? Boolean(normalizeSpaces(row[currentLayout.lifterIndex])) : false;
      const hasYearCell = currentLayout && currentLayout.yearIndex >= 0
        ? parseLocaleNumber(row[currentLayout.yearIndex]) !== null
        : false;

      if (rowCategory && !hasLifterCell && !hasYearCell) {
        category = formatCategoryToken(rowCategory);
        continue;
      }

      if (!currentLayout) continue;

      const placingRaw = normalizeSpaces(row[currentLayout.placingIndex]);
      const isDataRow = /^(\d+|DT|AI)$/i.test(placingRaw);
      if (!isDataRow) continue;

      const lifterName = normalizeSpaces(row[currentLayout.lifterIndex]);
      const yearOfBirth = currentLayout.yearIndex >= 0 ? parseLocaleNumber(row[currentLayout.yearIndex]) : null;
      const club = currentLayout.clubIndex >= 0 ? normalizeSpaces(row[currentLayout.clubIndex]) : '';
      if (!lifterName || !yearOfBirth || !club) continue;

      const reportedTotal = currentLayout.totalIndex >= 0 ? parseLocaleNumber(row[currentLayout.totalIndex]) : null;
      const movementRanks = movementRanksFromExcelRow(row, currentLayout);
      let attempts = attemptsObjectFromExcelRow(row, currentLayout, cells, workbook, legacyFailMap, rowData.excelRowIndex);

      // Algunos Excel antiguos de AEP no guardan los nulos con signo negativo:
      // visualmente aparecen en rojo/tachado, pero al extraer el valor solo queda
      // el numero positivo. Para no depender de que SheetJS conserve estilos,
      // reconstruimos los nulos comparando los intentos con el total oficial.
      if (currentLayout.liftType === 'powerlifting') {
        attempts = repairAttemptsUsingReportedTotal(attempts, reportedTotal);
      } else if (['squat', 'bench', 'deadlift'].includes(currentLayout.liftType)) {
        attempts = repairSingleLiftAttemptsUsingReportedTotal(
          attempts,
          currentLayout.liftType,
          reportedTotal
        );
      }

      entries.push(
        makeAthleteEntry({
          competition,
          sex,
          category,
          placing: placingRaw,
          lifterName,
          yearOfBirth,
          club,
          bodyweight: currentLayout.bodyweightIndex >= 0 ? parseLocaleNumber(row[currentLayout.bodyweightIndex]) : null,
          coefficient: currentLayout.coefficientIndex >= 0 ? parseLocaleNumber(row[currentLayout.coefficientIndex]) : null,
          order: currentLayout.orderIndex >= 0 ? parseLocaleNumber(row[currentLayout.orderIndex]) : null,
          attempts,
          total: reportedTotal,
          ipfgl: currentLayout.ipfglIndex >= 0 ? parseLocaleNumber(row[currentLayout.ipfglIndex]) : null,
          liftType: currentLayout.liftType,
          movementRanks,
        })
      );
    }
  }

  return repairEntriesUsingMovementRanks(entries);
}


function cloneAttemptWithGood(attempt, good) {
  if (!attempt || attempt.weight === null) {
    return { raw: null, weight: null, good: null };
  }
  const weight = attempt.weight;
  return {
    raw: good === false ? `-${weight}` : String(weight),
    weight,
    good,
  };
}

function strictlyIncreasing(values) {
  for (let index = 1; index < values.length; index += 1) {
    if (!(values[index] > values[index - 1])) return false;
  }
  return true;
}

function inferStatusesForGroup(group, chosenBest) {
  const weights = group.map((attempt) => (attempt && attempt.weight !== null ? attempt.weight : null));
  if (weights.some((weight) => weight === null)) return null;

  let best = null;
  for (let mask = 1; mask < 8; mask += 1) {
    const statuses = [Boolean(mask & 1), Boolean(mask & 2), Boolean(mask & 4)];
    const successfulWeights = weights.filter((_, index) => statuses[index]);
    if (!successfulWeights.length) continue;
    if (Math.max(...successfulWeights) !== chosenBest) continue;
    if (!strictlyIncreasing(successfulWeights)) continue;

    let score = successfulWeights.length * 10;
    if (statuses[0]) score += 4;
    if (statuses[1]) score += 2;
    if (statuses[2]) score += 1;

    if (!best || score > best.score) {
      best = { statuses, score };
    }
  }

  return best;
}

function repairAttemptsUsingReportedTotal(attempts, reportedTotal) {
  const groups = [attempts.squat, attempts.bench, attempts.deadlift];
  const allAttempts = groups.flat();

  if (reportedTotal === null || reportedTotal === undefined) return attempts;
  if (!allAttempts.length) return attempts;
  if (allAttempts.some((attempt) => !attempt || attempt.weight === null)) return attempts;
  if (allAttempts.some((attempt) => attempt.good === false || attempt.good === null)) return attempts;

  const currentTotal = groups.reduce((sum, group) => sum + bestSuccessfulWeight(group), 0);
  if (Math.abs(currentTotal - reportedTotal) < 0.26) return attempts;

  const candidateWeights = groups.map((group) => {
    const values = [...new Set(group.map((attempt) => attempt.weight).filter((weight) => weight !== null))];
    values.sort((a, b) => a - b);
    return values;
  });

  const candidates = [];
  let best = null;
  for (const squatBest of candidateWeights[0]) {
    for (const benchBest of candidateWeights[1]) {
      for (const deadBest of candidateWeights[2]) {
        const candidateTotal = squatBest + benchBest + deadBest;
        if (Math.abs(candidateTotal - reportedTotal) >= 0.26) continue;

        const squatPlan = inferStatusesForGroup(attempts.squat, squatBest);
        const benchPlan = inferStatusesForGroup(attempts.bench, benchBest);
        const deadPlan = inferStatusesForGroup(attempts.deadlift, deadBest);
        if (!squatPlan || !benchPlan || !deadPlan) continue;

        const signature = [
          squatPlan.statuses.map((item) => (item ? '1' : '0')).join(''),
          benchPlan.statuses.map((item) => (item ? '1' : '0')).join(''),
          deadPlan.statuses.map((item) => (item ? '1' : '0')).join(''),
        ].join('|');

        const score = squatPlan.score + benchPlan.score + deadPlan.score + squatBest + benchBest + deadBest;
        const candidate = {
          score,
          signature,
          squatPlan,
          benchPlan,
          deadPlan,
        };
        candidates.push(candidate);

        if (!best || score > best.score) {
          best = candidate;
        }
      }
    }
  }

  if (!best) return attempts;

  const possibleSignatures = new Set(candidates.map((candidate) => candidate.signature));

  // Si el total permite varias lecturas, no inventamos nulos. En esos Excel
  // antiguos hay que leer el formato real de celda rojo/tachado.
  if (possibleSignatures.size !== 1) return attempts;

  return {
    ...attempts,
    squat: attempts.squat.map((attempt, index) => cloneAttemptWithGood(attempt, best.squatPlan.statuses[index])),
    bench: attempts.bench.map((attempt, index) => cloneAttemptWithGood(attempt, best.benchPlan.statuses[index])),
    deadlift: attempts.deadlift.map((attempt, index) => cloneAttemptWithGood(attempt, best.deadPlan.statuses[index])),
  };
}

function repairSingleLiftAttemptsUsingReportedTotal(attempts, liftType, reportedTotal) {
  const movementKey = liftType === 'bench'
    ? 'bench'
    : liftType === 'deadlift'
      ? 'deadlift'
      : liftType === 'squat'
        ? 'squat'
        : null;

  if (!movementKey) return attempts;
  if (reportedTotal === null || reportedTotal === undefined) return attempts;

  const group = attempts[movementKey] || [];
  if (group.length !== 3) return attempts;
  if (group.some((attempt) => !attempt || attempt.weight === null)) return attempts;

  // Si ya hay algun nulo real detectado por signo negativo o estilo convertido,
  // no sobreescribimos la informacion original.
  if (group.some((attempt) => attempt.good === false || attempt.good === null)) return attempts;

  const currentBest = bestSuccessfulWeight(group);
  if (Math.abs(currentBest - reportedTotal) < 0.26) return attempts;

  if (Math.abs(reportedTotal) < 0.26) {
    return {
      ...attempts,
      [movementKey]: group.map((attempt) => cloneAttemptWithGood(attempt, false)),
    };
  }

  const plan = inferStatusesForGroup(group, reportedTotal);
  if (!plan) return attempts;

  return {
    ...attempts,
    [movementKey]: group.map((attempt, index) => cloneAttemptWithGood(attempt, plan.statuses[index])),
  };
}

function hasTrustedFailureInfo(group) {
  return (group || []).some((attempt) => attempt && (attempt.good === false || attempt.good === null));
}

function possibleBestWeightsForMovement(entry, movement) {
  const group = entry?.attempts?.[movement] || [];
  const weights = group
    .filter((attempt) => attempt && attempt.weight !== null)
    .map((attempt) => attempt.weight);
  if (!weights.length) return [];

  if (hasTrustedFailureInfo(group)) {
    const best = bestSuccessfulWeight(group);
    return best > 0 ? [best] : [];
  }

  return [...new Set(weights)].sort((a, b) => a - b);
}

function compareMovementRanking(bestA, bodyweightA, bestB, bodyweightB) {
  const a = Number(bestA);
  const b = Number(bestB);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  if (Math.abs(a - b) > 0.001) return b - a;

  const bwA = Number(bodyweightA);
  const bwB = Number(bodyweightB);
  if (Number.isFinite(bwA) && Number.isFinite(bwB) && Math.abs(bwA - bwB) > 0.001) {
    return bwA - bwB;
  }
  return 0;
}

function candidateCouldMatchMovementRank(entry, movement, candidateBest, groupEntries) {
  const rank = entry?.movementRanks?.[movement];
  if (!rank || !Number.isFinite(Number(rank))) return true;

  let mustBeAbove = 0;
  let couldBeAbove = 0;
  for (const other of groupEntries) {
    if (other === entry) continue;
    const otherCandidates = possibleBestWeightsForMovement(other, movement);
    if (!otherCandidates.length) continue;

    const relations = otherCandidates.map((otherBest) =>
      compareMovementRanking(otherBest, other.bodyweight, candidateBest, entry.bodyweight)
    );
    if (relations.every((relation) => relation < 0)) mustBeAbove += 1;
    if (relations.some((relation) => relation < 0)) couldBeAbove += 1;
  }

  const minPossibleRank = mustBeAbove + 1;
  const maxPossibleRank = couldBeAbove + 1;
  return Number(rank) >= minPossibleRank && Number(rank) <= maxPossibleRank;
}

function candidateBestSetsForEntry(entry, groupEntries) {
  const result = {};
  for (const movement of ['squat', 'bench', 'deadlift']) {
    const candidates = possibleBestWeightsForMovement(entry, movement);
    if (!candidates.length) {
      result[movement] = [];
      continue;
    }

    const filtered = candidates.filter((candidate) =>
      candidateCouldMatchMovementRank(entry, movement, candidate, groupEntries)
    );
    result[movement] = filtered.length ? filtered : candidates;
  }
  return result;
}

function rankFilteredBestCombinations(entry, groupEntries) {
  if (entry.liftType && entry.liftType !== 'powerlifting') return [];
  if (entry.total === null || entry.total === undefined) return [];

  const sets = candidateBestSetsForEntry(entry, groupEntries);
  const combos = [];
  for (const squatBest of sets.squat || []) {
    for (const benchBest of sets.bench || []) {
      for (const deadBest of sets.deadlift || []) {
        const sum = squatBest + benchBest + deadBest;
        if (Math.abs(sum - entry.total) < 0.26) {
          combos.push({ squat: squatBest, bench: benchBest, deadlift: deadBest });
        }
      }
    }
  }
  return combos;
}

function comboSignature(combo) {
  return ['squat', 'bench', 'deadlift'].map((key) => String(combo[key])).join('|');
}

function applyBestComboToAttempts(attempts, combo) {
  const next = { ...attempts };
  for (const movement of ['squat', 'bench', 'deadlift']) {
    const group = attempts[movement] || [];
    const plan = inferStatusesForGroup(group, combo[movement]);
    if (!plan) continue;
    next[movement] = group.map((attempt, index) => cloneAttemptWithGood(attempt, plan.statuses[index]));
  }
  return next;
}

function repairEntriesUsingMovementRanks(entries) {
  const groups = new Map();
  for (const entry of entries) {
    if (!entry || entry.liftType !== 'powerlifting') continue;
    if (!entry.movementRanks || !Object.keys(entry.movementRanks).length) continue;

    const key = [
      entry.competition?.meetPageUrl || normalizeName(entry.competition?.name || ''),
      entry.competition?.date || '',
      entry.sex || '',
      entry.category || '',
    ].join('::');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }

  for (const groupEntries of groups.values()) {
    for (const entry of groupEntries) {
      const currentFailed = failedAttemptsCount(entry);
      const currentMatches = attemptsMatchReportedTotal(entry);
      if (currentFailed > 0 && currentMatches) continue;

      const combos = rankFilteredBestCombinations(entry, groupEntries);
      const signatures = [...new Set(combos.map(comboSignature))];
      if (signatures.length !== 1) continue;

      entry.attempts = applyBestComboToAttempts(entry.attempts, combos[0]);
    }
  }

  return entries;
}

function formatCategoryToken(raw) {
  const parts = parseCategoryParts(raw);
  if (!parts) return null;
  return `${parts.sign}${parts.value}kg`;
}

function extractPdfMetadata(lines) {
  const useful = lines
    .map((line) => normalizeSpaces(line))
    .filter(Boolean)
    .filter((line) => !/^pagina\s+\d+/i.test(line));

  const sexLine = useful.find((line) => /^(MUJERES|HOMBRES)\b/i.test(line)) || '';

  const associationIndex = useful.findIndex((line) =>
    /ASOCIACION ESPANOLA DE POWERLIFTING|ASOCIACIÓN ESPAÑOLA DE POWERLIFTING/i.test(line)
  );

  let name = '';
  let subtitle = '';
  let locationDateText = '';

  if (associationIndex >= 0) {
    name = useful[associationIndex + 1] || '';
    subtitle = useful[associationIndex + 2] || '';
    locationDateText = useful[associationIndex + 3] || '';
  }

  if (!name) {
    const headerIndex = useful.findIndex((line) => /LEVANTADOR|LEVANTADORA/i.test(line));
    const headerChunk = useful.slice(0, headerIndex > 0 ? headerIndex : 10);
    const withoutNoise = headerChunk.filter(
      (line) =>
        !/^Rev\.?/i.test(line) &&
        !/ASOCIACION ESPANOLA DE POWERLIFTING|ASOCIACIÓN ESPAÑOLA DE POWERLIFTING/i.test(line) &&
        !/HOMBRES|MUJERES/i.test(line)
    );

    name = withoutNoise[0] || '';
    subtitle = withoutNoise[1] || '';
    locationDateText = withoutNoise[2] || '';
  }

  return {
    name,
    subtitle,
    locationDateText,
    sex: /MUJERES/i.test(sexLine) ? 'F' : /HOMBRES/i.test(sexLine) ? 'M' : null,
    liftType: detectLiftTypeFromText(useful.slice(0, 30).join(' ')),
  };
}

function isPotentialAthleteLine(line) {
  if (!line) return false;
  if (!/^\d+\+?\s+/i.test(line)) return false;
  if (/\b(19|20)\d{2}\b/.test(line)) return true;

  // Algunos PDFs nuevos de AEP, por ejemplo IV Copa Black Crown 2026,
  // extraen filas completas sin la columna AÑO aunque la cabecera la tenga.
  // Aceptamos la fila si tiene suficientes tokens numericos para ser un
  // resultado completo: categoria, posicion, peso, orden, intentos, total e IPFGL.
  const numericTokens = normalizeSpaces(line)
    .split(' ')
    .filter((token) => parseLocaleNumber(token) !== null);

  return numericTokens.length >= 12;
}


function bestSuccessfulWeight(attempts) {
  const successful = attempts
    .filter((attempt) => attempt && attempt.good === true && attempt.weight !== null)
    .map((attempt) => attempt.weight);
  return successful.length ? Math.max(...successful) : 0;
}

function generateAttemptLayouts(tokens, missingCount) {
  const results = [];

  function walk(tokenIndex, positionIndex, current, missingLeft) {
    if (positionIndex === 9) {
      if (tokenIndex === tokens.length && missingLeft === 0) {
        results.push(current.slice());
      }
      return;
    }

    const positionsLeft = 9 - positionIndex;
    const tokensLeft = tokens.length - tokenIndex;
    if (tokensLeft > positionsLeft || missingLeft > positionsLeft) return;

    if (tokenIndex < tokens.length) {
      current.push(tokens[tokenIndex]);
      walk(tokenIndex + 1, positionIndex + 1, current, missingLeft);
      current.pop();
    }

    if (missingLeft > 0) {
      current.push(null);
      walk(tokenIndex, positionIndex + 1, current, missingLeft - 1);
      current.pop();
    }
  }

  walk(0, 0, [], missingCount);
  return results;
}

function scoreAttemptLayout(values, reportedTotal) {
  const attempts = attemptsObjectFromList(values);
  const squatBest = bestSuccessfulWeight(attempts.squat);
  const benchBest = bestSuccessfulWeight(attempts.bench);
  const deadliftBest = bestSuccessfulWeight(attempts.deadlift);
  const computedTotal = squatBest + benchBest + deadliftBest;

  let score = 0;

  if (reportedTotal === null || reportedTotal === undefined) {
    score += 20;
  } else if (Math.abs(computedTotal - reportedTotal) < 0.26) {
    score += 100;
  } else {
    score -= Math.abs(computedTotal - reportedTotal) * 2;
  }

  for (const group of [attempts.squat, attempts.bench, attempts.deadlift]) {
    let lastWeight = -Infinity;
    for (const attempt of group) {
      if (!attempt || attempt.weight === null) continue;
      if (attempt.weight + 1e-9 < lastWeight) {
        score -= 12;
      } else {
        score += 2;
      }
      lastWeight = attempt.weight;
    }
  }

  if (benchBest > 0) {
    if ((squatBest > 0 && benchBest <= squatBest) && (deadliftBest > 0 && benchBest <= deadliftBest)) {
      score += 20;
    } else {
      score -= 20;
    }
  }

  const nullPenalty = [8, 4, 0, 8, 4, 0, 8, 4, 0];
  values.forEach((value, index) => {
    if (value === null) score -= nullPenalty[index];
  });

  return { score, values };
}

function reconstructAttemptTokens(tokens, reportedTotal) {
  if (tokens.length === 9) return tokens;
  if (tokens.length > 9 || tokens.length < 6) return null;

  const missingCount = 9 - tokens.length;
  const layouts = generateAttemptLayouts(tokens, missingCount);
  let best = null;

  for (const layout of layouts) {
    const candidate = scoreAttemptLayout(layout, reportedTotal);
    if (!best || candidate.score > best.score) {
      best = candidate;
    }
  }

  return best ? best.values : null;
}

function categoryLimitFromToken(categoryToken) {
  return parseCategoryParts(categoryToken);
}

function bodyweightMatchesCategory(bodyweight, categoryToken) {
  if (bodyweight === null || bodyweight === undefined) return false;
  if (bodyweight <= 0 || bodyweight > 250) return false;

  const limit = categoryLimitFromToken(categoryToken);
  if (!limit) return true;

  if (limit.sign === '+') {
    // En +120kg, +84kg, etc. el peso corporal debe estar por encima del corte.
    return bodyweight + 0.01 >= limit.value;
  }

  // En -74kg, -83kg, etc. nunca puede superar claramente la categoria.
  return bodyweight <= limit.value + 0.01;
}

function findPdfBodyweightOrder(tokens, startIndex, categoryToken = null) {
  for (let index = startIndex; index < tokens.length - 3; index += 1) {
    const bodyweight = parseLocaleNumber(tokens[index]);
    const order = parseLocaleNumber(tokens[index + 1]);
    const remaining = tokens.length - (index + 2);

    if (bodyweight === null || order === null) continue;
    if (!bodyweightMatchesCategory(bodyweight, categoryToken)) continue;

    // En competiciones grandes la columna Ord. puede ser de 4 digitos
    // (por ejemplo 1214 en SBD Cup 2025). Antes se limitaba a 999 y eso
    // provocaba que el parser saltase el peso corporal real y tomase una
    // sentadilla como peso corporal.
    if (!Number.isInteger(order) || order <= 0 || order > 99999) continue;
    if (remaining < 6) continue;
    return { index, bodyweight, order };
  }

  return null;
}

function tokenLooksLikeClubStart(token) {
  const text = String(token || '').trim();
  if (!text) return false;

  const normalized = normalizeName(text);
  const knownStarters = new Set([
    '84pwt', 'aefa', 'alhu', 'alfa', 'arba', 'arp', 'basic', 'berserkers',
    'blcr', 'brstod', 'crom', 'danigpower', 'eduardo', 'elite', 'enrgzn',
    'energy', 'fenix', 'fgran', 'fguan', 'fia', 'fuerza', 'gimnasio',
    'gr', 'hangar', 'intend', 'iron', 'moon', 'myrtea', 'newera', 'oversize',
    'palba', 'pbar', 'pm', 'power', 'powerlifting', 'rising', 'sideropolis',
    'soy', 'sparta', 'strength', 'the', 'venetta', 'vendetta', 'work', 'zab',
    'zabar'
  ]);
  if (knownStarters.has(normalized)) return true;

  // En los PDFs AEP sin columna AÑO, el nombre suele venir en Title Case y el
  // club suele arrancar con una palabra/sigla en mayusculas: RISING, OVERSIZE,
  // INTEND, WORK, FUERZA, GIMNASIO, etc.
  const lettersOnly = text.replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g, '');
  if (lettersOnly.length >= 2 && lettersOnly === lettersOnly.toUpperCase()) return true;

  return false;
}

function splitPdfNameAndClubWithoutYear(tokens) {
  const cleanTokens = tokens.filter((token) => normalizeSpaces(token));
  if (cleanTokens.length < 3) return null;

  for (let index = 2; index < cleanTokens.length; index += 1) {
    if (!tokenLooksLikeClubStart(cleanTokens[index])) continue;
    const name = normalizeSpaces(cleanTokens.slice(0, index).join(' '));
    const club = normalizeSpaces(cleanTokens.slice(index).join(' '));
    if (name && club) return { lifterName: name, club };
  }

  const splitIndex = Math.max(2, cleanTokens.length - 2);
  return {
    lifterName: normalizeSpaces(cleanTokens.slice(0, splitIndex).join(' ')),
    club: normalizeSpaces(cleanTokens.slice(splitIndex).join(' ')),
  };
}

function parsePdfAthleteLineWithoutYear(tokens, competition, sex, fallbackCategory, liftType = 'powerlifting') {
  const rowCategory = formatCategoryToken(tokens[0]);

  let nameStartIndex = 1;
  let placing = null;
  if (tokens[1] && (/^\d+$/.test(tokens[1]) || /^(DT|DQ|AI)$/i.test(tokens[1]))) {
    placing = tokens[1];
    nameStartIndex = 2;
  }

  const categoryForBodyweight = fallbackCategory || rowCategory;
  const bodyweightOrder = findPdfBodyweightOrder(tokens, nameStartIndex + 2, categoryForBodyweight);
  if (!bodyweightOrder) return null;

  const split = splitPdfNameAndClubWithoutYear(tokens.slice(nameStartIndex, bodyweightOrder.index));
  if (!split || !split.lifterName || !split.club) return null;

  const total = parseLocaleNumber(tokens[tokens.length - 2]);
  const ipfgl = parseLocaleNumber(tokens[tokens.length - 1]);
  if (total === null || ipfgl === null) return null;

  const isSingleLift = liftType === 'bench' || liftType === 'deadlift';
  const rawAttemptTokens = tokens.slice(bodyweightOrder.index + 2, tokens.length - 2);
  let rebuiltAttemptTokens = null;
  let movementRanks = null;

  if (isSingleLift) {
    rebuiltAttemptTokens = rawAttemptTokens.slice(0, 3);
  } else if (rawAttemptTokens.length >= 12) {
    rebuiltAttemptTokens = [
      rawAttemptTokens[0], rawAttemptTokens[1], rawAttemptTokens[2],
      rawAttemptTokens[4], rawAttemptTokens[5], rawAttemptTokens[6],
      rawAttemptTokens[8], rawAttemptTokens[9], rawAttemptTokens[10],
    ];
    const squatRank = parseLocaleNumber(rawAttemptTokens[3]);
    const benchRank = parseLocaleNumber(rawAttemptTokens[7]);
    const deadliftRank = parseLocaleNumber(rawAttemptTokens[11]);
    movementRanks = {};
    if (squatRank !== null) movementRanks.squat = squatRank;
    if (benchRank !== null) movementRanks.bench = benchRank;
    if (deadliftRank !== null) movementRanks.deadlift = deadliftRank;
    if (!Object.keys(movementRanks).length) movementRanks = null;
  } else {
    rebuiltAttemptTokens = reconstructAttemptTokens(rawAttemptTokens, total);
  }
  if (!rebuiltAttemptTokens) return null;

  const attempts = isSingleLift
    ? attemptsObjectForLiftType(rebuiltAttemptTokens, liftType)
    : repairAttemptsUsingReportedTotal(attemptsObjectFromList(rebuiltAttemptTokens), total);

  return makeAthleteEntry({
    competition,
    sex,
    category: fallbackCategory || rowCategory,
    placing,
    lifterName: split.lifterName,
    yearOfBirth: null,
    club: split.club,
    bodyweight: bodyweightOrder.bodyweight,
    coefficient: null,
    order: bodyweightOrder.order,
    attempts,
    total,
    ipfgl,
    liftType,
    movementRanks,
  });
}

function parsePdfAthleteLine(line, competition, sex, fallbackCategory, liftType = 'powerlifting') {
  const tokens = normalizeSpaces(line).split(' ');
  if (tokens.length < 12) return null;

  const rowCategory = formatCategoryToken(tokens[0]);

  let nameStartIndex = 1;
  let placing = null;
  if (tokens[1] && (/^\d+$/.test(tokens[1]) || /^(DT|DQ|AI)$/i.test(tokens[1]))) {
    placing = tokens[1];
    nameStartIndex = 2;
  }

  let yearIndex = -1;
  for (let index = nameStartIndex; index < tokens.length; index += 1) {
    if (/^(19|20)\d{2}$/.test(tokens[index])) {
      yearIndex = index;
      break;
    }
  }
  if (yearIndex === -1) {
    return parsePdfAthleteLineWithoutYear(tokens, competition, sex, fallbackCategory, liftType);
  }

  const lifterName = tokens.slice(nameStartIndex, yearIndex).join(' ');
  const yearOfBirth = Number(tokens[yearIndex]);

  const categoryForBodyweight = fallbackCategory || rowCategory;
  const bodyweightOrder = findPdfBodyweightOrder(tokens, yearIndex + 1, categoryForBodyweight);
  if (!bodyweightOrder) return null;

  const club = normalizeSpaces(tokens.slice(yearIndex + 1, bodyweightOrder.index).join(' '));
  if (!club) return null;

  const total = parseLocaleNumber(tokens[tokens.length - 2]);
  const ipfgl = parseLocaleNumber(tokens[tokens.length - 1]);
  if (total === null || ipfgl === null) return null;

  const isSingleLift = liftType === 'bench' || liftType === 'deadlift';
  const rawAttemptTokens = tokens.slice(bodyweightOrder.index + 2, tokens.length - 2);
  let rebuiltAttemptTokens = null;
  let movementRanks = null;

  if (isSingleLift) {
    rebuiltAttemptTokens = rawAttemptTokens.slice(0, 3);
  } else if (rawAttemptTokens.length >= 12) {
    rebuiltAttemptTokens = [
      rawAttemptTokens[0], rawAttemptTokens[1], rawAttemptTokens[2],
      rawAttemptTokens[4], rawAttemptTokens[5], rawAttemptTokens[6],
      rawAttemptTokens[8], rawAttemptTokens[9], rawAttemptTokens[10],
    ];
    const squatRank = parseLocaleNumber(rawAttemptTokens[3]);
    const benchRank = parseLocaleNumber(rawAttemptTokens[7]);
    const deadliftRank = parseLocaleNumber(rawAttemptTokens[11]);
    movementRanks = {};
    if (squatRank !== null) movementRanks.squat = squatRank;
    if (benchRank !== null) movementRanks.bench = benchRank;
    if (deadliftRank !== null) movementRanks.deadlift = deadliftRank;
    if (!Object.keys(movementRanks).length) movementRanks = null;
  } else {
    rebuiltAttemptTokens = reconstructAttemptTokens(rawAttemptTokens, total);
  }
  if (!rebuiltAttemptTokens) return null;

  const attempts = isSingleLift
    ? attemptsObjectForLiftType(rebuiltAttemptTokens, liftType)
    : repairAttemptsUsingReportedTotal(attemptsObjectFromList(rebuiltAttemptTokens), total);

  return makeAthleteEntry({
    competition,
    sex,
    category: fallbackCategory || rowCategory,
    placing,
    lifterName,
    yearOfBirth,
    club,
    bodyweight: bodyweightOrder.bodyweight,
    coefficient: null,
    order: bodyweightOrder.order,
    attempts,
    total,
    ipfgl,
    liftType,
    movementRanks,
  });
}

async function parsePdfDocument(buffer, baseMeta) {
  const parser = new PDFParse({ data: buffer });
  const parsed = await parser.getText();
  const lines = String(parsed.text || '')
    .split(/\r?\n/)
    .map((line) => normalizeSpaces(line))
    .filter(Boolean);

  const meta = extractPdfMetadata(lines);
  const competition = buildCompetitionMeta(baseMeta, {
    name: meta.name,
    subtitle: meta.subtitle,
    locationDateText: meta.locationDateText,
  });

  const entries = [];
  let category = null;
  let currentSex = meta.sex;

  for (const line of lines) {
    if (/^MUJERES\b/i.test(line)) {
      currentSex = 'F';
      category = null;
    }
    if (/^HOMBRES\b/i.test(line)) {
      currentSex = 'M';
      category = null;
    }

    const lineCategory = formatCategoryToken(line);
    if (lineCategory) {
      category = lineCategory;
      continue;
    }

    if (!isPotentialAthleteLine(line)) continue;
    const athlete = parsePdfAthleteLine(line, competition, currentSex, category, meta.liftType);
    if (athlete) entries.push(athlete);
  }

  return repairEntriesUsingMovementRanks(entries);
}

async function parseDocument(buffer, extension, baseMeta) {
  if (extension === '.xls' || extension === '.xlsx') {
    return parseExcelDocument(buffer, {
      ...baseMeta,
      sourceType: extension.replace('.', ''),
      sourcePriority: 3,
    });
  }

  if (extension === '.pdf') {
    return parsePdfDocument(buffer, {
      ...baseMeta,
      sourceType: 'pdf',
      sourcePriority: 2,
    });
  }

  return [];
}

function attemptsCount(entry) {
  const all = [...entry.attempts.squat, ...entry.attempts.bench, ...entry.attempts.deadlift];
  return all.filter((item) => item && item.weight !== null).length;
}

function pickValue(primary, fallback) {
  return primary !== null && primary !== undefined && primary !== '' ? primary : fallback;
}

function allAttempts(entry) {
  return [
    ...(entry.attempts?.squat || []),
    ...(entry.attempts?.bench || []),
    ...(entry.attempts?.deadlift || []),
  ];
}

function failedAttemptsCount(entry) {
  return allAttempts(entry).filter((item) => item && item.weight !== null && item.good === false).length;
}

function unknownAttemptsCount(entry) {
  return allAttempts(entry).filter((item) => item && item.weight !== null && item.good !== true && item.good !== false).length;
}

function hasOnlySuccessfulAttempts(entry) {
  const attempts = allAttempts(entry).filter((item) => item && item.weight !== null);
  return attempts.length > 0 && attempts.every((item) => item.good === true);
}

function computedTotalFromAttempts(attempts) {
  return (
    bestSuccessfulWeight(attempts?.squat || []) +
    bestSuccessfulWeight(attempts?.bench || []) +
    bestSuccessfulWeight(attempts?.deadlift || [])
  );
}

function attemptsMatchReportedTotal(entry) {
  if (!entry || entry.total === null || entry.total === undefined) return false;
  const computed = computedTotalFromAttempts(entry.attempts);
  return Math.abs(computed - entry.total) < 0.26;
}

function sameAttemptShape(a, b) {
  return attemptsCount(a) === attemptsCount(b) && attemptsCount(a) > 0;
}

function pickBestAttempts(preferred, fallback) {
  const preferredCount = attemptsCount(preferred);
  const fallbackCount = attemptsCount(fallback);
  if (!fallbackCount) return preferred.attempts;
  if (!preferredCount) return fallback.attempts;

  const preferredFailed = failedAttemptsCount(preferred);
  const fallbackFailed = failedAttemptsCount(fallback);
  const preferredUnknown = unknownAttemptsCount(preferred);
  const fallbackUnknown = unknownAttemptsCount(fallback);
  const preferredMatches = attemptsMatchReportedTotal(preferred);
  const fallbackMatches = attemptsMatchReportedTotal(fallback);

  // Caso importante: Excel antiguo con todos los intentos positivos porque los
  // nulos solo iban en rojo/tachado. Si el PDF del mismo campeonato trae nulos
  // y ademas cuadra con el total oficial, usamos los intentos del PDF.
  if (
    sameAttemptShape(preferred, fallback) &&
    hasOnlySuccessfulAttempts(preferred) &&
    fallbackFailed > 0 &&
    fallbackMatches &&
    (!preferredMatches || preferred.competition?.sourceType !== 'pdf')
  ) {
    return fallback.attempts;
  }

  if (
    sameAttemptShape(preferred, fallback) &&
    hasOnlySuccessfulAttempts(fallback) &&
    preferredFailed > 0 &&
    preferredMatches
  ) {
    return preferred.attempts;
  }

  // Si una fuente cuadra con el total y la otra no, preferimos la que cuadra.
  if (fallbackMatches && !preferredMatches) return fallback.attempts;
  if (preferredMatches && !fallbackMatches) return preferred.attempts;

  // Si ambas cuadran o ninguna cuadra, preferimos la que conserva mas nulos
  // explicitos, porque suele venir del PDF con signo negativo.
  if (sameAttemptShape(preferred, fallback) && fallbackFailed > preferredFailed) {
    return fallback.attempts;
  }
  if (sameAttemptShape(preferred, fallback) && preferredFailed > fallbackFailed) {
    return preferred.attempts;
  }

  // Penalizamos intentos desconocidos cuando la otra fuente tiene estados claros.
  if (sameAttemptShape(preferred, fallback) && fallbackUnknown < preferredUnknown) return fallback.attempts;
  if (sameAttemptShape(preferred, fallback) && preferredUnknown < fallbackUnknown) return preferred.attempts;

  return preferredCount >= fallbackCount ? preferred.attempts : fallback.attempts;
}

function pickBestResultsLink(preferred, fallback, selectedAttempts) {
  if (selectedAttempts === fallback.attempts && fallback.competition?.resultsUrl) {
    return {
      resultsUrl: fallback.competition.resultsUrl,
      resultsLabel: fallback.competition.resultsLabel,
      sourceType: fallback.competition.sourceType,
    };
  }
  return {
    resultsUrl: pickValue(preferred.competition?.resultsUrl, fallback.competition?.resultsUrl),
    resultsLabel: pickValue(preferred.competition?.resultsLabel, fallback.competition?.resultsLabel),
    sourceType: pickValue(preferred.competition?.sourceType, fallback.competition?.sourceType),
  };
}

function mergePreferredEntry(preferred, fallback) {
  const selectedAttempts = pickBestAttempts(preferred, fallback);
  const bestLink = pickBestResultsLink(preferred, fallback, selectedAttempts);

  return {
    ...preferred,
    sex: pickValue(preferred.sex, fallback.sex),
    category: pickValue(preferred.category, fallback.category),
    placing: pickValue(preferred.placing, fallback.placing),
    yearOfBirth: pickValue(preferred.yearOfBirth, fallback.yearOfBirth),
    club: pickValue(preferred.club, fallback.club),
    bodyweight: pickValue(preferred.bodyweight, fallback.bodyweight),
    coefficient: pickValue(preferred.coefficient, fallback.coefficient),
    order: pickValue(preferred.order, fallback.order),
    total: pickValue(preferred.total, fallback.total),
    ipfgl: pickValue(preferred.ipfgl, fallback.ipfgl),
    liftType: pickValue(preferred.liftType, fallback.liftType),
    movementRanks: pickValue(preferred.movementRanks, fallback.movementRanks),
    attempts: selectedAttempts,
    competition: {
      ...fallback.competition,
      ...preferred.competition,
      date: pickValue(preferred.competition?.date, fallback.competition?.date),
      meetPageUrl: pickValue(preferred.competition?.meetPageUrl, fallback.competition?.meetPageUrl),
      resultsUrl: bestLink.resultsUrl,
      resultsLabel: bestLink.resultsLabel,
      sourceType: bestLink.sourceType,
      sourcePriority: Math.max(
        preferred.competition?.sourcePriority || 0,
        fallback.competition?.sourcePriority || 0
      ),
    },
  };
}

function mergeAthleteEntries(entries) {
  const byKey = new Map();

  for (const entry of entries) {
    const datePart = entry.competition.date || '';
    const competitionKey = entry.competition.meetPageUrl
      ? entry.competition.meetPageUrl
      : normalizeName(entry.competition.name || '');

    // Importante:
    // Desde que procesamos Excel + PDF de la misma competición, NO podemos
    // incluir el club en la clave de deduplicado. En algunos PDFs el texto se
    // desplaza y el club sale contaminado con peso/coeficiente/orden
    // ("ZAB 102,80", etc.). Si el club forma parte de la clave, la fila del
    // Excel y la fila del PDF no se fusionan y aparecen duplicadas.
    //
    // La identidad fiable para fusionar fuentes de un mismo resultado es:
    // atleta + página de competición + fecha + sexo + tipo de prueba.
    // Mantener liftType evita mezclar, por ejemplo, powerlifting completo con
    // una prueba de solo banca dentro del mismo evento.
    const key = [
      entry.athleteNameNormalized,
      competitionKey,
      datePart,
      entry.sex || '',
      entry.liftType || '',
    ].join('::');

    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, entry);
      continue;
    }

    const existingPriority = existing.competition.sourcePriority || 0;
    const newPriority = entry.competition.sourcePriority || 0;

    const entryBetter =
      newPriority > existingPriority ||
      (newPriority === existingPriority && attemptsCount(entry) > attemptsCount(existing));

    const preferred = entryBetter ? entry : existing;
    const fallback = entryBetter ? existing : entry;

    byKey.set(key, mergePreferredEntry(preferred, fallback));
  }

  return Array.from(byKey.values());
}

module.exports = {
  parseDocument,
  mergeAthleteEntries,
};
