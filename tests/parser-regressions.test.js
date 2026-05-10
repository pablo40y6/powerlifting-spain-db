const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx-js-style');
const { parseDocument, _private } = require('../scraper/parser');
const { searchAthletes, _private: crawlerPrivate } = require('../scraper/crawler');
const { isLikelyResultsDocument, looksLikeCompetitionUrl } = require('../scraper/utils');

function competition(name = 'Competición de prueba') {
  return _private.buildCompetitionMeta({ pageTitle: name, meetPageUrl: 'https://powerliftingspain.es/test/' }, { name });
}

function hasFailedAttempt(entry) {
  return ['squat', 'bench', 'deadlift'].some((lift) =>
    (entry.attempts[lift] || []).some((attempt) => attempt && attempt.good === false)
  );
}



test('búsqueda por tokens normalizados sin depender del orden', () => {
  const index = {
    athletes: [
      { athleteName: 'Garin Martin Cristian', athleteNameNormalized: 'garin martin cristian', entries: [] },
      { athleteName: 'Borque Espinosa Antonio', athleteNameNormalized: 'borque espinosa antonio', entries: [] },
      { athleteName: 'Martinez Cordova Pablo', athleteNameNormalized: 'martinez cordova pablo', entries: [] },
    ],
  };

  assert.equal(searchAthletes(index, 'Cristian Garin')[0].athleteName, 'Garin Martin Cristian');
  assert.equal(searchAthletes(index, 'Garin Cristian')[0].athleteName, 'Garin Martin Cristian');
  assert.equal(searchAthletes(index, 'Antonio Borque')[0].athleteName, 'Borque Espinosa Antonio');
  assert.equal(searchAthletes(index, 'Borque Antonio')[0].athleteName, 'Borque Espinosa Antonio');
  assert.equal(searchAthletes(index, 'Pablo Cordova')[0].athleteName, 'Martinez Cordova Pablo');
});

test('modalidad distingue powerlifting completo de movimiento único', async () => {
  const wb = XLSX.utils.book_new();
  const powerlifting = XLSX.utils.aoa_to_sheet([
    [], ['Open Test 2026'], ['Powerlifting'], ['Madrid, 1 enero 2026'], ['HOMBRES'], ['-74kg'],
    ['Pos', 'Levantador', 'Año', 'Club', 'Peso', 'Coef.', 'Ord.', 'Sentadillas', '', '', 'Press Banca', '', '', 'Peso Muerto', '', '', 'Total', 'IPF GL'],
    [1, 'Atleta Completo', 1990, 'CLUB', 73.5, 1, 1, 180, 190, 200, 110, 120, 130, 220, 230, 240, 570, 85],
  ]);
  const bench = XLSX.utils.aoa_to_sheet([
    [], ['Open Test 2026'], ['Press Banca'], ['Madrid, 1 enero 2026'], ['HOMBRES'], ['-74kg'],
    ['Pos', 'Levantador', 'Año', 'Club', 'Peso', 'Coef.', 'Ord.', 'Press Banca', '', '', 'Total', 'IPF GL'],
    [1, 'Atleta Banca', 1991, 'CLUB', 72.5, 1, 2, 140, 145, 150, 150, 60],
  ]);
  XLSX.utils.book_append_sheet(wb, powerlifting, 'Powerlifting');
  XLSX.utils.book_append_sheet(wb, bench, 'Banca');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const entries = await parseDocument(buffer, '.xlsx', { pageTitle: 'Open Test 2026' });
  assert.equal(entries.find((entry) => entry.athleteName === 'Atleta Completo').eventType, 'powerlifting');
  assert.equal(entries.find((entry) => entry.athleteName === 'Atleta Banca').eventType, 'bench');
});

test('Saúl Aranda 2026: URL, documento flexible y fila PDF sin año', () => {
  const pageUrl = 'https://powerliftingspain.es/aep-1-campeonato-de-espana-sub-junior-humilladero-malaga-2026/';
  assert.equal(looksLikeCompetitionUrl(pageUrl, 'AEP-1 Campeonato de España Sub Junior Humilladero Málaga 2026'), true);
  assert.equal(isLikelyResultsDocument('Documento final Sub Junior', 'https://powerliftingspain.es/wp-content/uploads/2026/02/aep-subjunior-humilladero-2026.pdf'), true);

  const entry = _private.parsePdfAthleteLine(
    '-74 1 Aranda Sanchez Saul POWER CLUB 73,20 8 170 180 190 1 105 112,5 117,5 1 205 215 225 1 532,5 78,40',
    competition('AEP-1 Campeonato de España Sub Junior Humilladero Málaga 2026'),
    'M',
    '-74kg',
    'powerlifting'
  );

  assert.ok(entry);
  assert.equal(entry.athleteName, 'Aranda Sanchez Saul');
  assert.equal(searchAthletes({ athletes: [{ athleteName: entry.athleteName, athleteNameNormalized: entry.athleteNameNormalized, entries: [] }] }, 'Saul Aranda')[0].athleteName, 'Aranda Sanchez Saul');
});

