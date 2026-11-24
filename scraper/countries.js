const cheerio = require('cheerio');
const { PDFParse } = require('pdf-parse');
const { normalizeName, normalizeSpaces } = require('./utils');

const RECORDS = 'https://powerliftingspain.es/records-aep/';
const SPAIN = new Set(['esp', 'spa', 'spain', 'espana']);
const FOREIGN_TEAMS = {
  fra: 'FRA', france: 'FRA', francia: 'FRA', 'equipe de france': 'FRA', 'ff force': 'FRA',
  gbr: 'GBR', 'gran bretana': 'GBR', 'united kingdom': 'GBR',
  por: 'POR', prt: 'POR', portugal: 'POR', chi: 'CHN', chn: 'CHN', china: 'CHN',
};

function countryCode(value) {
  const key = normalizeName(value);
  return SPAIN.has(key) ? 'ESP' : FOREIGN_TEAMS[key] || (/^[A-Z]{3}$/.test(String(value || '')) ? value : null);
}

function nameKey(value, sex) {
  return sex + '|' + normalizeName(value).split(' ').filter(Boolean).sort().join(' ');
}

function recordEvidence(text, url) {
  return text.split(/\r?\n/).flatMap((line) => {
    const [first] = line.split('\t');
    const match = normalizeSpaces(first).match(/^([FM])\s+\S+\s+(?:SQ|PB(?:MU)?|PM(?:MU)?|TOTAL)\s+\d{2,3}\+?\s+\d+(?:[.,]\d+)?\s+(.+)$/i);
    const name = match?.[2];
    if (!name || name.split(' ').length < 2 || !/^[\p{L}][\p{L}\s.'’()-]+$/u.test(name)) return [];
    return [{ sex: match[1].toUpperCase(), athleteName: name, country: 'ESP', url }];
  });
}

async function fetchRecordEvidence(fetchBuffer, onWarning) {
  let urls;
  try {
    const $ = cheerio.loadBuffer(await fetchBuffer(RECORDS));
    urls = $('a[href]').toArray().filter((element) => /^(?:20(?:2[1-6])|registro r[eé]cordsaep 2026)$/i.test(normalizeSpaces($(element).text())))
      .map((element) => new URL($(element).attr('href'), RECORDS).href)
      .filter((url) => /^https:\/\/powerliftingspain\.es\/wp-content\/uploads\/.+\.pdf$/i.test(url));
  } catch (error) {
    onWarning('No se pudo consultar el registro de récords AEP: ' + error.message);
    return [];
  }
  const evidence = [];
  for (const url of new Set(urls)) {
    try {
      const doc = new PDFParse({ data: await fetchBuffer(url) });
      try { evidence.push(...recordEvidence((await doc.getText()).text, url)); }
      finally { await doc.destroy(); }
    } catch (error) {
      onWarning('No se pudo contrastar la nacionalidad con ' + url + ': ' + error.message);
    }
  }
  return evidence;
}

function applyCountryEvidence(entries, extraEvidence = []) {
  const byName = new Map();
  const observedYears = new Map();
  for (const entry of entries) {
    const key = nameKey(entry.athleteName, entry.sex);
    if (entry.yearOfBirth) {
      const years = observedYears.get(key) || new Set();
      years.add(entry.yearOfBirth);
      observedYears.set(key, years);
    }
    if (!entry.country && (!entry.sourceFederation || entry.sourceFederation === 'AEP')) {
      // A club name is not a nationality. Only code words that explicitly
      // designate a national team can be interpreted.
      entry.country = FOREIGN_TEAMS[normalizeName(entry.club)] || null;
    }
  }
  for (const item of [...entries, ...extraEvidence]) {
    if (!item.country || item.country === 'UNK' || !item.sex) continue;
    const key = nameKey(item.athleteName, item.sex);
    const list = byName.get(key) || [];
    list.push({ year: item.yearOfBirth, country: item.country, url: item.url || item.competition?.resultsUrl, date: item.competition?.date });
    byName.set(key, list);
  }
  for (const entry of entries) {
    if (entry.country || !entry.sex) continue;
    const key = nameKey(entry.athleteName, entry.sex);
    const evidence = byName.get(key);
    if (!evidence?.length) continue;
    const years = observedYears.get(key);
    const hasSingleKnownYear = (years?.size || 0) <= 1;
    const tokens = normalizeName(entry.athleteName).split(' ').filter(Boolean);
    const compatible = evidence.filter((item) => item.year && entry.yearOfBirth
      ? item.year === entry.yearOfBirth
      : hasSingleKnownYear && tokens.length >= 3);
    const countries = new Set(compatible.map((item) => item.country));
    if (countries.size !== 1) continue;
    const proof = compatible.find((item) => item.url);
    entry.country = countries.values().next().value;
    if (proof) entry.countrySource = proof.url;
  }
}

module.exports = { countryCode, recordEvidence, fetchRecordEvidence, applyCountryEvidence };
