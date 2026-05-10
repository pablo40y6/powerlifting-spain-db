const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const pLimit = require('p-limit').default;
const sanitizeFilename = require('sanitize-filename');
const { parseDocument, mergeAthleteEntries } = require('./parser');
const {
  cleanCompetitionTitle,
  getExtension,
  isLikelyResultsDocument,
  looksLikeCompetitionUrl,
  normalizeName,
  normalizeSpaces,
  firstExtractedYear,
  firstParsedSpanishDate,
  toAbsoluteUrl,
} = require('./utils');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE_DIR = process.env.PLS_DOCS_DIR || path.join(os.tmpdir(), 'powerlifting-spain-db', 'docs');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');

const SEED_YEAR_PAGES = [2026, 2025, 2024, 2023, 2022, 2021].map(
  (year) => `https://powerliftingspain.es/campeonatos-ano-${year}/`
);

function calculateProgressPercent(state) {
  if (state.phase === 'done') return 100;

  if (state.phase === 'seed-pages') {
    const total = Math.max(state.seedPages || 1, 1);
    return Math.round((state.processedSeedPages / total) * 15);
  }

  if (state.phase === 'competition-pages') {
    const total = Math.max(state.competitionPages || 1, 1);
    return Math.round(15 + (state.processedCompetitionPages / total) * 25);
  }

  if (state.phase === 'documents') {
    const total = Math.max(state.documents || 1, 1);
    return Math.round(40 + (state.processedDocuments / total) * 60);
  }

  return 0;
}

function ensureDirectories() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function createHttpClient() {
  return axios.create({
    timeout: 45000,
    maxRedirects: 5,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; PowerliftingSpainFinder/1.0; +local-app)',
      Accept: 'text/html,application/pdf,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*',
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
    },
    responseType: 'arraybuffer',
    validateStatus: (status) => status >= 200 && status < 400,
  });
}

function extractPageMeta(html, pageUrl) {
  const $ = cheerio.load(html);
  const title = cleanCompetitionTitle($('h1').first().text() || $('title').first().text() || '');
  const text = normalizeSpaces([
    $('time[datetime]').first().attr('datetime'),
    $('.entry-date').first().text(),
    $('.posted-on').first().text(),
    $('.entry-content').first().text(),
    title,
    pageUrl,
  ].filter(Boolean).join(' '));
  const parsedDate = firstParsedSpanishDate([text]);
  return {
    pageTitle: title || null,
    date: parsedDate ? parsedDate.toISOString().slice(0, 10) : null,
    year: parsedDate ? parsedDate.getUTCFullYear() : firstExtractedYear([title, pageUrl, text]),
  };
}

function discoverCompetitionPages(html, pageUrl) {
  const $ = cheerio.load(html);
  const pages = new Map();
  const directDocs = new Map();

  $('a[href]').each((_, el) => {
    const href = toAbsoluteUrl($(el).attr('href'), pageUrl);
    const text = normalizeSpaces($(el).text());
    if (!href) return;

    const ext = getExtension(href);
    if (['.pdf', '.xls', '.xlsx'].includes(ext) && isLikelyResultsDocument(text, href)) {
      directDocs.set(href, {
        url: href,
        label: text || path.basename(href),
        discoveredOn: pageUrl,
      });
      return;
    }

    if (looksLikeCompetitionUrl(href, text)) {
      pages.set(href, {
        url: href,
        anchorText: text,
      });
    }
  });

  return {
    pages: Array.from(pages.values()),
    directDocs: Array.from(directDocs.values()),
  };
}

function findNearestHeadingText($, el) {
  let current = $(el);
  for (let depth = 0; depth < 4 && current.length; depth += 1) {
    const previousHeading = current.prevAll('h1,h2,h3,h4,h5,h6').first();
    if (previousHeading.length) return normalizeSpaces(previousHeading.text());
    current = current.parent();
  }
  return '';
}

function buildDocumentLabel($, el) {
  const link = $(el);
  const ownLabel = normalizeSpaces(link.text() || link.attr('title') || link.attr('aria-label') || '');
  const contextualLabel = normalizeSpaces([
    ownLabel,
    link.closest('li,p,td,th,div,section,article').first().text(),
    findNearestHeadingText($, el),
  ].filter(Boolean).join(' '));

  return {
    label: ownLabel || contextualLabel || path.basename(link.attr('href') || ''),
    context: contextualLabel,
  };
}

