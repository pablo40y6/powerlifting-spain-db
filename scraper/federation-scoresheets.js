const { pathToFileURL } = require('node:url');
const XLSX = require('xlsx');
const { normalizeName, normalizeSpaces, parseAttempt, parseLocaleNumber, parseSpanishDate } = require('./utils');
const { classLimit, publishedClass, htmlRows } = require('./history');

const MOVEMENTS = ['squat', 'bench', 'deadlift'];
const TEAM_SPAIN = /^(?:ESP|SPA|Spain|España)$/i;
const INDIVIDUAL_PLACE = /^\d+[.]?$|^(?:DQ|DSQ|DNS|DNF|DD|DT|[-—–]+)$/i;
let pdfjs;

function getPdfJs() {
  pdfjs ||= import(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href);
  return pdfjs;
}

function scoreNumber(raw) {
  const value = normalizeSpaces(raw).match(/^-?\d+(?:[.,]\d+)?/);
  return value ? parseLocaleNumber(value[0]) : null;
}

function lifterYear(value, competitionYear) {
  const number = normalizeSpaces(value).match(/^(?:(?:\d{1,2}[./]){2})?(\d{2}|\d{4})$/)?.[1];
  if (!number) return null;
  const century = Math.floor(competitionYear / 100) * 100;
  let year = number.length === 4 ? Number(number) : century + Number(number);
  if (number.length === 2 && year > competitionYear - 10) year -= 100;
  return year <= competitionYear - 10 && year >= competitionYear - 100 ? year : null;
}

function readMeetDate(text, year) {
  const value = String(text || '').replace(/\bof\s+/gi, '').replace(/([a-z]),\s+(?=\d{4}\b)/gi, '$1 ')
    .replace(/\b(\d{1,2})-(\d{1,2})-((?:19|20)\d{2})\b/g, '$1.$2.$3').replace(/−/g, '–');
  if (/^\d{4}-\d{2}-\d{2}$/.test(value) && Number(value.slice(0, 4)) === year) return value;
  const numeric = value.match(/\b(\d{1,2})\s*[.\/]\s*(\d{1,2})\s*\.?\s*[-–]\s*\d{1,2}\s*[.\/]\s*\d{1,2}\s*[.\/]\s*((?:19|20)\d{2})\b/);
  if (numeric) return readMeetDate(numeric[1] + '.' + numeric[2] + '.' + numeric[3], year);
  const range = value.match(/\b(\d{1,2})\.?\s*[-–]\s*\d{1,2}\s*[.\/]\s*(\d{1,2})\s*\.\s*((?:19|20)\d{2})\b/);
  if (range) return readMeetDate(range[1] + '.' + range[2] + '.' + range[3], year);
  const month = value.match(/\b(\d{1,2})(?:st|nd|rd|th)?(?:\s*(?:-|–|to)\s*\d{1,2}(?:st|nd|rd|th)?)?\s+([A-Z]{3,9})[.,]?\s+((?:19|20)\d{2})\b/i);
  if (month) {
    const index = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(month[2].slice(0, 3).toLowerCase());
    if (index !== -1) return readMeetDate(month[1] + '.' + (index + 1) + '.' + month[3], year);
  }
  const date = parseSpanishDate(value.replace(/(\d\.)\s+(?=\s*\d)/g, '$1'));
  return date?.getUTCFullYear() === year ? date.toISOString().slice(0, 10) : null;
}

function eventSex(text) {
  const name = normalizeName(text);
  const female = /(?:^|\s)(?:women|female|ladies|damen|femmes|femenino|mujeres)(?:$|\s| s)/.test(name);
  const male = /(?:^|\s)(?:men|male|herren|hommes|masculino|hombres)(?:$|\s| s)/.test(name);
  return female === male ? null : female ? 'F' : 'M';
}

function documentSex(text) {
  const value = normalizeName(text);
  return eventSex(value) || (/\b(?:w|f|fem|women)\b/.test(value) ? 'F' :
    /\b(?:m|mas|men)\b/.test(value) ? 'M' : null);
}