test('fechas: conserva fecha explícita o year inferido de metadatos/URL sin inventar día', () => {
  const explicit = _private.buildCompetitionMeta({ pageTitle: 'Copa Catalana 2023' }, { locationDateText: 'Barcelona, 1 enero 2023' });
  assert.equal(explicit.date, '2023-01-01');
  assert.equal(explicit.year, 2023);

  const inferred = _private.buildCompetitionMeta({
    pageTitle: 'SBD Cup 2025',
    meetPageUrl: 'https://powerliftingspain.es/sbd-cup-2025/',
  });
  assert.equal(inferred.date, null);
  assert.equal(inferred.year, 2025);

  const pageMeta = crawlerPrivate.extractPageMeta('<html><h1>IV Copa Black Crown 2026</h1></html>', 'https://powerliftingspain.es/iv-copa-black-crown-2026/');
  assert.equal(pageMeta.year, 2026);
});


test('Pablo Martínez Córdova, Copa Catalana 2023: conserva nulos visuales de Excel', async () => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    [],
    ['Copa Catalana 2023'],
    ['Powerlifting'],
    ['Barcelona, 1 enero 2023'],
    ['HOMBRES'],
    ['-83kg'],
    ['Pos', 'Levantador', 'Año', 'Club', 'Peso', 'Coef.', 'Ord.', 'Sentadilla', '', '', 'Banca', '', '', 'Peso Muerto', '', '', 'Total', 'IPF GL'],
    [1, 'Pablo Martínez Córdova', 1990, 'CLUB TEST', 82.4, 1, 12, 180, 190, -200, 110, 120, -125, 210, 220, 230, 540, 75.25],
  ]);
  ws.J8.s = { font: { color: { rgb: 'FF0000' }, strike: true } };
  ws.M8.s = { font: { color: { rgb: 'FF0000' }, strike: true } };
  XLSX.utils.book_append_sheet(wb, ws, 'Resultados');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellStyles: true });

  const entries = await parseDocument(buffer, '.xlsx', { pageTitle: 'Copa Catalana 2023' });
  const pablo = entries.find((entry) => entry.athleteName === 'Pablo Martínez Córdova');
  assert.ok(pablo);
  assert.equal(pablo.total, 540);
  assert.equal(hasFailedAttempt(pablo), true);
});

test('Brunno Vázquez, SBD Cup 2025: acepta Ord. grande y peso corporal correcto', () => {
  const entry = _private.parsePdfAthleteLine(
    '-93 1 Brunno Vázquez 1998 SBD CLUB 92,40 1214 250 260 270 1 170 180 190 1 280 295 305 1 765 102,50',
    competition('SBD Cup 2025'),
    'M',
    '-93kg',
    'powerlifting'
  );

  assert.ok(entry);
  assert.equal(entry.athleteName, 'Brunno Vázquez');
  assert.equal(entry.bodyweight, 92.4);
  assert.equal(entry.order, 1214);
});

test('Oliver Prudencio, IV Copa Black Crown 2026: parsea PDF sin año de nacimiento', () => {
  const entry = _private.parsePdfAthleteLine(
    '-74 2 Oliver Prudencio RISING POWER 73,10 42 180 190 200 1 120 130 140 1 220 230 240 1 560 82,10',
    competition('IV Copa Black Crown 2026'),
    'M',
    '-74kg',
    'powerlifting'
  );

  assert.ok(entry);
  assert.equal(entry.athleteName, 'Oliver Prudencio');
  assert.equal(entry.yearOfBirth, null);
  assert.equal(entry.club, 'RISING POWER');
});

test('Almarche Martínez Lucía, Alto Aragón 2025: no crea categoría absurda -45739kg', async () => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    [],
    ['Alto Aragón 2025'],
    ['Powerlifting'],
    ['Huesca, 1 marzo 2025'],
    ['MUJERES'],
    [45739],
    ['Pos', 'Levantador', 'Año', 'Club', 'Peso', 'Coef.', 'Ord.', 'Sentadilla', '', '', 'Banca', '', '', 'Peso Muerto', '', '', 'Total', 'IPF GL'],
    [1, 'Almarche Martínez Lucía', 2001, 'ALTO ARAGON', 62.4, 1, 10, 100, 105, 110, 55, 60, 65, 125, 130, 135, 310, 55.1],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, 'Resultados');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const entries = await parseDocument(buffer, '.xlsx', { pageTitle: 'Alto Aragón 2025' });
  const lucia = entries.find((entry) => entry.athleteName === 'Almarche Martínez Lucía');
  assert.ok(lucia);
  assert.notEqual(lucia.category, '-45739kg');
});

test('Saúl Aranda, Campeonato de España Sub Junior Humilladero 2026: detecta URL de competición', () => {
  assert.equal(
    looksLikeCompetitionUrl('https://powerliftingspain.es/campeonato-de-espana-sub-junior-humilladero-2026/', 'Saúl Aranda Campeonato de España Sub Junior Humilladero 2026'),
    true
  );
});
