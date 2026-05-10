#!/usr/bin/env node
const { buildIndex } = require('./crawler');

buildIndex({
  onProgress(progress) {
    const percent = progress.percent ?? 0;
    process.stdout.write(`\r${progress.phase || 'running'} ${percent}%`);
  },
})
  .then((index) => {
    process.stdout.write('\n');
    console.log(`Indexado completado: ${index.athleteCount} atletas, ${index.entryCount} resultados, ${index.documentsIndexed} documentos.`);
    if (index.warnings?.length) {
      console.warn(`Avisos: ${index.warnings.length}`);
      for (const warning of index.warnings.slice(0, 20)) console.warn(`- ${warning}`);
    }
  })
  .catch((error) => {
    process.stdout.write('\n');
    console.error(error);
    process.exitCode = 1;
  });