function equipmentType(text) {
  const name = normalizeName(text);
  const raw = /\b(?:raw|classic|classical|cl)\b/.test(name);
  const equipped = /\b(?:equipped|equipado|eq|equip|single ply)\b/.test(name);
  return raw === equipped ? null : raw ? 'raw' : 'equipped';
}

function rangeYear(value) {
  return Number(String(value || '').match(/\b((?:19|20)\d{2})\b/)?.[1]) || null;
}

function readPdfTable(operators, operations) {
  const marks = [];
  const strikes = [];
  let x = 0;
  let y = 0;
  let color = '#000000';
  for (const [i, code] of operators.fnArray.entries()) {
    const args = operators.argsArray[i];
    if (code === operations.beginText) { x = 0; y = 0; }
    if (code === operations.setTextMatrix) { x = args[0][4]; y = args[0][5]; }
    if (code === operations.moveText) { x += args[0]; y += args[1]; }
    if (code === operations.setFillRGBColor) color = args[0];
    if (code === operations.showText) {
      const text = normalizeSpaces(args[0].map((glyph) => glyph?.unicode || '').join(''));
      if (text) marks.push({ x, y, text, color });
    }
    if (code === operations.constructPath && args[2] && [operations.stroke, operations.fill, operations.eoFill].includes(args[0])) {
      const [left, bottom, right, top] = args[2];
      // In Goodlift exports a failed attempt is drawn as a horizontal stroke
      // or filled rectangle starting at the text, above its baseline.
      if (top - bottom <= 1.2 && right - left >= 6 && right - left <= 65) strikes.push({ left, bottom, top });
    }
  }
  const lines = [];
  for (const mark of marks.sort((a, b) => b.y - a.y || a.x - b.x)) {
    const last = lines.at(-1);
    const line = last && Math.abs(last.y - mark.y) <= 1.2 ? last : { y: mark.y, cells: [] };
    if (line !== last) lines.push(line);
    if (line.cells.some((cell) => cell.text === mark.text && Math.abs(cell.x - mark.x) < 0.2)) continue;
    const failed = /^#(?:ff0000|c00000|cc0000)$/i.test(mark.color) || strikes.some((line) =>
      Math.abs(line.left - mark.x) < 1.2 && line.bottom - mark.y >= 0.65 && line.top - mark.y <= 5);
    line.cells.push({ ...mark, failed });
  }
  return lines.map((line) => line.cells.sort((a, b) => a.x - b.x));
}

function attemptFromCell(cell) {
  const raw = cell?.text;
  const number = scoreNumber(raw);
  if (!number) return parseAttempt(raw);
  const attempt = parseAttempt(number);
  return { raw, weight: attempt.weight, good: cell.failed ? false : attempt.good };
}

function bestOfAttempts(attempts) {
  return Math.max(0, ...attempts.filter((attempt) => attempt.good).map((attempt) => attempt.weight)) || null;
}

function reportTitle(lines, fallback) {
  const titles = lines.filter((line) => /champion|cup|games/i.test(line) && !/nominat|federation|generated|coefficient/i.test(line));
  const best = titles.find((line) => /classic|equipped/i.test(line)) || titles.find((line) => line.length > 20);
  if (!best || best.length > 200) return fallback;
  return best.replace(/,\s*[^,]*\([^)]*\),.*$/, '').replace(/\s*\bDETAILED SCORESHEET\b.*$/i, '');
}