function extractDocumentsFromCompetitionPage(html, pageUrl) {
  const $ = cheerio.load(html);
  const docs = new Map();

  $('a[href]').each((_, el) => {
    const href = toAbsoluteUrl($(el).attr('href'), pageUrl);
    if (!href) return;
    const ext = getExtension(href);
    if (!['.pdf', '.xls', '.xlsx'].includes(ext)) return;

    const { label, context } = buildDocumentLabel($, el);
    if (!isLikelyResultsDocument(context || label, href)) return;

    docs.set(href, { url: href, label: label || path.basename(href) });
  });

  return Array.from(docs.values());
}

function preferDocuments(documents) {
  const excelDocs = documents.filter((doc) => ['.xls', '.xlsx'].includes(getExtension(doc.url)));
  if (excelDocs.length) return excelDocs;
  return documents.filter((doc) => getExtension(doc.url) === '.pdf');
}

function buildDocCachePath(url) {
  const name = sanitizeFilename(path.basename(url).split('?')[0]) || 'document.bin';
  return path.join(CACHE_DIR, name);
}

async function fetchText(client, url) {
  const response = await client.get(url, { responseType: 'text' });
  return String(response.data || '');
}

async function fetchBufferWithCache(client, url) {
  const cachePath = buildDocCachePath(url);
  if (fs.existsSync(cachePath)) {
    return fs.readFileSync(cachePath);
  }
  const response = await client.get(url, { responseType: 'arraybuffer' });
  const buffer = Buffer.from(response.data);
  fs.writeFileSync(cachePath, buffer);
  return buffer;
}

function entryToAthleteCard(entry) {
  return {
    athleteName: entry.athleteName,
    athleteNameNormalized: entry.athleteNameNormalized,
    competitionName: entry.competition.name,
    competitionSubtitle: entry.competition.subtitle,
    competitionDate: entry.competition.date,
    competitionLocationDateText: entry.competition.locationDateText,
    meetPageUrl: entry.competition.meetPageUrl,
    meetPageTitle: entry.competition.meetPageTitle,
    resultsUrl: entry.competition.resultsUrl,
    resultsLabel: entry.competition.resultsLabel,
    sex: entry.sex,
    category: entry.category,
    placing: entry.placing,
    yearOfBirth: entry.yearOfBirth,
    club: entry.club,
    bodyweight: entry.bodyweight,
    total: entry.total,
    ipfgl: entry.ipfgl,
    attempts: entry.attempts,
    liftType: entry.liftType,
    eventType: entry.eventType || entry.liftType || 'powerlifting',
    competitionYear: entry.competition.year,
  };
}

function buildAthleteIndex(entries) {
  const grouped = new Map();

  for (const entry of entries) {
    const key = entry.athleteNameNormalized;
    if (!grouped.has(key)) {
      grouped.set(key, {
        athleteName: entry.athleteName,
        athleteNameNormalized: key,
        clubs: new Set(),
        entries: [],
      });
    }
    const group = grouped.get(key);
    group.clubs.add(entry.club || '');
    group.entries.push(entryToAthleteCard(entry));
  }

  const athletes = Array.from(grouped.values()).map((group) => {
    group.entries.sort((a, b) => {
      const da = a.competitionDate || '0000-00-00';
      const db = b.competitionDate || '0000-00-00';
      return db.localeCompare(da) || (b.total || 0) - (a.total || 0);
    });
    return {
      athleteName: group.athleteName,
      athleteNameNormalized: group.athleteNameNormalized,
      clubs: Array.from(group.clubs).filter(Boolean).sort(),
      entries: group.entries,
    };
  });

  athletes.sort((a, b) => a.athleteName.localeCompare(b.athleteName, 'es'));
  return athletes;
}

