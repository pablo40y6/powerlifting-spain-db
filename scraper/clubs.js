const cheerio = require('cheerio');
const { PDFParse } = require('pdf-parse');
const { normalizeName, normalizeSpaces } = require('./utils');

const ACTIVE_CLUBS = 'https://powerliftingspain.es/wp-content/uploads/2026/04/CLUBES-Y-DATOS-HISTORICOS.xlsx-DATOS-DE-CONTACTO-DE-CLUBES.pdf';
const LEGACY_LISTS = Array.from({ length: 9 }, (_, index) => 2014 + index).map((year) => ({
  year, url: 'https://www.powerhispania.net/Documentos/Listado_Afiliados_Club_' + year + ([2016, 2017].includes(year) ? '.pdf' : '.htm'),
}));
const AFFILIATIONS = [...LEGACY_LISTS,
  { year: 2023, url: 'https://powerliftingspain.es/wp-content/uploads/2023/11/Afiliados_Club_AEP_2023-11-18.pdf' },
  { year: 2024, url: 'https://powerliftingspain.es/wp-content/uploads/2024/11/Afiliados_Club_2024-11-28.pdf' },
  { year: 2025, url: 'https://powerliftingspain.es/wp-content/uploads/2025/02/Afiliados_Club_2025-02-28.pdf' },
];
const HISTORICAL_CLUB_SOURCE = 'https://www.powerhispania.net/Noticias/Cronica_Campeonatos_RAW.pdf';
const VERIFIED_ALIASES = [
  { url: 'https://powerliftingspain.es/wp-content/uploads/2022/07/Clasificacion_ABS_Power_Raw_Alhaurin_2021_men.pdf', pairs: {
    'Sideropolis Madrid': ['Sideropolis', 'AD Siderópolis', 'AGR. DEP. SIDEROPOLIS Madrid', 'SIDER'],
    'Fuerza Isabel Atlas Chiva': ['FIA', 'FUERZA ISABEL-ATLA Chiva'],
    'Eduardo Rallo Madrid': ['ERALLO', 'EDURAL'],
    'Federación Catalana': ['FEDCAT', 'FCFC', 'FED. CATALANA'],
    "Altea-Finestrat-L'Alfàs": ['AFA', 'Finestrat-Altea', 'ALTEA-FINESTRAT'],
  } },
  { url: 'https://powerliftingspain.es/wp-content/uploads/2025/08/Clasificacion-MAS_AEP-3_Black-Crown-3_Rivas-Vaciamadrid_2025-1.pdf', pairs: {
    'Barbastro Powerlifting Huesca': ['BARBAS'],
    'Black Crown Powerlifting Madrid': ['BLKCRW'],
  } },
  { url: 'https://powerliftingspain.es/wp-content/uploads/2025/10/Clasificacion-FEM_AEP-2-NOROESTE_Abadino-Bizkaia_2025.pdf', pairs: {
    'Raw Barbell Club Bizkaia': ['RAWBAR', 'RAW BARBELL Bizkaia', 'RBC'],
  } },
  { url: HISTORICAL_CLUB_SOURCE, pairs: {
    'Power Hernández': ['P. Hernández', 'Club Power Hernández'],
    'Kronos Villajoyosa': ['Kronos', 'Club Kronos Sport'],
    'Power Tordesillas': ['P. Tordesillas', 'Asociación Deportiva Power Tordesillas'],
    'PowerKan': ['Power Kan'],
  } },
  { url: 'https://www.powerhispania.net/Resultados/2009/31_Power_2009.htm', pairs: {
    'A.D. Madrileña': ['AD Madrileña'],
  } },
];

function textKey(value) {
  return normalizeName(value).replace(/\s+/g, '');
}

function registrationName(value) {
  return normalizeName(value).replace(/^(?:club(?: dep(?:ortivo)?(?: elemental| basico)?)?|asociacion deportiva|agrupacion deportiva|agr dep|a d)\s+/, '');
}

function displayName(value) {
  if (!value || value !== value.toUpperCase()) return value;
  return value.toLocaleLowerCase('es').replace(/(^|[ \-/])(\p{L}+)/gu, (_, space, word) =>
    space + (/^(?:de|del|la|las|los|y)$/.test(word) && space ? word : word[0].toUpperCase() + word.slice(1)));
}

function readHtmlAffiliations(buffer, source) {
  const $ = cheerio.loadBuffer(buffer);
  return $('tr').toArray().flatMap((row) => {
    const values = $(row).children('td,th').toArray().map((cell) => normalizeSpaces($(cell).text())).filter(Boolean);
    if (values.length !== 4 || !/^\d+$/.test(values[3]) || !/\p{L}/u.test(values[0]) || /^(?:total|comite)/i.test(normalizeName(values[0]))) return [];
    return [{ short: values[0], region: values[1], registered: values[2], ...source }];
  });
}

