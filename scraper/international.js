const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const cheerio = require('cheerio');
const XLSX = require('xlsx');
const pLimit = require('p-limit').default;
const { normalizeName, normalizeSpaces, parseLocaleNumber, parseSpanishDate } = require('./utils');
const { countryCode } = require('./countries');

const OPL = 'https://www.openpowerlifting.org';
const OPL_ARCHIVES = 'https://gitlab.com/api/v4/projects/openpowerlifting%2Fopl-data/repository/archive.zip?path=meet-data%2F';
const IPF = 'https://ipf.powerlifting.sport';
const CACHE_DIR = process.env.PLS_INTERNATIONAL_DIR || path.join(os.tmpdir(), 'powerlifting-international');
const DAY = 86400000;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MOVEMENTS = ['squat', 'bench', 'deadlift'];

function publishedDate(text, year) {
  const match = String(text || '').match(/\b(\d{1,2})\s+([a-z]{3})/i);
  const month = MONTHS.indexOf(match?.[2].toLowerCase()) + 1;
  if (!year || !month || !match) return null;
  return `${year}-${String(month).padStart(2, '0')}-${match[1].padStart(2, '0')}`;
}

function findAepInternationalMeets(html, yearPage, year) {
  const $ = cheerio.load(html);
  const meets = new Map();
  $('.oew-accordion-title').each((_, node) => {
    const federation = normalizeSpaces($(node).text()).match(/^(IPF|EPF)\b/)?.[1];
    if (!federation) return;
    $(node).next('.oew-accordion-content').find('h3 a[href]').each((__, element) => {
      const link = $(element);
      const url = new URL(link.attr('href'), yearPage);
      if (url.origin !== new URL(yearPage).origin) return;
      const titleNode = link.clone();
      titleNode.find('br').replaceWith(' ');
      const title = normalizeSpaces(titleNode.text());
      const date = parseSpanishDate(`${title} ${year}`)?.toISOString().slice(0, 10);
      meets.set(url.href, { url: url.href, title, federation, date, year });
    });
  });
  return [...meets.values()];
}

function aepInternationalLinks(html, meetPage) {
  const $ = cheerio.load(html);
  const links = new Set();
  $('a[href]').each((_, node) => {
    const text = normalizeName($(node).text());
    if (!/^(?:clasificacion(?:es)?|resultados?)/.test(text)) return;
    const url = new URL($(node).attr('href'), meetPage);
    if (!['http:', 'https:'].includes(url.protocol) || !/^(?:www\.)?(?:powerliftingspain\.es|powerlifting\.sport|europowerlifting\.org|goodlift\.info|openipf\.org|openpowerlifting\.org)$/.test(url.hostname)) return;
    url.protocol = 'https:';
    links.add(url.href);
  });
  return [...links];
}