async function buildIndex({ onProgress } = {}) {
  ensureDirectories();
  const client = createHttpClient();
  const limit = pLimit(4);
  const state = {
    phase: 'seed-pages',
    seedPages: SEED_YEAR_PAGES.length,
    processedSeedPages: 0,
    competitionPages: 0,
    processedCompetitionPages: 0,
    documents: 0,
    processedDocuments: 0,
    warnings: [],
  };

  const log = (patch = {}) => {
    Object.assign(state, patch);
    state.percent = calculateProgressPercent(state);
    if (onProgress) onProgress({ ...state });
  };

  const discoveredPages = new Map();
  const directDocs = new Map();

  for (const seedUrl of SEED_YEAR_PAGES) {
    try {
      const html = await fetchText(client, seedUrl);
      const found = discoverCompetitionPages(html, seedUrl);
      found.pages.forEach((page) => discoveredPages.set(page.url, page));
      found.directDocs.forEach((doc) => directDocs.set(doc.url, doc));
    } catch (error) {
      state.warnings.push(`No se pudo leer ${seedUrl}: ${error.message}`);
    }
    state.processedSeedPages += 1;
    log();
  }

  const competitionPages = Array.from(discoveredPages.values());
  state.phase = 'competition-pages';
  state.competitionPages = competitionPages.length;
  log();

  const pageMetas = [];
  await Promise.all(
    competitionPages.map((page) =>
      limit(async () => {
        try {
          const html = await fetchText(client, page.url);
          // Desde v14 procesamos Excel y PDF cuando existen ambos. Asi el
          // merge puede usar Excel para los campos tabulares y PDF para
          // recuperar nulos que en Excel antiguo solo aparecen en rojo/tachado.
          const docs = extractDocumentsFromCompetitionPage(html, page.url);
          const pageMeta = extractPageMeta(html, page.url);
          pageMetas.push({
            url: page.url,
            pageTitle: pageMeta.pageTitle || cleanCompetitionTitle(page.anchorText || ''),
            date: pageMeta.date,
            year: pageMeta.year,
            docs,
          });
        } catch (error) {
          state.warnings.push(`No se pudo leer la página ${page.url}: ${error.message}`);
        }
        state.processedCompetitionPages += 1;
        log();
      })
    )
  );

  const allDocs = new Map();
  for (const page of pageMetas) {
    for (const doc of page.docs) {
      allDocs.set(doc.url, {
        resultsUrl: doc.url,
        resultsLabel: doc.label,
        meetPageUrl: page.url,
        pageTitle: page.pageTitle,
        date: page.date,
        year: page.year,
      });
    }
  }

  for (const doc of directDocs.values()) {
    if (!allDocs.has(doc.url)) {
      allDocs.set(doc.url, {
        resultsUrl: doc.url,
        resultsLabel: doc.label,
        meetPageUrl: doc.discoveredOn,
        pageTitle: null,
      });
    }
  }

  state.phase = 'documents';
  state.documents = allDocs.size;
  log();

  const rawEntries = [];
  await Promise.all(
    Array.from(allDocs.values()).map((docMeta) =>
      limit(async () => {
        try {
          const buffer = await fetchBufferWithCache(client, docMeta.resultsUrl);
          const extension = getExtension(docMeta.resultsUrl);
          const entries = await parseDocument(buffer, extension, docMeta);
          rawEntries.push(...entries);
        } catch (error) {
          state.warnings.push(`No se pudo procesar ${docMeta.resultsUrl}: ${error.message}`);
        }
        state.processedDocuments += 1;
        log();
      })
    )
  );

  const mergedEntries = mergeAthleteEntries(rawEntries);
  const athletes = buildAthleteIndex(mergedEntries);

  const index = {
    builtAt: new Date().toISOString(),
    seedPages: SEED_YEAR_PAGES,
    competitionPagesIndexed: competitionPages.length,
    documentsIndexed: allDocs.size,
    athleteCount: athletes.length,
    entryCount: mergedEntries.length,
    warnings: state.warnings,
    athletes,
  };

  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), 'utf8');
  log({ phase: 'done' });
  return index;
}

function loadIndex() {
  if (!fs.existsSync(INDEX_FILE)) return null;
  return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
}

function tokenize(text) {
  return normalizeName(text)
    .split(' ')
    .filter(Boolean);
}

function scoreAthlete(query, athlete) {
  const normalizedQuery = normalizeName(query);
  if (!normalizedQuery) return 0;
  const athleteName = athlete.athleteNameNormalized;
  if (athleteName === normalizedQuery) return 100;

  const queryTokens = tokenize(normalizedQuery);
  if (!queryTokens.length) return 0;
  const nameTokens = new Set(tokenize(athleteName));
  const allTokensPresent = queryTokens.every((token) => nameTokens.has(token));
  if (!allTokensPresent) return 0;

  return queryTokens.length === nameTokens.size ? 95 : 90;
}

function searchAthletes(index, query) {
  const normalizedQuery = normalizeName(query);
  if (!normalizedQuery) return [];

  return index.athletes
    .map((athlete) => ({ athlete, score: scoreAthlete(normalizedQuery, athlete) }))
    .filter((item) => item.score >= 50)
    .sort((a, b) => b.score - a.score || a.athlete.athleteName.localeCompare(b.athlete.athleteName, 'es'))
    .map((item) => item.athlete);
}

module.exports = {
  buildIndex,
  loadIndex,
  searchAthletes,
  INDEX_FILE,
  _private: {
    SEED_YEAR_PAGES,
    createHttpClient,
    fetchText,
    fetchBufferWithCache,
    discoverCompetitionPages,
    extractDocumentsFromCompetitionPage,
    extractPageMeta,
    scoreAthlete,
  },
};
