const path = require('path');

const MONTHS = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
};

function stripAccents(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function normalizeSpaces(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeName(value) {
  return normalizeSpaces(
    stripAccents(value)
      .toLowerCase()
      .replace(/[^a-z0-9ñü\s-]/gi, ' ')
      .replace(/[_-]+/g, ' ')
  );
}

function toAbsoluteUrl(href, base) {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function isSameDomain(url, domain = 'powerliftingspain.es') {
  try {
    return new URL(url).hostname.endsWith(domain);
  } catch {
    return false;
  }
}

function getExtension(url) {
  const clean = String(url || '').split('?')[0].split('#')[0];
  return path.extname(clean).toLowerCase();
}

function parseLocaleNumber(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') return raw;
  let value = String(raw).trim();
  if (!value) return null;
  value = value.replace(/\s+/g, '');
  if (value.includes(',') && value.includes('.')) {
    if (value.lastIndexOf(',') > value.lastIndexOf('.')) {
      value = value.replace(/\./g, '').replace(',', '.');
    } else {
      value = value.replace(/,/g, '');
    }
  } else if (value.includes(',')) {
    value = value.replace(',', '.');
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeAttemptWeight(num, rawText = '') {
  const weight = Math.abs(num);
  const text = String(rawText ?? '').trim();

  // A few PDF table extractions lose the decimal separator on failed attempts
  // (for example "-975" instead of "-97.5"). Only repair obviously
  // impossible negative integer attempts, keeping genuine decimal negatives like
  // "-112.5" as normal failed attempts.
  if (num < 0 && weight > 500 && weight <= 1500 && /^-?\d+$/.test(text || String(num))) {
    const repaired = weight / 10;
    if (repaired >= 20 && repaired <= 500) return repaired;
  }

  return weight;
}

function parseAttempt(raw) {
  if (raw === null || raw === undefined || raw === '') {
    return { raw: null, weight: null, good: null };
  }

  if (typeof raw === 'number') {
    if (raw === 0) return { raw: null, weight: null, good: null };
    return { raw, weight: normalizeAttemptWeight(raw, String(raw)), good: raw > 0 };
  }

  const text = String(raw).trim();
  if (!text || text === '-') {
    return { raw: null, weight: null, good: null };
  }
  const num = parseLocaleNumber(text);
  if (num === null || num === 0) {
    return num === 0 ? { raw: null, weight: null, good: null } : { raw: text, weight: null, good: null };
  }
  return { raw: text, weight: normalizeAttemptWeight(num, text), good: !text.startsWith('-') };
}

function attemptsFromValues(values) {
  return values.map(parseAttempt);
}

function formatDateISO(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function parseSpanishDate(text) {
  const raw = String(text || '');
  const isoMatch = raw.match(/\b(20\d{2}|19\d{2})-(\d{2})-(\d{2})\b/);
  if (isoMatch) {
    const date = new Date(Date.UTC(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3])));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const value = stripAccents(raw.toLowerCase());
  const match = value.match(/(\d{1,2})(?:\s+de)?\s+([a-z]+)(?:\s+de)?\s+(\d{4})/);
  if (!match) return null;
  const day = Number(match[1]);
  const month = MONTHS[match[2]];
  const year = Number(match[3]);
  if (!month) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(date.getTime()) ? null : date;
}


function extractYear(text) {
  const match = String(text || '').match(/\b(20\d{2}|19\d{2})\b/);
  if (!match) return null;
  const year = Number(match[1]);
  return Number.isInteger(year) ? year : null;
}

function firstParsedSpanishDate(values) {
  for (const value of values) {
    const parsed = parseSpanishDate(value);
    if (parsed) return parsed;
  }
  return null;
}

function firstExtractedYear(values) {
  for (const value of values) {
    const year = extractYear(value);
    if (year) return year;
  }
  return null;
}

function firstNonEmpty(values) {
  for (const item of values) {
    const text = normalizeSpaces(item);
    if (text) return text;
  }
  return '';
}

function isLikelyResultsDocument(label, href) {
  const haystack = normalizeName(`${label || ''} ${href || ''}`);
  const good = /(clasific|resultad|ranking|excel|score|resul|fem|mas|hombre|mujer|levantador|powerlifting|press\s+banca|peso\s+muerto|sub\s*junior|subjunior|junior|master|absoluto|aep|20\d{2})/.test(haystack);
  const bad = /(cartel|invit|horario|sesion|grupo|juez|inscrip|guia|acta|record|calendario|normativa|foto|imagen|logo)/.test(haystack);
  return good && !bad;
}

function looksLikeCompetitionUrl(url, anchorText = '') {
  if (!isSameDomain(url)) return false;
  const clean = String(url || '').toLowerCase();
  if (clean.includes('/wp-content/uploads/')) return false;
  if (clean.includes('/category/') || clean.includes('/tag/') || clean.includes('/author/')) return false;
  if (clean.endsWith('/campeonatos/') || /\/campeonatos-ano-\d{4}\/?$/.test(clean)) return false;
  if (clean.endsWith('/calendario/') || clean.endsWith('/noticias/') || clean.endsWith('/')) {
    if (!/(aep|campe|copa|regional|interregional|open|powerlifting|bench|banca|deadlift|muerto|oni|crown|cup|championship|absoluto|master|subjunior|junior)/.test(anchorText.toLowerCase())) {
      return false;
    }
  }
  const haystack = `${clean} ${String(anchorText).toLowerCase()}`;
  return /(20\d{2}|aep-|campeonato|copa|regional|interregional|powerlifting|press banca|peso muerto|black oni|black crown|intend|sbd|subjunior|junior|master|absoluto|open)/.test(haystack);
}

function cleanCompetitionTitle(title) {
  return normalizeSpaces(String(title || '').replace(/\s+–\s+PowerliftingSpain$/i, ''));
}

module.exports = {
  MONTHS,
  stripAccents,
  normalizeSpaces,
  normalizeName,
  toAbsoluteUrl,
  isSameDomain,
  getExtension,
  parseLocaleNumber,
  normalizeAttemptWeight,
  parseAttempt,
  attemptsFromValues,
  parseSpanishDate,
  firstParsedSpanishDate,
  extractYear,
  firstExtractedYear,
  formatDateISO,
  firstNonEmpty,
  isLikelyResultsDocument,
  looksLikeCompetitionUrl,
  cleanCompetitionTitle,
};
