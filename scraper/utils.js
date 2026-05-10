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

function parseAttempt(raw) {
  if (raw === null || raw === undefined || raw === '') {
    return { raw: null, weight: null, good: null };
  }

  if (typeof raw === 'number') {
    return { raw, weight: Math.abs(raw), good: raw >= 0 };
  }

  const text = String(raw).trim();
  if (!text || text === '-') {
    return { raw: null, weight: null, good: null };
  }
  const num = parseLocaleNumber(text);
  if (num === null) {
    return { raw: text, weight: null, good: null };
  }
  return { raw: text, weight: Math.abs(num), good: !text.startsWith('-') };
}

function attemptsFromValues(values) {
  return values.map(parseAttempt);
}

function formatDateISO(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function parseSpanishDate(text) {
  const value = stripAccents(String(text || '').toLowerCase());
  const match = value.match(/(\d{1,2})\s+([a-z]+)\s+(\d{4})/);
  if (!match) return null;
  const day = Number(match[1]);
  const month = MONTHS[match[2]];
  const year = Number(match[3]);
  if (!month) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(date.getTime()) ? null : date;
}

function firstNonEmpty(values) {
  for (const item of values) {
    const text = normalizeSpaces(item);
    if (text) return text;
  }
  return '';
}

function isLikelyResultsDocument(label, href) {
  const haystack = `${label || ''} ${href || ''}`.toLowerCase();
  const good = /(clasific|resultad|ranking|excel|score|resul|fem|mas|hombre|mujer)/.test(haystack);
  const bad = /(cartel|invit|horario|sesion|grupo|juez|inscrip|guia|acta|record|calendario|normativa)/.test(haystack);
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
  parseAttempt,
  attemptsFromValues,
  parseSpanishDate,
  formatDateISO,
  firstNonEmpty,
  isLikelyResultsDocument,
  looksLikeCompetitionUrl,
  cleanCompetitionTitle,
};
