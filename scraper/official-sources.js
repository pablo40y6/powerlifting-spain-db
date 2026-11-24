const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const cheerio = require('cheerio');
const pLimit = require('p-limit').default;
const { normalizeSpaces } = require('./utils');
const { readFederationPdf, readFederationTable } = require('./federation-scoresheets');

const ROOTS = {
  IPF: 'https://www.powerlifting.sport/championships/results',
  EPF: 'https://www.europowerlifting.org/results',
};
const CACHE = process.env.PLS_OFFICIAL_DIR || path.join(process.env.PLS_INTERNATIONAL_DIR || os.tmpdir(), 'official-scoresheets');
const DAY = 86400000;
const AUXILIARY = /\bnominations?\b|\binvitations?\b|team[ _-]*(?:points|results|scores?|award|competition)|best[ _-]*lifters?|anti[ _-]*doping|\brack[ _-]*heights?\b|live[ _-]*stream|\bparticipants\b/i;

function sourceLinks(buffer, page, base) {
  const $ = cheerio.loadBuffer(buffer);
  const host = new URL(base).hostname.replace(/^www\./, '');
  const links = [];
  $('a[href],iframe[src],frame[src]').each((_, anchor) => {
    const node = $(anchor);
    const href = node.attr('href') || node.attr('src');
    if (!href || href.startsWith('#')) return;
    let url;
    try { url = new URL(href, page); } catch { return; }
    if (!['http:', 'https:'].includes(url.protocol) || url.hostname.replace(/^www\./, '') !== host) return;
    url.protocol = 'https:';
    url.hostname = new URL(base).hostname;
    url.hash = '';
    const label = normalizeSpaces(node.text());
    if (AUXILIARY.test(url.pathname + ' ' + label)) return;
    const header = normalizeSpaces(node.closest('p,li').prevAll('p,h3,h4,h5').first().text());
    links.push({ url: url.href, label, header });
  });
  return links;
}

function resultDocument(url, label) {
  const pathname = new URL(url).pathname;
  if (!/\.(?:pdf|xlsx?|html?)$/i.test(pathname)) return false;
  if (/\.html?$/i.test(pathname)) return /\/fileadmin\/.*\/(?:results|resultate)\//i.test(pathname);
  return /fileadmin|\/results\//i.test(pathname) && /results?|scoresheet|details?|protocol|championship|world|europe|\.xlsx?$/i.test(pathname + ' ' + label);
}

function sourceYear(text) {
  return Number(String(text || '').match(/\b((?:19|20)\d{2})\b/)?.[1]) || null;
}

async function fetchOfficialScoresheets(fetchBuffer, onWarning) {
  await fs.mkdir(CACHE, { recursive: true });
  const limit = pLimit(6);
  const coverage = { documents: 0, withSpanishResults: 0, entries: 0, unavailable: [] };

  async function cached(url, maxAge) {
    const file = path.join(CACHE, createHash('sha256').update(url).digest('hex'));
    let previous;
    try {
      previous = await fs.readFile(file);
      if (Date.now() - (await fs.stat(file)).mtimeMs < maxAge) return previous;
    } catch {}
    try {
      const buffer = await fetchBuffer(url);
      await fs.writeFile(file, buffer);
      return buffer;
    } catch (error) {
      if (previous) return previous;
      throw error;
    }
  }

  const documents = new Map();
  const pages = new Map();
  function collect(links, context, allowPages) {
    const base = ROOTS[context.fed];
    for (const link of links) {
      const year = sourceYear(new URL(link.url).pathname) || context.year || sourceYear(link.label);
      if (resultDocument(link.url, link.label)) {
        if (!documents.has(link.url)) documents.set(link.url, { ...context, ...link, year });
      } else if (allowPages && link.url.startsWith(base + '/') &&
        /\/(?:19|20)\d{2}(?:\/|$)|(?:19|20)\d{2}-(?:19|20)\d{2}$/.test(link.url) &&
        !pages.has(link.url) && (link.label.length > 10 || /^\d{4}$/.test(link.label))) {
        const page = link.url.replace(/\.html(?=$|\?)/i, '').replace(/\/$/, '');
        if (!pages.has(page)) pages.set(page, { fed: context.fed, title: link.label, year, page });
      }
    }
  }

  await Promise.all(Object.entries(ROOTS).map(async ([fed, page]) => {
    try { collect(sourceLinks(await cached(page, DAY), page, page), { fed, page, title: fed + ' Results' }, true); }
    catch (error) { onWarning('No se pudo consultar el archivo oficial ' + fed + ': ' + error.message); }
  }));
  const visited = new Set();
  // The archives link both individual championships and annual indexes.
  for (let depth = 0; depth < 2; depth += 1) {
    const pending = [...pages.values()].filter(({ page }) => !visited.has(page));
    await Promise.all(pending.map((meta) => limit(async () => {
      visited.add(meta.page);
      try {
        collect(sourceLinks(await cached(meta.page, DAY), meta.page, ROOTS[meta.fed]), meta, depth === 0);
      } catch (error) {
        coverage.unavailable.push({ url: meta.page, reason: String(error.response?.status || error.code || error.message) });
      }
    })));
  }

  coverage.documents = documents.size;
  const batches = await Promise.all([...documents.values()].map((meta) => limit(async () => {
    try {
      const ext = path.extname(new URL(meta.url).pathname).toLowerCase();
      const archive = meta.year && meta.year < new Date().getUTCFullYear() - 1;
      const buffer = await cached(meta.url, (archive ? 180 : 2) * DAY);
      if (ext === '.pdf' && !buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('El enlace no devuelve un PDF');
      const rows = ext === '.pdf' ? await readFederationPdf(buffer, meta) : await readFederationTable(buffer, meta, ext);
      if (rows.length) coverage.withSpanishResults += 1;
      return rows;
    } catch (error) {
      coverage.unavailable.push({ url: meta.url, reason: String(error.response?.status || error.code || error.message) });
      return [];
    }
  })));
  const entries = batches.flat();
  coverage.entries = entries.length;
  coverage.unavailable.sort((a, b) => a.url.localeCompare(b.url));
  return { entries, coverage };
}

module.exports = { fetchOfficialScoresheets };
