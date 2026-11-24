const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const cheerio = require('cheerio');
const pLimit = require('p-limit').default;
const XLSX = require('xlsx');
const { PDFParse } = require('pdf-parse');
const { normalizeName, normalizeSpaces, parseLocaleNumber, parseSpanishDate, parseAttempt } = require('./utils');
const { clubAliasPairs } = require('./clubs');

const ROOT = 'https://www.powerhispania.net/Resultados/';
const CACHE = process.env.PLS_HISTORY_DIR || path.join(os.tmpdir(), 'codex-aep-history', 'cache');
const YEARS = Array.from({ length: 28 }, (_, index) => 1993 + index);
const LIFTS = { squat: 'S', bench: 'B', deadlift: 'D' };
const OFFICIAL_HOSTS = /^(?:www\.)?(?:powerhispania\.net|powerliftingspain\.es)$/i;
const NO_RESULT = /^(?:dt|dq|dsq|dns|dnf|descalificado|retirado|no presentado)$/i;
const ARCHIVE_FIXES = {
  '2019/NorOeste_Power_Fem_2019.htm|Hombres': '2019/Noroeste_Power_Mas_2019.htm',
  '2020/NorOeste_Power_Leon_Fem.htm|Mujeres': '2020/Noroeste_Power_Leon_Fem.htm',
  '2020/NorOeste_Power_Leon_Mas.htm|Hombres': '2020/Noroeste_Power_Leon_Mas.htm',
};
const CASE_CORRECTIONS = new Map([
  'Power_Orgiva_Mujeres_Raw_2016.htm',
  'Power_Orgiva_Hombres_Equip_2016.htm',
  'Power_Orgiva_Hombres_Raw_2016.htm',
  'Banca_Madrid_Mujeres_Raw_2016.htm',
  'Banca_Madrid_Hombres_Raw_2016.htm',
  'Banca_Madrid_Hombres_Equip_2016.htm',
].map((name) => ['2016/' + name.toLowerCase(), '2016/' + name]));
const CADIZ_CLUBS = [
  'FG POWER ALHAURÍN', 'AD SIDERÓPOLIS', 'ASOCIACIÓN ANDALUZA', 'LIFTERS SQUAD',
  'POWER EXPLOSIVE', 'POWEREXPLOSIVE', 'GIMNASIO CROM', 'BOX LINARES', 'MÁLAGA POWER TEAM',
  'BASIC STRENGTH', 'ASOCIACIÓN ASTURIANA', 'MÁS QUE FUERZA', 'CROSSFIT DB', 'IRONBORN',
  'FUERZA GRANADA', 'POWER TORDESILLAS', 'IRON TEAM', 'POWER PATERNA', 'POWERLIFTING SALAMANCA',
  'DESHAFIO PINTO', 'BOSS FITNESS', 'MONTOCAN', 'COLISEO', 'ENERGY', 'AFA',
];

function archiveYearUrl(year) {
  return ROOT + year + '/' + ([1998, 1999].includes(year) ? 'resultados.html' : 'Resultados.html');
}

function archiveLinks(buffer, url, year) {
  const $ = cheerio.loadBuffer(buffer);
  const documents = new Map();
  $('a[href]').each((_, element) => {
    const link = $(element);
    const href = new URL(link.attr('href'), url);
    if (!OFFICIAL_HOSTS.test(href.hostname) || !href.pathname.startsWith('/Resultados/') ||
        !/\.(?:html?|pdf|xlsx?)$/i.test(href.pathname) || /\/resultados\.html$/i.test(href.pathname)) return;
    const label = normalizeSpaces(link.text());
    const context = normalizeSpaces(link.closest('p,li,td').text()).replace(/^[-–>]\s*/, '');
    if (!label || /por repeticiones|\breps\b|equipos? por puntos/i.test(label)) return;
    const description = context.length > 180 || !context ? label : context;
    const relative = href.pathname.slice('/Resultados/'.length);
    const fixed = ARCHIVE_FIXES[relative + '|' + label] || CASE_CORRECTIONS.get(relative.toLowerCase());
    const resultUrl = fixed ? ROOT + fixed : href.href;
    if (!documents.has(resultUrl)) documents.set(resultUrl, { url: resultUrl, page: url, label, description, year });
  });
  return [...documents.values()];
}

