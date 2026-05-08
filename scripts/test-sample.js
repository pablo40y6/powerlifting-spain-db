const fs = require('fs');
const path = require('path');
const { parseDocument } = require('../lib/parser');

async function main() {
  const xlsPath = path.join(__dirname, '..', 'testdata', 'alto_aragon.xlsx');
  const pdfPath = path.join(__dirname, '..', 'testdata', 'alto_aragon_hombres.pdf');

  const excelEntries = await parseDocument(fs.readFileSync(xlsPath), '.xls', {
    resultsUrl: 'local-test.xls',
    resultsLabel: 'Local test excel',
    meetPageUrl: 'https://example.com/alto-aragon',
    pageTitle: 'AEP-3 Campeonato Alto Aragón, Barbastro, Huesca 2025',
  });

  const pdfEntries = await parseDocument(fs.readFileSync(pdfPath), '.pdf', {
    resultsUrl: 'local-test.pdf',
    resultsLabel: 'Local test pdf',
    meetPageUrl: 'https://example.com/alto-aragon',
    pageTitle: 'AEP-3 Campeonato Alto Aragón, Barbastro, Huesca 2025',
  });

  const alba = excelEntries.find((item) => item.athleteName === 'Mingo Gallego Alba');
  const saul = pdfEntries.find((item) => item.athleteName === 'Aranda Sanchez Saul');

  if (!alba) throw new Error('No se encontró a Alba en el Excel de prueba.');
  if (!saul) throw new Error('No se encontró a Saul en el PDF de prueba.');
  if (alba.total !== 312.5) throw new Error(`Total de Alba incorrecto: ${alba.total}`);
  if (saul.attempts.squat[0].good !== false || saul.attempts.squat[2].weight !== 210) {
    throw new Error('Los intentos de Saúl no se parsearon bien.');
  }

  console.log('[OK] Excel parseado:', excelEntries.length, 'filas');
  console.log('[OK] PDF parseado:', pdfEntries.length, 'filas');
  console.log('[OK] Alba y Saul validados correctamente');
}

main().catch((error) => {
  console.error('[ERROR]', error.message);
  process.exit(1);
});
