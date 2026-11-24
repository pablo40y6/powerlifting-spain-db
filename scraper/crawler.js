const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const pLimit = require('p-limit').default;
const sanitizeFilename = require('sanitize-filename');
const { reviewResult } = require('./reviewed-results');
const {
  fetchInternationalResults, alignInternationalNames, findAepInternationalMeets, aepInternationalLinks,
  connectAepInternationalPages, classifyAepInternational, mergeInternationalResults, assignRankingIdentities,
} = require('./international');
const { parseDocument, mergeAthleteEntries, _private: parserPrivate } = require('./parser');
const {
  cleanCompetitionTitle,
  getExtension,
  isLikelyResultsDocument,
  looksLikeCompetitionUrl,
  normalizeName,
  normalizeSpaces,
  firstExtractedYear,
  parseSpanishDate,
  toAbsoluteUrl,
} = require('./utils');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE_DIR = process.env.PLS_DOCS_DIR || path.join(os.tmpdir(), 'powerlifting-spain-db', 'docs');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');

const COMPETITION_YEARS = Array.from(
  { length: new Date().getUTCFullYear() - 2020 }, (_, index) => new Date().getUTCFullYear() - index
);
const SEED_YEAR_PAGES = COMPETITION_YEARS.map(
  (year) => `https://powerliftingspain.es/campeonatos-${year >= 2023 ? 'ano-' : ''}${year}/`
);

// El enlace de la ficha de Andújar conserva el nombre anterior a la
// republicación del PDF en la biblioteca de medios de la AEP.
const RESULTS_DOCUMENT_ALIASES = new Map([
  [
    'https://powerliftingspain.es/wp-content/uploads/2022/08/Clasificaciones_AEP-2_Regional_Andalucia_Andujar_2021_power_mas.pdf',
    'https://powerliftingspain.es/wp-content/uploads/2022/08/Clasificaciones_AEP-2_Regional_Andalucia_Andujar_2021_power_mas-1.pdf',
  ],
]);

function canonicalResultsDocumentUrl(url) {
  return RESULTS_DOCUMENT_ALIASES.get(url) || url;
}