function archiveMeetId(url) {
  return String(url).match(/\/m\/(?:epf|ipf)\/\d+(?=\/|$|[?#])/i)?.[0];
}

function connectAepInternationalPages(entries, aepMeets) {
  return entries.map((entry) => {
    const id = archiveMeetId(entry.competition.resultsUrl);
    const candidates = aepMeets.filter((meet) => meet.federation === entry.sourceFederation && meet.year === entry.competition.year);
    const exact = id && candidates.find((meet) => meet.links.some((link) => archiveMeetId(link) === id));
    const date = Date.parse(entry.competition.date);
    const byDate = candidates.filter((meet) => Math.abs(Date.parse(meet.date) - date) <= 2 * DAY &&
      (!/press banca/i.test(meet.title) || entry.eventType === 'bench'));
    const aepMeet = exact || (byDate.length === 1 ? byDate[0] : null);
    if (!aepMeet) return entry;
    const official = aepMeet.links.filter((link) => !archiveMeetId(link));
    return {
      ...entry,
      competition: {
        ...entry.competition,
        meetPageUrl: aepMeet.url,
        meetPageTitle: aepMeet.title,
        officialResultsUrls: [...new Set([...official, ...(entry.competition.officialResultsUrls || [])])],
      },
    };
  });
}

function classifyAepInternational(entry, meet) {
  if (!['esp', 'spa', 'spain', 'espana'].includes(normalizeName(entry.club))) return null;
  return {
    ...entry, country: 'ESP', club: 'España', sourceFederation: meet.federation,
    competition: { ...entry.competition, officialResultsUrls: [] },
  };
}

function ipfEventLinks(html) {
  const $ = cheerio.load(html);
  const links = new Set();
  $('a[href*="results/view/"]').each((_, element) => {
    if (!/\b(?:powerlifting|bench press)\b/i.test(normalizeSpaces($(element).text()))) return;
    const url = new URL($(element).attr('href'), IPF);
    if (url.origin === IPF && url.pathname.startsWith('/results/view/')) links.add(url.href);
  });
  if (!links.size) throw new Error('No se han encontrado actas en el portal IPF.');
  return [...links];
}

function publishedCategory(text) {
  const category = normalizeSpaces(text).replace(/\s+/g, '').match(/^([+-]?)(\d{2,3}(?:[.,]5)?)(\+)?kg$/i);
  if (!category) return null;
  return (category[1] === '+' || category[3] ? '+' : '-') + category[2].replace(',', '.') + 'kg';
}

function positiveNumber(text) {
  const value = parseLocaleNumber(String(text ?? '').trim());
  return Number.isFinite(value) && value > 0 ? value : null;
}

function makeEntry(event, result) {
  const eventType = result.eventType || (/bench press/i.test(event.title) ? 'bench' : 'powerlifting');
  const equipment = result.equipment || (/\bequipped\b/i.test(event.title) ? 'equipped' : /\bclassic\b/i.test(event.title) ? 'raw' : null);
  const { yearOfBirth, sex, category, placing, bodyweight, bestLifts, attempts, total, ipfgl } = result;
  let { athleteName } = result;
  // La preselección AEP del Europeo Junior 2025 identifica a Daniel Tomás Gómez.
  // El Mundial IPF de la misma temporada lo abrevia como «Gomez Daniel».
  if (sex === 'M' && yearOfBirth === 2002 && /^(?:daniel gomez 3|gomez daniel)$/.test(normalizeName(athleteName))) {
    athleteName = 'Daniel Tomás Gómez';
  }
  if (!equipment || !sex || !category || !bodyweight || !/\p{L}/u.test(athleteName)) return null;
  const validLifts = eventType === 'powerlifting' ? MOVEMENTS.every((lift) => bestLifts[lift]) : Boolean(bestLifts[eventType]);
  const rankable = Boolean(total && /^(?:\d+|G|NS|SNR)$/.test(placing) && validLifts);
  return {
    athleteName, athleteNameNormalized: normalizeName(athleteName), yearOfBirth, sex, category, placing, bodyweight,
    country: event.federation === 'AEP' ? result.country : 'ESP',
    club: event.federation === 'AEP' ? result.club : 'España', equipment, sourceFederation: event.federation, bestLifts, attempts,
    ...(event.archive && { resultArchive: event.archive }),
    total: rankable ? total : null,
    ipfgl: rankable ? ipfgl : null,
    liftType: eventType, eventType, isIndividualResult: true, isRankable: rankable, hasValidPowerliftingTotal: validLifts,
    competition: {
      name: event.title, subtitle: '', locationDateText: event.location, date: event.date, year: event.year,
      meetPageUrl: event.url, resultsUrl: event.url, meetPageTitle: event.title, resultsLabel: event.title,
      dateApproximate: event.dateApproximate, sourceType: event.archive ? 'csv' : 'html',
      officialResultsUrls: event.officialResultsUrls,
    },
  };
}

// https://www.powerlifting.sport/rules/codes/info/ipf-formula
const GL_COEFFICIENTS = {
  M: { raw: [1199.72839, 1025.18162, 0.00921], equipped: [1236.25115, 1449.21864, 0.01644],
    rawBench: [320.98041, 281.40258, 0.01008], equippedBench: [381.22073, 733.79378, 0.02398] },
  F: { raw: [610.32796, 1045.59282, 0.03048], equipped: [758.63878, 949.31382, 0.02435],
    rawBench: [142.40398, 442.52671, 0.04724], equippedBench: [221.82209, 357.00377, 0.02937] },
};

function goodliftPoints(total, bodyweight, sex, equipment, eventType) {
  if (!total || bodyweight < (sex === 'M' ? 40 : 35)) return null;
  const [a, b, c] = GL_COEFFICIENTS[sex][equipment + (eventType === 'bench' ? 'Bench' : '')];
  return Number((100 * total / (a - b * Math.exp(-c * bodyweight))).toFixed(2));
}

function readCsv(csv) {
  const workbook = XLSX.read(csv, { type: 'string', raw: true });
  return XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: '' });
}

function openPowerliftingResults(buffer, federation, years) {
  const archive = XLSX.CFB.read(buffer, { type: 'buffer' });
  const files = new Map(archive.FullPaths.map((filename, index) => [filename, archive.FileIndex[index].content]));
  const read = (filename) => {
    const content = files.get(filename);
    return content ? Buffer.from(content).toString('utf8') : '';
  };
  const entries = [];
  const meets = [...files.keys()].filter((filename) => filename.endsWith('/meet.csv'));
  if (!meets.length) throw new Error('La descarga no contiene competiciones.');
  for (const filename of meets) {
    const directory = filename.slice(0, -'meet.csv'.length);
    const id = directory.split('/').at(-2);
    const [meet] = readCsv(read(filename));
    const year = Number(meet?.Date?.slice(0, 4));
    if (!years.includes(year) || meet.Federation !== federation || !meet.MeetName ||
        /special olympics|\bsoi\b/i.test(meet.MeetName) || meet.Sanctioned === 'No') continue;
    const csv = read(directory + 'entries.csv');
    if (!csv) continue;
    const officialResultsUrls = read(directory + 'URL').split(/\r?\n/).map((line) => line.trim())
      .filter((line) => /^https?:\/\/(?:www\.)?(?:powerlifting\.sport|europowerlifting\.org|goodlift\.info|powerhispania\.net|powerliftingspain\.es)\//i.test(line));
    const event = {
      url: `${OPL}/m/${federation.toLowerCase()}/${id}`, federation, archive: 'OpenPowerlifting', title: meet.MeetName,
      date: meet.Date, year, dateApproximate: true, officialResultsUrls,
      location: [meet.MeetTown, meet.MeetCountry].filter(Boolean).join(', '),
    };
    for (const row of readCsv(csv)) {
      const national = federation === 'AEP';
      const country = countryCode(row.Country) || normalizeSpaces(row.Country) || null;
      if ((!national && country !== 'ESP') || !['F', 'M'].includes(row.Sex) || !['SBD', 'SDB', 'B', 'D', 'S'].includes(row.Event)) continue;
      const equipment = row.Equipment === 'Raw' ? 'raw' : ['Single-ply', 'Multi-ply', 'Wraps'].includes(row.Equipment) ? 'equipped' : null;
      const category = publishedCategory(`${row.WeightClassKg}kg`);
      const bodyweight = positiveNumber(row.BodyweightKg);
      if (!equipment || !category || !bodyweight) continue;
      const eventType = { B: 'bench', D: 'deadlift', S: 'squat' }[row.Event] || 'powerlifting';
      const allColumns = { squat: 'Squat', bench: 'Bench', deadlift: 'Deadlift' };
      const columns = eventType === 'powerlifting' ? allColumns : { [eventType]: allColumns[eventType] };
      const attempts = {};
      const bestLifts = {};
      for (const [movement, column] of Object.entries(columns)) {
        const values = [1, 2, 3].map((n) => row[`${column}${n}Kg`]);
        if (values.some(Boolean)) {
          attempts[movement] = values.map((raw) => {
            const n = parseLocaleNumber(raw);
            return { raw: raw || '', weight: n ? Math.abs(n) : null, good: n ? n > 0 : null };
          });
        }
        const successful = attempts[movement]?.filter((attempt) => attempt.good).map((attempt) => attempt.weight) || [];
        bestLifts[movement] = positiveNumber(row[`Best3${column}Kg`]) || Math.max(0, ...successful) || null;
      }
      const total = positiveNumber(row.TotalKg) ?? (eventType === 'powerlifting' ? null : bestLifts[eventType]);
      const entry = makeEntry(event, {
        athleteName: normalizeSpaces(row.Name),
        yearOfBirth: /^\d{4}$/.test(row.BirthYear) ? Number(row.BirthYear) : /^\d{4}-/.test(row.BirthDate) ? Number(row.BirthDate.slice(0, 4)) : null,
        sex: row.Sex, category, placing: row.Place, bodyweight, eventType, equipment, bestLifts, attempts, total, country,
        club: normalizeSpaces(row.Team) || null,
        ipfgl: year >= 2021 && ['powerlifting', 'bench'].includes(eventType)
          ? goodliftPoints(total, bodyweight, row.Sex, equipment, eventType) : null,
      });
      if (entry) entries.push(entry);
    }
  }
  return entries;
}

function ipfResults(html, url) {
  const $ = cheerio.load(html);
  const heading = $('h4').first();
  const title = normalizeSpaces(heading.text());
  if (/special olympics|\bsoi\b/i.test(title)) return [];
  const year = Number(title.match(/\b20\d{2}\b/)?.[0]);
  const dateLine = heading.siblings().text().match(/\b\d{1,2}\s+[a-z]{3}\s*[-–−]\s*\d{1,2}\s+[a-z]{3}\s+20\d{2}/i)?.[0];
  const date = publishedDate(dateLine, year);
  if (!date || !$('table').length) throw new Error('No se reconoce la fecha o tabla del acta IPF.');
  const location = normalizeSpaces(heading.parent().find('.icofont-location-pin').parent().text());
  const event = { url, federation: 'IPF', title, year, date, dateApproximate: true, location };
  const entries = [];
  let sex = null;
  let category = null;
  let inResults = false;
  const benchOnly = /bench press/i.test(title);
  $('h2,tr').each((_, element) => {
    const row = $(element);
    if (element.name === 'h2') {
      const headingText = normalizeSpaces(row.text());
      sex = /^WOMEN\b/i.test(headingText) ? 'F' : /^MEN\b/i.test(headingText) ? 'M' : null;
      inResults = Boolean(sex);
      category = null;
      return;
    }
    if (!inResults) return;
    const cells = row.children('td').toArray();
    const values = cells.map((cell) => normalizeSpaces($(cell).text()));
    if (values.length === 1) category = publishedCategory(values[0]);
    if (values[3] !== 'ESP') return;
    const attempts = {};
    const bestLifts = {};
    const compactBench = benchOnly && cells.length < 20;
    const movementColumns = benchOnly ? { bench: compactBench ? 7 : 11 } : { squat: 7, bench: 11, deadlift: 15 };
    for (const [movement, column] of Object.entries(movementColumns)) {
      attempts[movement] = cells.slice(column, column + 3).map((cell) => ({
        raw: normalizeSpaces($(cell).text()), weight: positiveNumber($(cell).text()),
        good: $(cell).hasClass('G') ? true : $(cell).hasClass('N') ? false : null,
      }));
      bestLifts[movement] = positiveNumber(values[column + 3]?.split(/\s+/)[0]);
    }
    const entry = makeEntry(event, {
      athleteName: normalizeSpaces($(cells[1]).find('a').text()), yearOfBirth: /^\d{4}$/.test(values[2]) ? Number(values[2]) : null,
      sex, category, attempts, bestLifts, placing: values[0], bodyweight: positiveNumber(values[5]),
      total: positiveNumber(values[compactBench ? 11 : 19]) ?? (benchOnly ? bestLifts.bench : null),
      ipfgl: positiveNumber(values[compactBench ? 13 : 21]),
    });
    if (entry) entries.push(entry);
  });
  return entries;
}

function identityKey(entry) {
  if (!entry.yearOfBirth || !entry.sex) return null;
  const tokens = entry.athleteNameNormalized.split(' ').filter(Boolean).sort();
  return [entry.sex, entry.yearOfBirth, ...tokens].join('|');
}

function alignInternationalNames(international, domestic) {
  const domesticNames = new Map();
  for (const entry of domestic) {
    const key = identityKey(entry);
    if (!key) continue;
    if (!domesticNames.has(key)) domesticNames.set(key, new Map());
    domesticNames.get(key).set(entry.athleteNameNormalized, entry.athleteName);
  }
  const fallback = new Map();
  return international.map((entry) => {
    const key = identityKey(entry);
    if (!key) return entry;
    const names = domesticNames.get(key);
    if (!fallback.has(key)) fallback.set(key, [entry.athleteNameNormalized, entry.athleteName]);
    const [athleteNameNormalized, athleteName] = names?.size === 1 ? names.entries().next().value : fallback.get(key);
    return { ...entry, athleteName, athleteNameNormalized };
  });
}

// Las dos fuentes publican años distintos para el mismo levantador. El ID
// del ranking los reúne, conservando cada año en el resultado de origen.
const VERIFIED_RANKING_BIRTH_YEAR_ALIASES = {
  // Historial de la misma deportista en OpenPowerlifting y actas AEP 2025/26.
  'F|andrea flores navarro': { 2000: 2000, 2001: 2000 },
  // Actas AEP 2025/26 y perfiles antonioloressanchez y zuhangqiu del archivo.
  'M|antonio lores sanchez': { 1993: 1993, 1994: 1993 },
  'M|qiu zuhang': { 2001: 2002, 2002: 2002 },
  // AEP: selección y resultados Junior 2026; IPF: Mundial Junior 2026, Sun City.
  'M|asensio carlos moratinos': { 2003: 2003, 2004: 2003 },
  'M|daniel gomez tomas': { 2000: 2002, 2002: 2002 },
  // La AEP atribuye los 787,5 kg de Oulu al atleta de RV Strength:
  // https://powerliftingspain.es/wp-content/uploads/2026/02/REGISTRO-25022026.pdf
  'M|hoyo martinez ruben': { 1980: 1986, 1986: 1986 },
};

function assignRankingIdentities(entries) {
  const groups = new Map();
  for (const entry of entries) {
    if (!entry.sex || !entry.athleteNameNormalized) continue;
    const normalized = entry.sex === 'M' && entry.athleteNameNormalized === 'de tomas gomez daniel' && entry.yearOfBirth === 2002
      ? 'tomas gomez daniel' : entry.athleteNameNormalized;
    const tokens = normalized.split(' ').filter(Boolean).sort().join(' ');
    const key = `${entry.sex}|${tokens}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  for (const [key, group] of groups) {
    if (new Set(group.map((entry) => entry.athleteNameNormalized)).size < 2) continue;
    const aliases = VERIFIED_RANKING_BIRTH_YEAR_ALIASES[key];
    const yearFor = (entry) => aliases?.[entry.yearOfBirth] || entry.yearOfBirth;
    const years = new Set(group.map(yearFor).filter(Boolean));
    for (const entry of group) {
      const year = yearFor(entry) || (years.size === 1 ? years.values().next().value : null);
      if (year) entry.rankingAthleteId = `${key}|${year}`;
    }
  }
}

function mergeInternationalResults(primary, secondary) {
  const indexed = new Map();
  const entries = [];
  for (const entry of [...primary, ...secondary]) {
    const identity = entry.athleteNameNormalized.split(' ').filter(Boolean).sort().join(' ');
    const key = [identity, entry.sex, entry.sourceFederation, entry.eventType, entry.equipment, entry.category, entry.total].join('|');
    const date = Date.parse(entry.competition.date);
    const prior = indexed.get(key) || [];
    if (prior.some((other) =>
      Math.abs(date - Date.parse(other.competition.date)) <= 2 * DAY &&
      Math.abs(entry.bodyweight - other.bodyweight) <= 0.02 &&
      (!entry.yearOfBirth || !other.yearOfBirth || entry.yearOfBirth === other.yearOfBirth))) continue;
    entries.push(entry);
    indexed.set(key, [...prior, entry]);
  }
  return entries;
}

async function fetchInternationalResults(fetchBuffer, years, onWarning) {
  const limit = pLimit(2);
  await fs.mkdir(CACHE_DIR, { recursive: true });

  async function safe(url, parse, maxAge) {
    const key = createHash('sha256').update(url).digest('hex');
    const file = path.join(CACHE_DIR, key);
    let cached = null;
    try {
      const stats = await fs.stat(file);
      cached = parse(await fs.readFile(file));
      if (Date.now() - stats.mtimeMs < maxAge) return cached;
    } catch {
      // Repair missing or unreadable downloads from the source.
    }
    try {
      const buffer = await limit(() => fetchBuffer(url));
      const result = parse(buffer);
      await fs.writeFile(file, buffer);
      return result;
    } catch (error) {
      const fallback = cached ? ' Se conserva la última versión disponible.' : '';
      onWarning(`No se pudo procesar el archivo internacional ${url}: ${error.message}.${fallback}`);
      return cached || [];
    }
  }

  const archiveBuild = Promise.all(['IPF', 'EPF'].map((federation) =>
    safe(OPL_ARCHIVES + federation.toLowerCase(), (buffer) => openPowerliftingResults(buffer, federation, years), DAY)));
  const ipfLinks = await safe(`${IPF}/results`, (buffer) => ipfEventLinks(buffer.toString('utf8')), DAY);
  const ipf = await Promise.all(ipfLinks.map((url) => safe(url, (buffer) => ipfResults(buffer.toString('utf8'), url), 3 * DAY)));
  return mergeInternationalResults(ipf.flat(), (await archiveBuild).flat());
}

async function fetchAepArchive(fetchBuffer, years, onWarning) {
  const url = OPL_ARCHIVES + 'aep';
  const file = path.join(CACHE_DIR, createHash('sha256').update(url).digest('hex'));
  await fs.mkdir(CACHE_DIR, { recursive: true });
  try {
    const stat = await fs.stat(file);
    if (Date.now() - stat.mtimeMs < 7 * DAY) return openPowerliftingResults(await fs.readFile(file), 'AEP', years);
  } catch {}
  try {
    const buffer = await fetchBuffer(url);
    const entries = openPowerliftingResults(buffer, 'AEP', years);
    await fs.writeFile(file, buffer);
    return entries;
  } catch (error) {
    onWarning('No se pudo actualizar el archivo AEP de OpenPowerlifting: ' + error.message);
    try { return openPowerliftingResults(await fs.readFile(file), 'AEP', years); }
    catch { return []; }
  }
}

module.exports = {
  fetchInternationalResults, fetchAepArchive, alignInternationalNames, openPowerliftingResults, ipfResults,
  findAepInternationalMeets, aepInternationalLinks, connectAepInternationalPages, classifyAepInternational, mergeInternationalResults, assignRankingIdentities,
};