function federationRow(meta, { name, yearOfBirth, sex, category, equipment, placing, bodyweight, attempts, bestLifts, total, ipfgl, points }) {
  if (!sex || !equipment || !category || (!bodyweight && meta.year >= 2011) ||
    !/^[\p{L}][\p{L}\s.,'’()-]+$/u.test(name) || !INDIVIDUAL_PLACE.test(placing)) return null;
  const expected = meta.eventType === 'powerlifting' ? MOVEMENTS : [meta.eventType];
  const rankable = Boolean(total > 0 && /^\d+\.?$/.test(placing) && expected.every((lift) => bestLifts[lift]) &&
    Math.abs(total - expected.reduce((sum, lift) => sum + bestLifts[lift], 0)) <= 0.01);
  if (!rankable && /^\d+\.?$/.test(placing)) return null;
  return {
    athleteName: name, athleteNameNormalized: normalizeName(name), sex, yearOfBirth, category, equipment,
    placing: placing.replace(/\.$/, ''), country: 'ESP', countrySource: meta.url, club: 'España',
    attempts, bestLifts, bodyweight, total: rankable ? total : null, ipfgl: rankable ? ipfgl : null,
    ...(rankable && points > 0 && { historicalPoints: points, historicalPointsLabel: 'Wilks' }),
    sourceFederation: meta.fed, resultArchive: 'Acta oficial', eventType: meta.eventType, liftType: meta.eventType,
    isRankable: rankable, isIndividualResult: true, hasValidPowerliftingTotal: rankable,
    competition: {
      name: meta.title, date: meta.date, dateApproximate: true, year: meta.year, resultsUrl: meta.url,
      meetPageUrl: meta.page, meetPageTitle: meta.title, resultsLabel: meta.label || 'Acta oficial',
      sourcePriority: 8, sourceType: meta.sourceType || 'pdf',
    },
  };
}

function parsePdfScoreRows(rows, meta, context = {}) {
  const pageText = rows.map((line) => line.map(({ text }) => text).join(' '));
  const heading = reportTitle(pageText, meta.title);
  const file = new URL(meta.url).pathname.split('/').at(-1);
  const sex = [...pageText.filter((line) => /women.s|men.s|female|male|women |men /i.test(line) && /champion|cup|masters/i.test(line))]
    .map(eventSex).find(Boolean) || documentSex(meta.header || '') || documentSex(file) || context.sex;
  const equipment = equipmentType(file) || equipmentType(heading) || equipmentType(meta.header) || equipmentType(meta.title) ||
    (meta.year <= 2010 ? 'equipped' : context.equipment);
  const titleType = /bench.?press|bench.classic|bench.press|bpress/i.test(heading + ' ' + meta.title + ' ' + file) ? 'bench' : 'powerlifting';
  const eventType = /deadlift(?:\s+only)?\s+champion/i.test(heading) ? 'deadlift' : titleType;
  const date = context.date || [meta.date, ...pageText.filter((line) => !/\bESP\b/.test(line) && line.length <= 150)]
    .map((line) => readMeetDate(line, meta.year)).find(Boolean) || null;
  context.sex = sex;
  context.equipment = equipment;
  context.date = date;
  let category = context.category || null;
  const entries = [];
  for (const cells of rows) {
    const first = cells[0]?.text;
    if (cells.length <= 3 && /^\s*[+−-]?\s*\d{2,3}(?:[.,]5)?\+?\s*kg\b/i.test(first || '')) {
      category = publishedClass(first.replace('−', '-')) || category;
    }
    const nation = cells.findIndex(({ text }) => TEAM_SPAIN.test(text));
    if (nation < 2 || !INDIVIDUAL_PLACE.test(first || '')) continue;
    const name = cells.slice(1, nation - 1).map(({ text }) => text).join(' ');
    const yearOfBirth = lifterYear(cells[nation - 1]?.text, meta.year);
    const values = cells.slice(nation + 1);
    const bodyweight = scoreNumber(values[0]?.text);
    if (!(bodyweight >= 30 && bodyweight <= 250) || !sex) continue;
    const catLimit = Number(category?.slice(1, -2));
    const weightClass = (category && (category[0] === '+' ? bodyweight > catLimit : bodyweight <= catLimit + 0.01)) ? category
      : (meta.year <= 2020 ? classLimit(sex, bodyweight, meta.year)
        : publishedClass('-' + (sex === 'F' ? [43, 47, 52, 57, 63, 69, 76, 84] : [53, 59, 66, 74, 83, 93, 105, 120]).find((value) => bodyweight <= value + 0.01) + 'kg') || (sex === 'F' ? '+84kg' : '+120kg'));
    const full = values.length >= 16;
    if (!full && (eventType === 'powerlifting' || values.length < 7)) continue;
    const liftOffsets = eventType === 'powerlifting' ? { squat: 3, bench: 7, deadlift: 11 } :
      { [eventType]: full && eventType === 'bench' ? 7 : 3 };
    const attempts = Object.fromEntries(Object.entries(liftOffsets).map(([lift, start]) =>
      [lift, values.slice(start, start + 3).map(attemptFromCell)]));
    const bestLifts = Object.fromEntries(Object.entries(attempts).map(([lift, tries]) => [lift, bestOfAttempts(tries)]));
    const totalIndex = full ? 15 : 6;
    let total = scoreNumber(values[totalIndex]?.text);
    if (eventType !== 'powerlifting' && total !== bestLifts[eventType] && scoreNumber(values[totalIndex + 1]?.text) === bestLifts[eventType]) total = bestLifts[eventType];
    const scoreIndex = full ? 16 : (scoreNumber(values[6]?.text) === total ? 7 : 8);
    const score = scoreNumber(values[scoreIndex]?.text);
    const report = federationRow({ ...meta, title: heading, date, eventType }, {
      name, yearOfBirth, sex, category: weightClass, equipment, placing: first, bodyweight, attempts, bestLifts, total,
      ipfgl: meta.year >= 2021 && score > 0 && score <= 150 ? score : null,
      points: meta.year <= 2019 ? score : null,
    });
    if (report) entries.push(report);
  }
  context.category = category;
  return entries;
}

function textRows(items) {
  const lines = new Map();
  for (const item of items) {
    const text = normalizeSpaces(item.str);
    if (!text) continue;
    const y = Math.round(item.transform[5] * 2) / 2;
    if (!lines.has(y)) lines.set(y, []);
    lines.get(y).push({ text, x: item.transform[4] });
  }
  return [...lines].sort(([a], [b]) => b - a).map(([, cells]) =>
    cells.sort((a, b) => a.x - b.x).map((cell) => cell.text));
}

function parsePublishedPdf(rows, meta, context) {
  const header = rows.find((row) => row.includes('YOB') && row.includes('IPF GL Points') && row.includes('Total'));
  if (!header) return null;
  const file = new URL(meta.url).pathname.split('/').at(-1);
  const title = reportTitle(rows.slice(0, 8).map((row) => row.join(' ')), context.title || meta.title);
  const date = rows.slice(0, 8).map((row) => readMeetDate(row.join(' '), meta.year)).find(Boolean) || context.date;
  const sex = documentSex(file) || documentSex(meta.header) || context.sex;
  const equipment = equipmentType(file) || equipmentType(title) || equipmentType(meta.header) || context.equipment;
  const eventType = /bench press/i.test(title) ? 'bench' : 'powerlifting';
  const columns = Object.fromEntries(header.map((column, i) => [column, i]));
  Object.assign(context, { title, date, sex, equipment });
  const results = [];
  for (const row of rows) {
    if (row.length === 1) {
      const weightClass = row[0].match(/([+-]?\s*\d{2,3}\+?\s*kg)\s*$/i)?.[1];
      if (weightClass) context.category = publishedClass(weightClass);
    }
    if (row[columns.Team] !== 'ESP') continue;
    const values = row.filter((value) => !/^(?:w|wj|ws|e|ej|es|n|nj|ns)[1-4]?$/i.test(value));
    if (values.length !== header.length) continue;
    const bestLifts = {};
    const attempts = {};
    for (const [move, short] of [['squat', 'SQ'], ['bench', 'BP'], ['deadlift', 'DL']]) {
      if (eventType === 'bench' && move !== 'bench') continue;
      const first = columns[short + '1'];
      const best = scoreNumber(values[columns[short + ' [PL]']]);
      bestLifts[move] = best;
      attempts[move] = values.slice(first, first + 3).map((value) => {
        const attempt = parseAttempt(scoreNumber(value) || value);
        return { ...attempt, raw: value, good: attempt.good === false || (best && attempt.weight > best) ? false : null };
      });
    }
    const result = federationRow({ ...meta, title, date, eventType }, {
      name: values[columns.Name], yearOfBirth: lifterYear(values[columns.YOB], meta.year), sex, equipment,
      category: context.category, placing: values[columns.Place], bodyweight: scoreNumber(values[columns['Bd. Wt.']]),
      total: scoreNumber(values[columns.Total]), ipfgl: scoreNumber(values[columns['IPF GL Points']]), bestLifts, attempts,
    });
    if (result) results.push(result);
  }
  return results;
}

async function readFederationPdf(buffer, meta) {
  const lib = await getPdfJs();
  const document = await lib.getDocument({ data: Uint8Array.from(buffer), verbosity: 0, disableFontFace: true }).promise;
  const entries = [];
  const context = {};
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      if (meta.fed === 'IPF' && meta.year >= 2025) {
        const published = parsePublishedPdf(textRows((await page.getTextContent()).items), meta, context);
        if (published) {
          entries.push(...published);
          page.cleanup();
          continue;
        }
      }
      const rows = readPdfTable(await page.getOperatorList(), lib.OPS);
      if (!meta.year) {
        const header = rows.slice(0, 8).flatMap((row) => row.map(({ text }) => text)).join(' ');
        meta.year = rangeYear(header);
      }
      if (meta.year) entries.push(...parsePdfScoreRows(rows, meta, context));
      page.cleanup();
    }
    return entries;
  } finally { await document.destroy(); }
}