function calculateProgressPercent(state) {
  if (state.phase === 'done') return 100;
  if (state.phase === 'international') return 95;

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
    return Math.round(40 + (state.processedDocuments / total) * 55);
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

function textWithLineBreaks($, node) {
  const content = $(node).clone();
  content.find('br').replaceWith(' ');
  return normalizeSpaces(content.text());
}

function extractPageMeta(html, pageUrl, anchorText = '') {
  const $ = cheerio.load(html);
  const title = cleanCompetitionTitle($('h1').first().text() || $('title').first().text() || '');
  const headings = $('h2,h3,.elementor-heading-title').slice(0, 12).map((_, node) => textWithLineBreaks($, node)).get();
  const year = firstExtractedYear([title, pageUrl, anchorText]);
  const parsedDate = [...headings, anchorText, title]
    .map((text) => parseSpanishDate(text))
    .find((date) => date && (!year || date.getUTCFullYear() === year));
  return {
    pageTitle: title || null,
    date: parsedDate ? parsedDate.toISOString().slice(0, 10) : null,
    year: parsedDate ? parsedDate.getUTCFullYear() : year,
  };
}

function discoverCompetitionPages(html, pageUrl) {
  const $ = cheerio.load(html);
  const pages = new Map();
  const directDocs = new Map();

  $('a[href]').each((_, el) => {
    const href = toAbsoluteUrl($(el).attr('href'), pageUrl);
    const text = textWithLineBreaks($, el);
    if (!href) return;

    const ext = getExtension(href);
    if (['.pdf', '.xls', '.xlsx'].includes(ext) && isLikelyResultsDocument(text, href)) {
      const url = canonicalResultsDocumentUrl(href);
      directDocs.set(url, {
        url,
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

    const url = canonicalResultsDocumentUrl(href);
    docs.set(url, { url, label: label || path.basename(url) });
  });

  return Array.from(docs.values());
}

function documentPageMatch(doc, page) {
  const filename = new URL(doc.url).pathname.split('/').at(-1);
  const documentWords = new Set(normalizeName(filename).split(' '));
  const pageWords = new Set(normalizeName(page.pageTitle).split(' ').filter((word) => word.length > 3));
  return [...pageWords].filter((word) => documentWords.has(word)).length;
}

function indexDocuments(pageMetas, directDocs) {
  const documents = new Map();
  for (const page of [...pageMetas].sort((a, b) => a.url.localeCompare(b.url, 'en'))) {
    for (const doc of page.docs) {
      const match = documentPageMatch(doc, page);
      const existing = documents.get(doc.url);
      if (!existing || match > existing.match) {
        documents.set(doc.url, {
          resultsUrl: doc.url,
          resultsLabel: doc.label,
          meetPageUrl: page.url,
          pageTitle: page.pageTitle,
          date: page.date,
          year: page.year,
          match,
        });
      }
    }
  }
  for (const doc of directDocs.values()) {
    if (!documents.has(doc.url)) {
      documents.set(doc.url, {
        resultsUrl: doc.url,
        resultsLabel: doc.label,
        meetPageUrl: doc.discoveredOn,
        pageTitle: null,
      });
    }
  }
  return documents;
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
    isIndividualResult: entry.isIndividualResult !== false,
    isRankable: entry.isRankable !== false,
    hasValidPowerliftingTotal: entry.hasValidPowerliftingTotal !== false,
    competitionYear: entry.competition.year,
    equipment: entry.equipment || null,
    ...(entry.country && { country: entry.country }),
    ...(entry.rankingAthleteId && { rankingAthleteId: entry.rankingAthleteId }),
    ...(entry.sourceFederation && {
      sourceFederation: entry.sourceFederation,
      bestLifts: entry.bestLifts,
      resultArchive: entry.resultArchive,
      officialResultsUrls: entry.competition.officialResultsUrls,
      competitionDateApproximate: entry.competition.dateApproximate,
    }),
    ...(entry.sourceReview && { sourceReview: entry.sourceReview }),
  };
}

function separateHomonyms(group) {
  const confirmed = group.entries.filter((entry) => entry.isRankable && entry.yearOfBirth && entry.club && entry.meetPageUrl);
  const byMeet = new Map();
  for (const entry of confirmed) {
    if (!byMeet.has(entry.meetPageUrl)) byMeet.set(entry.meetPageUrl, []);
    byMeet.get(entry.meetPageUrl).push(entry);
  }
  const hasHomonyms = Array.from(byMeet.values()).some((meet) => meet.some((entry, index) =>
    meet.slice(index + 1).some((other) => entry.yearOfBirth !== other.yearOfBirth && normalizeName(entry.club) !== normalizeName(other.club))
  ));
  if (!hasHomonyms) return [group];

  const clubYears = new Map();
  for (const entry of confirmed) {
    const club = normalizeName(entry.club);
    if (!clubYears.has(club)) clubYears.set(club, new Set());
    clubYears.get(club).add(entry.yearOfBirth);
  }
  const distinct = new Map();
  for (const entry of group.entries) {
    const years = clubYears.get(normalizeName(entry.club));
    const year = entry.yearOfBirth || (years?.size === 1 ? years.values().next().value : null);
    const id = `${group.athleteNameNormalized}-${year || 'sin-anio'}`;
    if (!distinct.has(id)) distinct.set(id, { ...group, athleteId: id, clubs: new Set(), entries: [] });
    const athlete = distinct.get(id);
    if (entry.club) athlete.clubs.add(entry.club);
    athlete.entries.push(entry);
  }
  return Array.from(distinct.values());
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

  const athletes = Array.from(grouped.values()).flatMap(separateHomonyms).map((group) => {
    group.entries.sort((a, b) => {
      const da = a.competitionDate || '0000-00-00';
      const db = b.competitionDate || '0000-00-00';
      return db.localeCompare(da) || (b.total || 0) - (a.total || 0);
    });
    return {
      athleteName: group.athleteName,
      athleteNameNormalized: group.athleteNameNormalized,
      ...(group.athleteId ? { athleteId: group.athleteId } : {}),
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

  const internationalBuild = fetchInternationalResults(
    async (url) => Buffer.from((await client.get(url)).data), COMPETITION_YEARS, (warning) => state.warnings.push(warning)
  );

  const discoveredPages = new Map();
  const directDocs = new Map();
  const aepInternationalMeets = new Map();

  for (const [yearIndex, seedUrl] of SEED_YEAR_PAGES.entries()) {
    try {
      const html = await fetchText(client, seedUrl);
      const found = discoverCompetitionPages(html, seedUrl);
      found.pages.forEach((page) => discoveredPages.set(page.url, page));
      found.directDocs.forEach((doc) => directDocs.set(doc.url, doc));
      for (const meet of findAepInternationalMeets(html, seedUrl, COMPETITION_YEARS[yearIndex])) {
        meet.links = [];
        aepInternationalMeets.set(meet.url, meet);
        if (!discoveredPages.has(meet.url)) discoveredPages.set(meet.url, { url: meet.url, anchorText: meet.title });
      }
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
          const internationalMeet = aepInternationalMeets.get(page.url);
          if (internationalMeet) internationalMeet.links = aepInternationalLinks(html, page.url);
          const pageMeta = extractPageMeta(html, page.url, page.anchorText);
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

  const allDocs = indexDocuments(pageMetas, directDocs);

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

  const individualEntries = rawEntries.filter((entry) => !parserPrivate.resultLooksLikeTeamOrSummary(entry));
  const domestic = [];
  const aepInternational = [];
  for (const entry of mergeAthleteEntries(individualEntries).map(reviewResult)) {
    const meet = aepInternationalMeets.get(entry.competition.meetPageUrl);
    if (!meet) {
      domestic.push(entry);
      continue;
    }
    const spanishEntry = classifyAepInternational(entry, meet);
    if (spanishEntry) aepInternational.push(spanishEntry);
    else {
      // Keep athletes already listed in the general search without treating
      // them as Spanish marks in the ranking.
      const team = normalizeName(entry.club).toUpperCase();
      domestic.push({ ...entry, country: /^[A-Z]{3}$/.test(team) ? team : 'UNK' });
    }
  }
  log({ phase: 'international' });
  const external = connectAepInternationalPages(await internationalBuild, [...aepInternationalMeets.values()]);
  const international = alignInternationalNames(mergeInternationalResults(aepInternational, external), domestic);
  const mergedEntries = [...domestic, ...international];
  assignRankingIdentities(mergedEntries);
  const athletes = buildAthleteIndex(mergedEntries);

  const index = {
    builtAt: new Date().toISOString(),
    seedPages: SEED_YEAR_PAGES,
    competitionPagesIndexed: competitionPages.length,
    documentsIndexed: allDocs.size,
    internationalEntryCount: international.length,
    internationalWithAepPageCount: international.filter((entry) => aepInternationalMeets.has(entry.competition.meetPageUrl)).length,
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

  const queryTokens = tokenize(normalizedQuery).filter((token) => token.length > 1);
  if (!queryTokens.length) return 0;
  const nameTokens = tokenize(athleteName);
  const allTokensPresent = queryTokens.every((token) =>
    nameTokens.some((nameToken) => nameToken.startsWith(token))
  );
  if (!allTokensPresent) return 0;

  const exactMatches = queryTokens.filter((token) => nameTokens.includes(token)).length;
  return queryTokens.length === nameTokens.length && exactMatches === queryTokens.length ? 95 : 88 + exactMatches;
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
    buildAthleteIndex,
    indexDocuments,
    scoreAthlete,
  },
};