async function pdfText(buffer) {
  const document = new PDFParse({ data: buffer });
  try { return (await document.getText()).text; }
  finally { await document.destroy(); }
}

const REGIONS = 'CASTILLA\\s*[-–]?\\s*LA MANCHA|CASTILLA Y LE[ÓO]N|PA[ÍI]S VASCO|COMUNIDAD VALENCIANA|VALENCIANA?|VALENCIA|ANDALUC[ÍI]A|ARAG[ÓO]N|ASTURIAS|BALEARES|CANARIAS|CANTABRIA|CATALU[ÑN]A|CEUTA|EXTREMADURA|GALICIA|LA RIOJA|MADRID|MELILLA|MURCIA|NAVARRA|EUSKADI';

function readPdfAffiliations(text, source) {
  const row = new RegExp('^(.+?) (' + REGIONS + ') (.+?) (\\d{1,4})$', 'u');
  return text.split(/\r?\n/).flatMap((line) => {
    const match = normalizeSpaces(line).match(row);
    if (!match || /^(?:total|comite)/.test(normalizeName(match[1]))) return [];
    const [, short, region, registered] = match;
    return [{ short, region, registered, ...source }];
  });
}

function readActiveClubs(text) {
  let region = '';
  return text.split(/\r?\n/).flatMap((line) => {
    const heading = normalizeSpaces(line).match(/^([\p{Lu} -]{4,}):\s*\d+$/u);
    if (heading) region = heading[1];
    const cells = line.split('\t').map(normalizeSpaces);
    // Only retain information about the club. The remaining columns contain
    // names and contact details for the association's representatives.
    if (cells.length < 4 || !line.includes('@') || !cells[2] || cells[2].includes('@')) return [];
    const city = cells[1];
    const short = cells[2];
    return [{ short, region, city, year: 2026, active: true, url: ACTIVE_CLUBS }];
  });
}