function workbookRows(workbook, sheetName) {
  const sheet = workbook.Sheets[sheetName];
  const values = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: true, raw: false });
  const range = sheet['!ref'] ? XLSX.utils.decode_range(sheet['!ref']) : null;
  if (!range) return [];
  return values.map((row, r) => row.map((value, c) => {
    const cell = sheet[XLSX.utils.encode_cell({ r: r + range.s.r, c: c + range.s.c })];
    return { text: normalizeSpaces(value), failed: cell?.s?.font?.strike === true };
  })).filter((row) => row.some(({ text }) => text));
}

function historicalNumber(value) {
  return scoreNumber(value?.replace(/(\d[.,])\s+(?=\d)/g, '$1'));
}

function archivedRow(cells, header, competitionYear) {
  const values = cells.map(({ text }) => text);
  const nation = values.findIndex((value) => TEAM_SPAIN.test(value));
  const first = values[0] || '';
  const format = (placing, name, birth, bw, column) => ({
    placing, name: name?.replaceAll('/', ' ').trim(), yearOfBirth: lifterYear(birth, competitionYear),
    bodyweight: historicalNumber(bw), column,
  });
  const oldName = first.match(/^(\d+\s*\.?|[-–—]+\.?)[\s]*(\p{L}.*?)\/(\d{2}|[.]+)$/u);
  if (nation === 2 && oldName) return { ...format(oldName[1].includes('-') ? 'DQ' : oldName[1].replaceAll(' ', ''), oldName[2], oldName[3], values[1], nation + 1), layout: 'best' };
  const oldInline = first.match(/^(\d+\.?)\s+(\p{L}.*?)\/?\s+(\d{2})\s+(\d{2,3}[.,]\d+)\s+(?:ESP|Spain)\s+(.*)$/iu);
  if (oldInline) return { ...format(oldInline[1], oldInline[2], oldInline[3], oldInline[4], 0),
    layout: 'best', inlineScores: oldInline[5].split(/\s+/).map((text) => ({ text })) };
  const inlineCountry = values[1]?.match(/^(\d{2,3}[.,]\s*\d+)\s+(?:Spain|ESP)$/i);
  if (inlineCountry && oldName) return { ...format(oldName[1].trim(), oldName[2], oldName[3], inlineCountry[1], 2), layout: 'best' };
  if (nation !== 3 || !INDIVIDUAL_PLACE.test(first)) return null;
  const birthAndWeight = values[2]?.match(/^(\d{4})\/(\d{2,3}[.,]\d+)$/);
  if (birthAndWeight) return { ...format(first, values[1], birthAndWeight[1], birthAndWeight[2], 4), layout: 'ranked' };
  if (historicalNumber(values[1]) > 30 && /\p{L}/u.test(values[2] || '')) {
    return { ...format(first, values[2], '', values[1], 4), layout: 'publishedBest' };
  }
  const rankAt = header.indexOf('total') - nation - 2;
  if (rankAt === 3) return { ...format(first, values[1], values[2], values[4], 5), layout: 'best' };
  const layout = rankAt === 6 || rankAt === 7 ? 'ranked' : 'attempts';
  return { ...format(first, values[1], values[2], values[4], 5), layout };
}