function archiveSheets(buffer, url) {
  const $ = cheerio.loadBuffer(buffer);
  const files = new Set();
  $('frame[src],a[href],link[href]').each((_, node) => {
    const raw = $(node).attr('src') || $(node).attr('href');
    if (!raw || !/(?:sheet\d+\.htm|\.xlsx?$|\.pdf$)/i.test(raw)) return;
    const child = new URL(raw, url);
    if (OFFICIAL_HOSTS.test(child.hostname) && child.pathname.startsWith('/Resultados/') && child.href !== url) files.add(child.href);
  });
  return [...files];
}

function htmlRows(buffer, archiveCss = '') {
  const $ = cheerio.loadBuffer(buffer);
  const failStyle = /(?:text-decoration\s*:\s*line-through|(?:^|[;\s])color\s*:\s*(?:red|#(?:f00|ff0000|c00000))(?=\s*[;}]|$))/i;
  const failedClasses = new Set();
  const css = $('style').text() + '\n' + archiveCss;
  for (const [, selectors, rules] of css.matchAll(/([^{}]+)\{([^{}]*)}/g)) {
    if (failStyle.test(rules)) for (const [, name] of selectors.matchAll(/\.([\w-]+)/g)) failedClasses.add(name);
  }
  function readCell(cell) {
    const node = $(cell);
    const value = normalizeSpaces(node.text());
    const attributes = [cell, ...node.find('[style],[class],[color],s,strike,del').toArray()].map((child) => ({
      tag: child.name,
      style: $(child).attr('style') || '',
      color: $(child).attr('color') || '',
      cssClasses: ($(child).attr('class') || '').split(/\s+/),
    }));
    const failed = attributes.some((item) => /^(?:s|strike|del)$/.test(item.tag) ||
      failStyle.test(item.style) || /^(?:red|#ff0000)$/i.test(item.color) ||
      item.cssClasses.some((name) => failedClasses.has(name)));
    const width = Math.min(32, Math.max(1, Number(node.attr('colspan')) || 1));
    const height = Math.min(64, Math.max(1, Number(node.attr('rowspan')) || 1));
    return { value, failed, width, height };
  }
  let table = null;
  let spanning = new Map();
  return $('tr').toArray().map((element) => {
    const parent = $(element).closest('table').get(0);
    if (parent !== table) {
      spanning = new Map();
      table = parent;
    }
    const occupied = spanning;
    spanning = new Map([...occupied].filter(([, remaining]) => remaining > 1)
      .map(([column, remaining]) => [column, remaining - 1]));
    const row = [];
    const blank = { value: '', width: 0 };
    for (const raw of $(element).children('td,th').toArray()) {
      while (occupied.has(row.length)) row.push(blank);
      const cell = readCell(raw);
      const column = row.length;
      row.push(cell, ...Array.from({ length: cell.width - 1 }, () => blank));
      if (cell.height > 1) {
        for (let index = column; index < row.length; index++) spanning.set(index, cell.height - 1);
      }
    }
    return row;
  }).filter((row) => row.some((cell) => cell.value));
}

function historicalSex(text) {
  const value = normalizeName(text);
  const female = /\b(?:femenin[oa]s?|feminas?|mujeres|women|dames)\b/.test(value);
  const male = /\b(?:masculin[oa]s?|hombres|varones|men)\b/.test(value);
  return female === male ? null : female ? 'F' : 'M';
}

function historicalEquipment(text) {
  const value = normalizeName(text);
  if (/\b(?:raw|classic|clasico|sin (?:equipacion|material soportivo))\b/.test(value)) return 'raw';
  if (/\b(?:equipad[oa]s?|equip|equipped|con material soportivo)\b/.test(value)) return 'equipped';
  return null;
}

function liftHeading(value) {
  const text = normalizeName(value);
  if (/^(?:sentadillas?|sent|squat|sq)(?:\b|\d)/.test(text)) return 'squat';
  if (/^(?:press (?:de )?banca|p banca|banca|bench|pb|p b)(?:\b|\d)/.test(text)) return 'bench';
  if (/^(?:peso (?:muerto|m)|deadlift|pm|p (?:m|muerto))(?:\b|\d)/.test(text)) return 'deadlift';
  return null;
}

function classLimit(sex, weight, year) {
  const old = Number(year) < 2011;
  const limits = old
    ? { F: [44, 48, 52, 56, 60, 67.5, 75, 82.5, 90], M: [52, 56, 60, 67.5, 75, 82.5, 90, 100, 110, 125] }
    : { F: [43, 47, 52, 57, 63, 72, 84], M: [53, 59, 66, 74, 83, 93, 105, 120] };
  const classes = limits[sex];
  if (!classes || !Number.isFinite(weight)) return null;
  const limit = classes.find((value) => weight <= value + 0.001);
  return limit ? '-' + limit + 'kg' : '+' + classes.at(-1) + 'kg';
}

function publishedClass(value) {
  const match = normalizeSpaces(value).match(/^([+-])?\s*(\d{2,3}(?:[.,]5)?)\s*(\+)?\s*(?:kg)?$/i);
  if (!match) return null;
  const limit = Number(match[2].replace(',', '.'));
  if (limit < 40 || limit > 145) return null;
  return (match[1] === '+' || match[3] ? '+' : '-') + limit + 'kg';
}

function findLayout(row, previous, context) {
  const names = row.map((cell) => normalizeName(cell.value));
  const above = previous?.map((cell) => normalizeName(cell.value)) || [];
  const index = (pattern) => names.findIndex((cell) => pattern.test(cell));
  const person = /^(?:nombre(?: y apellidos)?|apellidos(?: y nombre)?|levantador[ae]?(?:s)?|deportista|competidor[ae]?|resultados|femenino|masculino|mujeres|hombres|feminas)(?: \d+)?$/;
  const weighing = /^(?:peso(?: corporal)?(?: kg)?|p corp(?:oral)?|p corporal kg)$/;
  const name = index(person) < 0 ? above.findIndex((cell) => person.test(cell)) : index(person);
  const weight = index(weighing) < 0 ? above.findIndex((cell) => weighing.test(cell)) : index(weighing);
  if (name < 0 || weight < 0) return null;
  const direct = {};
  const attempts = {};
  const score = /^(?:total(?: kg)?|marca(?: kg)?|mejor (?:marca|intento))$/;
  const total = index(score) < 0 ? above.findIndex((cell) => score.test(cell)) : index(score);
  const pointHeading = /^(?:wilks(?: puntos)?|puntos wilks|(?:pt )?ipf(?: gl)?|puntos ipf|gl|puntos)$/;
  const points = index(pointHeading) < 0 ? above.findIndex((cell) => pointHeading.test(cell)) : index(pointHeading);
  const movements = new Map();
  for (const [i, cell] of names.entries()) {
    const tagged = cell.match(/^(sq|pb|pm|sent|banca)(?:\s*)([1-3])$/);
    if (tagged) {
      const lift = liftHeading(tagged[1]);
      (attempts[lift] ||= [])[Number(tagged[2]) - 1] = i;
      continue;
    }
    const lift = liftHeading(cell);
    if (lift && i > weight && !movements.has(lift)) movements.set(lift, i);
  }
  const numbered = row.map((cell, i) => /^(?:[123](?:[ºª°]|\s*intento)|[123]\.(?:er|o)?)$/i.test(cell.value) ? i : -1).filter((i) => i > weight);
  for (const [lift, i] of movements) {
    if (row[i].width >= 3) attempts[lift] = [i, i + 1, i + 2];
    else direct[lift] = i;
  }
  if (numbered.length >= 3) {
    const groups = Object.keys(LIFTS).filter((lift) => previous?.some((cell) => liftHeading(cell.value) === lift));
    const solo = /peso muerto|\bpmuerto\b/.test(context) ? 'deadlift' : /banca|bench/.test(context) ? 'bench' : null;
    const order = numbered.length >= 9 ? Object.keys(LIFTS) : [...new Set([...groups, ...movements.keys()])];
    if (order.length === numbered.length / 3 || (numbered.length === 3 && solo)) {
      for (const [i, lift] of (order.length === numbered.length / 3 ? order : [solo]).entries()) {
        attempts[lift] = numbered.slice(i * 3, i * 3 + 3);
      }
    }
  }
  const solo = /(?:banca|press|bench)/.test(context) && !/powerlifting|power/.test(context) ? 'bench'
    : /(?:peso muerto|pmuerto|deadlift)/.test(context) && !/powerlifting|power/.test(context) ? 'deadlift' : null;
  if (solo && total >= 0 && !Object.keys(attempts).length && !Object.keys(direct).length) direct[solo] = total;
  const lifts = Object.keys(LIFTS).filter((lift) => attempts[lift]?.length === 3 || direct[lift] !== undefined);
  // A summary with a total alone cannot establish the three best lifts.
  if (lifts.length === 1 && total < 0 && direct[lifts[0]] === undefined) return null;
  if (lifts.length !== 1 && lifts.length !== 3) return null;
  if (lifts.length === 1 && !attempts[lifts[0]] && total < 0 && !previous?.some((cell) => /^\s*(?:mujeres|hombres|clasificacion)/i.test(cell.value))) return null;
  const sex = index(/^(?:sexo|m h)$/);
  return {
    name, weight, attempts, direct, total, points, lifts,
    club: index(/^(?:club(?: o equip[oa])?|equipo|gimnasio|team)$/) < 0
      ? above.findIndex((cell) => /^(?:club|gimnasio|team)$/.test(cell)) : index(/^(?:club(?: o equip[oa])?|equipo|gimnasio|team)$/),
    category: index(/^(?:cat|categoria)(?: kg| peso(?: corporal)?)?$/),
    birth: index(/^(?:ano(?: nacimiento)?|f n|f nacim|fecha (?:de )?nacimiento|nacimiento)$/),
    place: index(/^(?:pl|pos|puesto|clas|cl|clasificacion|posicion)$/),
    sex,
    spanishSexCodes: names[sex] === 'm h',
    pointsLabel: points < 0 ? null : row[points]?.value || previous?.[points]?.value,
  };
}

function numeric(cell) {
  const value = parseLocaleNumber(cell?.value?.replace(/\s*-?\s*(?:RA|RJ|RS|RM[1-4]|RC)(?:\s*)$/i, ''));
  return Number.isFinite(value) && value > 0 ? value : null;
}

function dateFromArchive(text, year) {
  const normalized = normalizeSpaces(text).replace(/(\d)[- ]([a-záéíóú]{3,10})[-.](?=\s*\d{4})/gi, '$1 $2 ')
    .replace(/\b(\d{1,2}([./])\d{1,2}\2)(\d{2})\b/g, (value, dayMonth, separator, short) =>
      Number(short) === year % 100 ? dayMonth + year : value);
  const date = parseSpanishDate(normalized);
  return date?.getUTCFullYear() === year ? date.toISOString().slice(0, 10) : null;
}

function archiveRow(row, layout, context) {
  const { year, date, document, category, equipment, title, extract } = context;
  const rowSex = row[layout.sex]?.value?.toUpperCase();
  const sex = rowSex === 'H' ? 'M' : rowSex === 'F' ? 'F' :
    rowSex === 'M' ? (layout.spanishSexCodes ? 'F' : context.sex || 'M') : context.sex;
  if (!sex) return null;
  const originalName = row[layout.name]?.value || '';
  const name = originalName.replace(/\s*\/\s*\d{2}$/, '').trim();
  if (name.split(/\s+/).length < 2 || !/^[\p{L}][\p{L}\s.'’()-]+$/u.test(name) ||
      /\b(?:clasificacion|resumen|nombre|equipo|powerlifting|asociacion|gimnasio|club|wilks)\b/.test(normalizeName(name))) return null;
  const weight = numeric(row[layout.weight]);
  const listedClass = publishedClass(row[layout.category]?.value) || category;
  if ((!weight && !listedClass) || (weight && (weight < 30 || weight > 250))) return null;
  const eventType = layout.lifts.length === 3 ? 'powerlifting' : layout.lifts[0];
  let placing = row[layout.place]?.value || row[layout.name - 1]?.value || '';
  placing = /^(?:\d+[ºª.]?|AI|DT|DQ|DSQ|DNS|DNF|[-–—]+)$/i.test(placing) ? placing.replace(/[ºª.]$/, '') : null;
  const moves = {};
  const bestLifts = {};
  for (const lift of layout.lifts) {
    const cells = layout.attempts[lift]?.map((column) => row[column]);
    if (cells) moves[lift] = cells.map((cell) => parseAttempt(cell?.failed && numeric(cell) ? -numeric(cell) : cell?.value));
    const best = Math.max(0, ...(moves[lift] || []).filter((attempt) => attempt.good).map((attempt) => attempt.weight)) || null;
    bestLifts[lift] = best ?? numeric(row[layout.direct[lift]]);
  }
  const recorded = numeric(row[layout.total]) ?? (eventType === 'powerlifting' ? null : numeric(row[layout.direct[eventType]]));
  // Old sheets often show only the last valid attempt. Keep those as best
  // lifts, without manufacturing which attempt was made.
  if (eventType !== 'powerlifting' && recorded && (!bestLifts[eventType] || !moves[eventType]?.some((attempt) => attempt.good))) {
    bestLifts[eventType] = recorded;
  }
  const sum = layout.lifts.reduce((value, lift) => value + (bestLifts[lift] || 0), 0);
  const rankable = Boolean(recorded && layout.lifts.every((lift) => bestLifts[lift]) && Math.abs(recorded - sum) <= 0.01 && !NO_RESULT.test(placing || ''));
  if (!rankable && !NO_RESULT.test(placing || '')) return null;
  const born = row[layout.birth]?.value || originalName.match(/\/\s*(\d{2})$/)?.[1] || '';
  const birth = born.match(/\b((?:19|20)\d{2})\b/)?.[1] || (/^\d{2}$/.test(born) ? 1900 + Number(born) : null);
  const age = year - Number(birth);
  const inferredCategory = classLimit(sex, weight, year);
  const categoryNumber = Number(listedClass?.slice(1, -2));
  const finalCategory = listedClass && (!weight || (listedClass.startsWith('+') ? weight > categoryNumber : weight <= categoryNumber + 0.01))
    ? listedClass : inferredCategory;
  return {
    athleteName: name, athleteNameNormalized: normalizeName(name), yearOfBirth: birth && age >= 10 && age <= 100 ? Number(birth) : null,
    sex, category: finalCategory, equipment, club: row[layout.club]?.value || null, bodyweight: weight, placing,
    attempts: moves, bestLifts, total: rankable ? recorded : null, ipfgl: null,
    historicalPoints: rankable ? numeric(row[layout.points]) : null, historicalPointsLabel: layout.pointsLabel,
    sourceFederation: 'AEP', resultArchive: 'Archivo histórico AEP', eventType, liftType: eventType,
    isIndividualResult: true, isRankable: rankable, hasValidPowerliftingTotal: rankable,
    ...(listedClass && listedClass !== finalCategory && { historicalCategoryRecorded: listedClass }),
    competition: {
      name: title, year, date, resultsUrl: extract, meetPageUrl: document.url, meetPageTitle: title,
      resultsLabel: document.label, sourceType: 'archive', sourcePriority: 5,
    },
  };
}

function parseArchiveRows(rows, document, extract = document.url) {
  const intro = rows.slice(0, 14).flatMap((row) => row.map((cell) => cell.value)).filter(Boolean);
  const head = intro.find((text) => /campeonato|regional|copa|memorial|trofeo|open/i.test(text) &&
    !/asociacion|clasificacion|levantador/i.test(normalizeName(text)));
  const description = document.description.replace(/:\s*(?:mujeres|hombres|femenino|masculino|powerlifting|press banca).*/i, '');
  const title = head && head.length > 10 ? head : description;
  const date = [description, ...intro].map((text) => dateFromArchive(text, document.year)).find(Boolean) || null;
  let sex = historicalSex(document.label) || (/[_/-]fem(?:[_.-]|$)/i.test(extract) ? 'F' : /[_/-]mas(?:[_.-]|$)/i.test(extract) ? 'M' : null);
  let equipment = historicalEquipment(document.label + ' ' + title + ' ' + extract.replace(/_/g, ' '));
  if (!equipment && document.year < 2010) equipment = 'equipped';
  let category = null;
  let layout = null;
  const entries = [];
  for (const [i, row] of rows.entries()) {
    const texts = row.map((cell) => cell.value).filter(Boolean);
    const heading = texts.join(' ');
    const isHeading = texts[0] && (texts.length <= 3 || /\b(?:clasificacion|femenin[oa]|hombres|mujeres|masculin[oa])\b/.test(normalizeName(texts[0])));
    if (isHeading) {
      const announcedSex = historicalSex(heading);
      if (announcedSex) {
        if (sex !== announcedSex) category = null;
        sex = announcedSex;
      }
      equipment = historicalEquipment(heading) || equipment;
      if (/^(?:mejores levantador|ranking|clasificacion (?:por|de) (?:equipos|clubes)|abreviaciones)/.test(normalizeName(heading))) layout = null;
      if (texts.length === 1 && /kg|\bcat/i.test(heading)) {
        category = publishedClass(heading.replace(/^cat(?:egoria)?\.?\s*/i, '')) || category;
      }
    }
    const candidate = findLayout(row, rows[i - 1], normalizeName(heading + ' ' + title + ' ' + document.label + ' ' + extract.replace(/_/g, ' ')));
    if (candidate) {
      layout = candidate;
      continue;
    }
    if (!layout) continue;
    const entry = archiveRow(row, layout, { year: document.year, date, document, sex, category, equipment, title, extract });
    if (entry) entries.push(entry);
  }
  return entries;
}

function workbookRows(buffer) {
  const book = XLSX.read(buffer, { cellStyles: true });
  return book.SheetNames.map((name) => XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1, defval: '', raw: false }).map((row) =>
    row.map((value) => ({ value: normalizeSpaces(value), width: 1 }))));
}

function parseCadiz2017(text, document) {
  let sex;
  const results = [];
  const scanned = /^(\d+)\s+(\d+|[-–]|DT|AI)\s+(.+?)\s+((?:19|20)\d{2})\s+(\d+[.,]\d+)\s+(?:SNR|JUN|SBJ|M[1-4])\s+\d+[.,]\d+\s+(\d+\+?)\s+(.+)$/i;
  const equipment = /equipado/i.test(document.url) ? 'equipped' : 'raw';
  for (const line of text.split(/\r?\n/)) {
    const row = normalizeSpaces(line);
    if (/^(?:HOMBRES|MUJERES) (?:MASTER|JUNIOR|SUBJUNIOR|SUB-JUNIOR|ABSOLUTO) (?:RAW|EQUIPADO)/i.test(row)) {
      sex = historicalSex(row);
      continue;
    }
    const match = row.match(scanned);
    if (!match || !sex) continue;
    const [, order, place, person, birth, weight, category, values] = match;
    const marks = values.split(' ');
    if (marks.length < 11 || !marks.slice(0, 9).every((value) => /^[X—–-]$|^-?\d+(?:[.,]\d+)?$/i.test(value))) continue;
    const normalized = normalizeName(person);
    const club = CADIZ_CLUBS.find((name) => normalized.endsWith(normalizeName(name)));
    if (!club) continue;
    const name = person.slice(0, -club.length).trim();
    if (!name || name.split(/\s+/).length < 2) continue;
    const attempts = Object.fromEntries(Object.keys(LIFTS).map((lift, i) => [lift, marks.slice(i * 3, i * 3 + 3).map(parseAttempt)]));
    const total = parseLocaleNumber(marks[9]);
    const bestLifts = Object.fromEntries(Object.entries(attempts).map(([lift, tries]) =>
      [lift, Math.max(0, ...tries.filter((attempt) => attempt.good).map((attempt) => attempt.weight)) || null]));
    const sum = Object.values(bestLifts).reduce((weight, best) => weight + (best || 0), 0);
    const rankable = total > 0 && Object.values(bestLifts).every(Boolean) && Math.abs(total - sum) < 0.01;
    if (total > 0 && !rankable) continue;
    results.push({
      athleteName: name, athleteNameNormalized: normalizeName(name), yearOfBirth: Number(birth),
      sex, category: publishedClass(category), equipment, club, bodyweight: parseLocaleNumber(weight),
      placing: place, order: Number(order), attempts, bestLifts,
      total: rankable ? total : null, ipfgl: null, historicalPoints: rankable ? parseLocaleNumber(marks[10]) : null,
      historicalPointsLabel: 'Wilks', sourceFederation: 'AEP', resultArchive: 'Archivo histórico AEP',
      eventType: 'powerlifting', liftType: 'powerlifting', isIndividualResult: true, isRankable: rankable, hasValidPowerliftingTotal: rankable,
      competition: {
        name: 'Campeonato de España Subjunior, Junior y Máster de Powerlifting', year: 2017, date: '2017-10-21',
        resultsUrl: document.url, meetPageUrl: document.url, resultsLabel: document.label, sourceType: 'archive',
      },
    });
  }
  return results;
}

function mergeHistory(primary, archive) {
  const results = [];
  const matches = new Map();
  for (const row of [...primary, ...archive]) {
    const name = row.athleteNameNormalized.split(' ').filter(Boolean).sort().join(' ');
    const key = [name, row.sex, row.competition.year, row.eventType, row.total].join('|');
    const candidates = matches.get(key) || [];
    const date = Date.parse(row.competition.date);
    const identical = candidates.find((prior) => {
      if (Math.abs(prior.bodyweight - row.bodyweight) > 0.05 ||
          (prior.yearOfBirth && row.yearOfBirth && prior.yearOfBirth !== row.yearOfBirth) ||
          (prior.equipment && row.equipment && prior.equipment !== row.equipment)) return false;
      const priorDate = Date.parse(prior.competition.date);
      return prior.competition.meetPageUrl === row.competition.meetPageUrl ||
        (Number.isFinite(date) && Number.isFinite(priorDate) && Math.abs(date - priorDate) <= 3 * 86400000) ||
        (prior.competition.year === row.competition.year &&
          normalizeName(prior.competition.name) === normalizeName(row.competition.name));
    });
    if (identical) {
      if (!identical.yearOfBirth && row.yearOfBirth) identical.yearOfBirth = row.yearOfBirth;
      if (!identical.club && row.club) identical.club = row.club;
      if (!identical.country && row.country) identical.country = row.country;
      if (!identical.competition.date && row.competition.date) {
        identical.competition.date = row.competition.date;
        identical.competition.dateApproximate = row.competition.dateApproximate;
      }
      continue;
    }
    results.push(row);
    candidates.push(row);
    matches.set(key, candidates);
  }
  return results;
}

async function fetchHistory(fetchBuffer, parseDocument, onWarning) {
  await fs.mkdir(CACHE, { recursive: true });
  const limit = pLimit(5);
  async function cached(url) {
    const file = path.join(CACHE, createHash('sha256').update(url).digest('hex'));
    try { return await fs.readFile(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const buffer = await limit(() => fetchBuffer(url));
    await fs.writeFile(file, buffer);
    return buffer;
  }
  const indexes = await Promise.all(YEARS.map(async (year) => {
    const url = archiveYearUrl(year);
    try { return archiveLinks(await cached(url), url, year); }
    catch (error) { onWarning('No se pudo leer el índice histórico de ' + year + ': ' + error.message); return []; }
  }));
  const docs = [...new Map(indexes.flat().map((doc) => [doc.url, doc])).values()];
  const unavailable = [];
  const unparsed = [];
  const legends = new Map();

  async function extract(url, document, follow) {
    const buffer = await cached(url);
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    if (ext === '.pdf') {
      if (/\/2017\/Resultados_(?:SBJ_Raw|JUN_Raw|MASTER_Raw|EQUIPADO)_Cmpto_Cadiz\.pdf$/i.test(url)) {
        const pdf = new PDFParse({ data: buffer });
        try { return parseCadiz2017((await pdf.getText()).text, document); }
        finally { await pdf.destroy(); }
      }
      const entries = await parseDocument(buffer, ext, {
        resultsUrl: url, resultsLabel: document.label, meetPageUrl: document.url, pageTitle: document.description,
        year: document.year, date: dateFromArchive(document.description, document.year),
        onClubAliases: (pairs) => { if (pairs.length) legends.set(url, [...(legends.get(url) || []), ...pairs]); },
      });
      return entries.filter((entry) => entry.competition.year === document.year && entry.sex).map((entry) => ({
        ...entry, ipfgl: null, sourceFederation: 'AEP', resultArchive: 'Archivo histórico AEP',
      }));
    }
    const tables = /\.xlsx?$/.test(ext) ? workbookRows(buffer) : [htmlRows(buffer)];
    const aliases = clubAliasPairs(tables.flat(2).map((cell) => cell.value));
    if (aliases.length) legends.set(url, aliases);
    const direct = tables.flatMap((rows) => parseArchiveRows(rows, document, url));
    if (/\.xlsx?$/.test(ext)) return direct;
    if (!follow) return direct;
    const sheets = archiveSheets(buffer, url);
    const children = await Promise.all(sheets.map(async (child) => {
      try { return await extract(child, document, false); }
      catch (error) { unavailable.push({ url: child, year: document.year, reason: String(error.response?.status || error.code || error.message) }); return []; }
    }));
    return [...direct, ...children.flat()];
  }

  const results = await Promise.all(docs.map(async (doc) => {
    try {
      const rows = await extract(doc.url, doc, true);
      if (!rows.length) unparsed.push({ url: doc.url, year: doc.year, name: doc.description });
      return rows;
    } catch (error) {
      unavailable.push({ url: doc.url, year: doc.year, reason: String(error.response?.status || error.code || error.message) });
      return [];
    }
  }));
  return { entries: results.flat(), legends, coverage: { documents: docs.length, unavailable, unparsed } };
}

module.exports = { fetchHistory, htmlRows, parseArchiveRows, archiveLinks, classLimit, publishedClass, mergeHistory };