function clubAliasPairs(values) {
  return values.flatMap((raw) => {
    const pairs = normalizeSpaces(raw).matchAll(/(?:^|\s)([\p{Lu}\d][\p{Lu}\d-]{1,13})\s*=\s*([\p{L}\d][\p{L}\d .,'’&/-]{2,85}?)(?=\s+[\p{Lu}\d][\p{Lu}\d-]{1,13}\s*=|$)/gu);
    return [...pairs].filter((match) => /\p{L}{2}/u.test(match[2])).map((match) => ({ code: match[1], name: match[2] }));
  });
}

function pdfClubAliases(text) {
  const lines = text.split(/\r?\n/);
  const marker = lines.findIndex((line) => /ABREVIACIONES|ABREVIATURAS/i.test(line));
  if (marker === -1) return [];
  return lines.slice(marker + 1).flatMap((line) => {
    const cells = line.split('\t').map(normalizeSpaces).filter(Boolean);
    const explicit = clubAliasPairs(cells);
    if (explicit.length) return explicit;
    // In many AEP PDFs the legend is the last three columns beside the
    // "mejores levantadores" table: club number, code, full club name.
    const match = normalizeSpaces(line).match(/\b\d{1,3}\s+([A-Z0-9ÁÉÍÓÚÑ-]{3,12})\s+([\p{Lu}\d][\p{L}\d\s.,'’&/-]{4,85})$/u);
    if (!match || !/[A-ZÁÉÍÓÚÑ]{2}/.test(match[2])) return [];
    return [{ code: match[1], name: match[2] }];
  });
}

async function fetchAffiliations(fetchBuffer, onWarning) {
  const sources = [];
  for (const source of [...AFFILIATIONS, { url: ACTIVE_CLUBS }]) {
    try {
      const buffer = await fetchBuffer(source.url);
      if (source.url === ACTIVE_CLUBS) sources.push(...readActiveClubs(await pdfText(buffer)));
      else if (source.url.endsWith('.pdf')) sources.push(...readPdfAffiliations(await pdfText(buffer), source));
      else sources.push(...readHtmlAffiliations(buffer, source));
    } catch (error) {
      onWarning('No se pudo consultar el listado oficial de clubes ' + source.url + ': ' + error.message);
    }
  }
  return sources;
}

function clubDirectory(entries, affiliations, legends) {
  const clubs = new Map();
  const labels = new Map();
  const registeredNames = new Map();

  function addLabel(name, club) {
    const key = textKey(name);
    if (!key) return;
    const ids = labels.get(key) || new Set();
    ids.add(club.id);
    labels.set(key, ids);
  }

  function exact(name) {
    const ids = labels.get(textKey(name));
    return ids?.size === 1 ? clubs.get(ids.values().next().value) : null;
  }

  function createClub(name) {
    const id = normalizeName(name).replace(/ /g, '-');
    if (!clubs.has(id)) {
      const club = { id, name: displayName(name), aliases: new Set([name]), sources: new Map(), count: 0, firstYear: null, lastYear: null };
      clubs.set(id, club);
      addLabel(name, club);
    }
    return clubs.get(id);
  }

  for (const source of [...affiliations].sort((a, b) => a.year - b.year)) {
    if (!source.short || !/\p{L}/u.test(source.short)) continue;
    const registration = textKey(registrationName(source.registered));
    let club = exact(source.short) || (registration && registeredNames.get(registration));
    if (!club) {
      club = createClub(source.short);
    }
    if (source.registered) club.registered = source.registered;
    if (source.region) club.region = displayName(source.region);
    if (source.active) club.active = true;
    if (source.city) club.city = source.city;
    club.name = displayName(source.short);
    if (!club.sources.has(source.url)) club.sources.set(source.url, source.year);
    club.aliases.add(source.short);
    if (registration && registration.length >= 7) {
      registeredNames.set(registration, club);
      addLabel(registrationName(source.registered), club);
    }
    addLabel(source.short, club);
    addLabel(source.registered, club);
  }

  const codeByDocument = new Map();
  const globalCodes = new Map();
  const verified = new Map();
  for (const { url, pairs } of VERIFIED_ALIASES) {
    for (const [name, spellings] of Object.entries(pairs)) {
      const club = exact(name) || createClub(name);
      club.sources.set(url, null);
      for (const spelling of [name, ...spellings]) {
        verified.set(textKey(spelling), club);
        club.aliases.add(spelling);
      }
    }
  }
  function registerCode(map, code, club) {
    const ids = map.get(code) || new Set();
    ids.add(club.id);
    map.set(code, ids);
  }

  for (const [url, pairs] of legends) {
    const local = new Map();
    codeByDocument.set(url, local);
    for (const { code, name } of pairs) {
      if (!/[a-z]{2}/i.test(code) || !/\p{L}/u.test(name) || /^(?:sin club|independiente|solo|individual|espana|francia)$/i.test(normalizeName(name))) continue;
      const club = verified.get(textKey(name)) || exact(name) ||
        (registrationName(name) !== normalizeName(name) && exact(registrationName(name))) || createClub(name);
      if (!club.sources.size) club.sources.set(url, null);
      const key = textKey(code);
      if (key) {
        registerCode(local, key, club);
        registerCode(globalCodes, key, club);
      }
    }
  }

  const unresolved = new Map();
  const independent = /^(?:ind|indiv|indep|individual(?:es)?|independiente|sin club|sin equipo|ninguno|ningun club|esp|spa|espana|seleccion espanola|fra|francia)$/;
  let missing = 0;
  let special = 0;
  for (const entry of entries) {
    const value = normalizeSpaces(entry.club);
    const key = textKey(value);
    const year = entry.competition.year;
    const url = entry.competition.resultsUrl;
    if (!key) { missing++; continue; }
    if (entry.country && entry.country !== 'ESP' || independent.test(normalizeName(value))) { special++; continue; }
    const local = codeByDocument.get(url)?.get(key);
    const global = globalCodes.get(key);
    const ids = local || global;
    const club = (local?.size === 1 && clubs.get(local.values().next().value)) || (!local && verified.get(key)) ||
      exact(value) || (registrationName(value) !== normalizeName(value) && exact(registrationName(value))) ||
      (ids?.size === 1 && clubs.get(ids.values().next().value));
    if (club) {
      entry.clubId = club.id;
      club.aliases.add(value);
      club.count++;
      if (Number.isInteger(year)) {
        club.firstYear = club.firstYear === null ? year : Math.min(year, club.firstYear);
        club.lastYear = club.lastYear === null ? year : Math.max(year, club.lastYear);
      }
    } else {
      const item = unresolved.get(key) || { name: value, count: 0, firstYear: null, lastYear: null, source: url };
      item.count++;
      if (Number.isInteger(year)) {
        item.firstYear = item.firstYear === null ? year : Math.min(year, item.firstYear);
        item.lastYear = item.lastYear === null ? year : Math.max(year, item.lastYear);
      }
      unresolved.set(key, item);
    }
  }
  return {
    clubs: [...clubs.values()].filter((club) => club.active || club.count).map((club) => ({
      ...club, aliases: [...club.aliases].sort((a, b) => a.localeCompare(b, 'es')),
      sources: [...club.sources].map(([url, year]) => ({ url, year })).reverse(),
    })).sort((a, b) => a.name.localeCompare(b.name, 'es')),
    unresolved: [...unresolved.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'es')),
    missing, special,
  };
}

module.exports = { fetchAffiliations, clubDirectory, clubAliasPairs, pdfClubAliases, readActiveClubs };