function archivedAttempts(cells, header, source, layout) {
  const totalAt = header.indexOf('total');
  const start = source.column;
  const cellsAt = (indices) => indices.map((i) => cells[i] || { text: '' });
  if (layout === 'best' || layout === 'publishedBest' || layout === 'ranked') {
    const packed = source.inlineScores || cells;
    const offsets = layout === 'publishedBest' ? [3, 7, 11, 12] : layout === 'ranked' ? [0, 2, 4, 6] : [0, 1, 2, 3];
    const base = layout === 'ranked' && start === 5 ? start + 1 : start;
    const values = offsets.map((offset) => historicalNumber(packed[base + offset]?.text));
    if (totalAt > 0 && layout === 'ranked') values[3] = historicalNumber(cells[totalAt]?.text);
    return {
      bestLifts: Object.fromEntries(MOVEMENTS.map((movement, i) => [movement, values[i] > 0 ? values[i] : null])),
      attempts: {}, total: values[3],
    };
  }
  const first = header.findIndex((word) => /^(?:all )?(?:squat|sq)(?:\b|\d)/.test(word));
  const bench = header.findIndex((word) => /^(?:all )?(?:bench|bp)(?:\b|\d)/.test(word));
  const deadlift = header.findIndex((word) => /^(?:all )?(?:dead|dl)/.test(word));
  if (first < start || bench < first + 3 || deadlift < bench + 3 || totalAt < deadlift + 3) return null;
  const total = historicalNumber(cells[totalAt]?.text);
  const attempts = Object.fromEntries(MOVEMENTS.map((lift, i) => [lift, cellsAt([0, 1, 2].map((j) => [first, bench, deadlift][i] + j)).map(attemptFromCell)]));
  const bestLifts = Object.fromEntries(MOVEMENTS.map((lift) => [lift, bestOfAttempts(attempts[lift])]));
  if (total > 0 && MOVEMENTS.reduce((sum, lift) => sum + bestLifts[lift], 0) !== total) {
    // Some old Excel exports omit the colour of failed lifts. A unique
    // combination matching the official total still identifies the best lifts.
    const choices = MOVEMENTS.map((lift) => [...new Set(attempts[lift].filter(({ weight, good }) => weight && good !== false).map(({ weight }) => weight))]);
    const solutions = choices[0].flatMap((sq) => choices[1].flatMap((bp) => choices[2].filter((dl) => Math.abs(sq + bp + dl - total) <= 0.01).map((dl) => [sq, bp, dl])));
    if (solutions.length !== 1) return null;
    for (const [index, lift] of MOVEMENTS.entries()) {
      bestLifts[lift] = solutions[0][index];
      attempts[lift] = attempts[lift].map((attempt) => ({
        ...attempt, good: !attempt.weight ? null : attempt.good === false || attempt.weight > bestLifts[lift] ? false : null,
      }));
    }
  }
  return { attempts, bestLifts, total };
}

