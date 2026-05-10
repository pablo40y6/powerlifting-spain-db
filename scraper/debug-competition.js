#!/usr/bin/env node
const path = require('path');
const { parseDocument } = require('./parser');
const { getExtension } = require('./utils');
const { _private } = require('./crawler');

async function main() {
  const competitionUrl = process.argv[2];
  if (!competitionUrl) {
    console.error('Uso: npm run debug:competition -- <url-competicion>');
    process.exitCode = 1;
    return;
  }

  const client = _private.createHttpClient();
  console.log(`Competición URL: ${competitionUrl}`);

  const html = await _private.fetchText(client, competitionUrl);
  const meta = _private.extractPageMeta(html, competitionUrl);
  const docs = _private.extractDocumentsFromCompetitionPage(html, competitionUrl);

  console.log(`Título detectado: ${meta.pageTitle || '(sin título)'}`);
  console.log(`Fecha detectada: ${meta.date || '(sin fecha)'}`);
  console.log(`Año detectado: ${meta.year || '(sin año)'}`);
  console.log(`Documentos encontrados: ${docs.length}`);

  for (const doc of docs) {
    console.log(`- ${doc.label || path.basename(doc.url)}: ${doc.url}`);
  }

  for (const doc of docs) {
    try {
      const buffer = await _private.fetchBufferWithCache(client, doc.url);
      const entries = await parseDocument(buffer, getExtension(doc.url), {
        pageTitle: meta.pageTitle,
        meetPageUrl: competitionUrl,
        resultsUrl: doc.url,
        resultsLabel: doc.label,
        date: meta.date,
        year: meta.year,
      });
      const arandaRows = entries.filter((entry) => /aranda/i.test(entry.athleteName || ''));
      console.log(`Parseados ${entries.length} resultados en ${doc.url}`);
      console.log(`Filas con "Aranda": ${arandaRows.length}`);
      for (const row of arandaRows) {
        console.log(`  * ${row.athleteName} | ${row.club || ''} | total=${row.total ?? ''}`);
      }
    } catch (error) {
      console.log(`Parseados 0 resultados en ${doc.url}`);
      console.log(`Error procesando documento: ${error.message}`);
    }
  }
}

main().catch((error) => {
  console.error(`Error debug: ${error.message}`);
  process.exitCode = 1;
});