function parseArchivedTable(rows, meta, sheetName) {
  const file = new URL(meta.url).pathname.split('/').at(-1);
  const opening = rows.slice(0, 12).map((row) => row.map(({ text }) => text).join(' ').trim());
  const year = rangeYear(opening.join(' ')) || sourceYearFromSheet(sheetName) || meta.year;
  if (!year) return [];
  const archiveTitle = reportTitle(opening, meta.title);
  const initialSex = eventSex(archiveTitle) || documentSex(file.replace(/(^|_)\d+(?=_)/, '$1')) ||
    (/^(?:M\.|MEN)/i.test(sheetName) ? 'M' : /^W\.?\d/i.test(sheetName) ? 'F' : null);
  let sex = initialSex;
  let date = opening.map((line) => readMeetDate(line, year)).find(Boolean) || null;
  let equipment = equipmentType(archiveTitle) || equipmentType(meta.header) || (year <= 2011 ? 'equipped' : null);
  let title = archiveTitle;
  let category = null;
  let header = [];
  const entries = [];
  for (const cells of rows) {
    const values = cells.map(({ text }) => text);
    const nonempty = values.filter(Boolean);
    const line = nonempty.join(' ');
    if (nonempty.length <= 2) {
      const headingSex = eventSex(line) || (/\b(?:zeny|damy|dames)\b/.test(normalizeName(line)) ? 'F' :
        /\b(?:muzi|heren)\b/.test(normalizeName(line)) ? 'M' : null);
      if (headingSex) sex = headingSex;
      if (/champion|cup/i.test(line) && !TEAM_SPAIN.test(line) && line.length < 180) {
        title = line;
        equipment = equipmentType(title) || equipment;
        date = readMeetDate(title, year) || date;
      }
      category = publishedClass(line.replace('−', '-')) || category;
    }
    const columns = values.map(normalizeName);
    const totalIndex = columns.findIndex((column) => /^(?:tot|total)(?: kg)?$/.test(column));
    if (totalIndex !== -1 && columns.some((column) => /^(?:name|lifters?|squat|sq|all squat)/.test(column))) {
      columns[totalIndex] = 'total';
      header = columns;
      category = publishedClass(values[0]) || category;
    }
    if (!sex || !equipment) continue;
    const source = archivedRow(cells, header, year);
    if (!source?.name || (source.bodyweight ? !(source.bodyweight >= 30 && source.bodyweight <= 250) : !category || year >= 2011)) continue;
    const scores = archivedAttempts(cells, header, source, source.layout);
    if (!scores) continue;
    const expectedClass = classLimit(sex, source.bodyweight, year);
    const validClass = category && (!source.bodyweight || (category[0] === '+' ? source.bodyweight > Number(category.slice(1, -2)) :
      source.bodyweight <= Number(category.slice(1, -2)) + 0.01));
    const result = federationRow({ ...meta, year, title, date, eventType: 'powerlifting', sourceType: 'archive' }, {
      ...source, ...scores, sex, equipment, category: validClass ? category : expectedClass,
    });
    if (result) entries.push(result);
  }
  return entries;
}

function sourceYearFromSheet(name) {
  const year = name.match(/^(?:WEC|EU)((?:19|20)\d{2})/i)?.[1];
  return year ? Number(year) : null;
}

function readFederationTable(buffer, meta, ext) {
  if (/\.html?$/i.test(ext)) return parseArchivedTable(htmlRows(buffer).map((row) => row.map((cell) => ({ text: cell.value, failed: cell.failed }))), meta, '');
  const workbook = XLSX.read(buffer, { cellStyles: true, cellNF: true });
  return workbook.SheetNames.flatMap((sheetName) => parseArchivedTable(workbookRows(workbook, sheetName), meta, sheetName));
}

module.exports = { readFederationPdf, readFederationTable, readPdfTable, parsePdfScoreRows, readMeetDate, eventSex, documentSex, federationRow, lifterYear };
