const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx-js-style');
const { parseDocument, _private } = require('../scraper/parser');
const { searchAthletes, _private: crawlerPrivate } = require('../scraper/crawler');
const { isLikelyResultsDocument, looksLikeCompetitionUrl, normalizeName } = require('../scraper/utils');

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

test('Saúl Aranda 2026: URL, documentos Resultados Hombres y fila GOODLIFT Sub Junior', () => {
  const pageUrl = 'https://powerliftingspain.es/aep-1-campeonato-de-espana-sub-junior-humilladero-malaga-2026/';
  const pdfUrl = 'https://powerliftingspain.es/wp-content/uploads/2026/04/Resultados-AEP1-Subjunior-Hombres-2026.pdf';
  assert.equal(looksLikeCompetitionUrl(pageUrl, 'Campeonato de España SUB JUNIOR Humilladero, Málaga 11 y 12 de abril de 2026'), true);
  assert.equal(isLikelyResultsDocument('Resultados Hombres', pdfUrl), true);

  const docs = crawlerPrivate.extractDocumentsFromCompetitionPage(`
    <h1>AEP 1 – Campeonato de España SUB JUNIOR, Humilladero, Málaga 2026</h1>
    <a href="${pdfUrl}">Resultados Hombres</a>
  `, pageUrl);
  assert.equal(docs[0].url, pdfUrl);

  const competitionMeta = _private.buildCompetitionMeta({
    pageTitle: 'AEP 1 – Campeonato de España SUB JUNIOR, Humilladero, Málaga 2026',
    meetPageUrl: pageUrl,
    resultsUrl: pdfUrl,
    resultsLabel: 'Resultados Hombres',
    date: '2026-04-11',
  });
  const entry = _private.parsePdfAthleteLine(
    '2 Aranda Sanchez Saul 2008 ZAB 91.70 0.1317 14 230.0 245.0 252.5 2 135.0 142.5 147.5 4 235.0 245.0 260.0 3 660.0 86.92 9',
    competitionMeta,
    'M',
    null,
    'powerlifting'
  );

  assert.ok(entry);
  assert.equal(normalizeName(entry.athleteName), 'aranda sanchez saul');
  assert.equal(entry.competition.meetPageUrl, pageUrl);
  assert.equal(entry.club, 'ZAB');
  assert.equal(entry.bodyweight, 91.7);
  assert.equal(entry.order, 14);
  assert.equal(entry.total, 660);
  assert.equal(entry.ipfgl, 86.92);
  const index = { athletes: [{ athleteName: entry.athleteName, athleteNameNormalized: entry.athleteNameNormalized, entries: [{ competitionName: entry.competition.name }] }] };
  assert.equal(searchAthletes(index, 'Saul Aranda')[0].athleteName, 'Aranda Sanchez Saul');
  assert.equal(searchAthletes(index, 'Aranda Sanchez')[0].athleteName, 'Aranda Sanchez Saul');
});


test('Saúl Aranda 2026: fallback GOODLIFT DETAILED SCORESHEET parsea fila invertida', () => {
  const competitionMeta = _private.buildCompetitionMeta({
    pageTitle: 'AEP 1 – Campeonato de España SUB JUNIOR, Humilladero, Málaga 2026',
    meetPageUrl: 'https://powerliftingspain.es/aep-1-campeonato-de-espana-sub-junior-humilladero-malaga-2026/',
    resultsLabel: 'Resultados Hombres',
  });
  const fixtureText = `
    DETAILED SCORESHEET
    Generated by the GOODLIFT
    Resultados Hombres
    9  86.92  660.0  3  260.0 245.0 235.0  4  147.5 142.5 135.0  2  252.5 245.0 230.0  14  0.1317 91.70 ZAB 2008 Aranda Sanchez Saul 2
  `;

  assert.equal(_private.isGoodliftPdfText(fixtureText), true);
  const entries = _private.parseGoodliftDetailedScoresheetLines(
    fixtureText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
    competitionMeta,
    'M'
  );
  const entry = entries.find((item) => item.athleteName === 'Aranda Sanchez Saul');

  assert.ok(entry);
  assert.equal(entry.sex, 'M');
  assert.equal(entry.eventType, 'powerlifting');
  assert.equal(entry.category, '-93kg');
  assert.equal(entry.placing, '2');
  assert.equal(entry.yearOfBirth, 2008);
  assert.equal(entry.club, 'ZAB');
  assert.equal(entry.bodyweight, 91.7);
  assert.equal(entry.coefficient, 0.1317);
  assert.equal(entry.order, 14);
  assert.equal(entry.total, 660);
  assert.equal(entry.ipfgl, 86.92);
  assert.deepEqual(entry.attempts.squat.map((attempt) => attempt.weight), [230, 245, 252.5]);
  assert.deepEqual(entry.attempts.bench.map((attempt) => attempt.weight), [135, 142.5, 147.5]);
  assert.deepEqual(entry.attempts.deadlift.map((attempt) => attempt.weight), [235, 245, 260]);
});


test('GOODLIFT Sub Junior 2026: el parser dedicado gana aunque el parser genérico encuentre pocas filas', () => {
  const competitionMeta = _private.buildCompetitionMeta({
    pageTitle: 'AEP 1 – Campeonato de España SUB JUNIOR, Humilladero, Málaga 2026',
    meetPageUrl: 'https://powerliftingspain.es/aep-1-campeonato-de-espana-sub-junior-humilladero-malaga-2026/',
    resultsUrl: 'https://powerliftingspain.es/wp-content/uploads/2026/04/Resultados-AEP1-Subjunior-Hombres-2026.pdf',
    resultsLabel: 'Resultados Hombres',
  });
  const fixtureText = `
    Generated by the GOODLIFT
    DETAILED SCORESHEET
    Resultados Hombres
    1 Atleta Generico 2007 GEN 72.50 0.1400 12 170.0 180.0 190.0 1 100.0 105.0 110.0 1 180.0 190.0 200.0 1 500.0 70.00 10
    9 86.92 660.0 3 260.0 245.0 235.0 4 147.5 142.5 135.0 2 252.5 245.0 230.0 14 0.1317 91.70 ZAB 2008 Aranda Sanchez Saul 2
    Team (points)
    1 SPARTA Murcia [12+12+9+9] 42
    Best Lifters
    10 70.00 500.0 2 200.0 190.0 180.0 3 110.0 105.0 100.0 4 190.0 180.0 170.0 15 0.1400 82.00 ABC 2007 Garin Martin Cristian 1
    Abbreviations
    ZAB Zabalategi
  `;

  const entries = _private.parsePdfText(fixtureText, competitionMeta);
  const aranda = entries.find((entry) => entry.athleteName === 'Aranda Sanchez Saul');

  assert.ok(entries.length > 1);
  assert.ok(aranda);
  assert.equal(aranda.athleteName, 'Aranda Sanchez Saul');
  assert.equal(aranda.club, 'ZAB');
  assert.equal(aranda.sex, 'M');
  assert.equal(aranda.bodyweight, 91.7);
  assert.equal(aranda.category, '-93kg');
  assert.equal(aranda.total, 660);
  assert.equal(aranda.ipfgl, 86.92);
  assert.equal(aranda.eventType, 'powerlifting');
  assert.equal(aranda.isIndividualResult, true);
  assert.equal(aranda.hasValidPowerliftingTotal, true);
  assert.equal(aranda.isRankable, true);
  assert.equal(entries.some((entry) => /SPARTA|POWERLIFTING ALBACETE|SOY POWERLIFTER/i.test(entry.athleteName)), false);
});

test('GOODLIFT DETAILED SCORESHEET: conserva sufijos válidos y X sin peso', () => {
  const entry = _private.parseGoodliftDetailedScoresheetLine(
    '9 86.92 660.0 3 260.0-ws 245.0 X 4 147.5-wbs 142.5 135.0 2 252.5 245.0 230.0 14 0.1317 91.70 ZAB 2008 Aranda Sanchez Saul 2',
    competition('AEP 1 Sub Junior 2026'),
    'M',
    null
  );

  assert.ok(entry);
  assert.equal(entry.attempts.deadlift[2].raw, '260.0-ws');
  assert.equal(entry.attempts.deadlift[2].weight, 260);
  assert.equal(entry.attempts.deadlift[0].raw, 'X');
  assert.equal(entry.attempts.deadlift[0].weight, null);
  assert.equal(entry.attempts.bench[2].raw, '147.5-wbs');
  assert.equal(entry.attempts.bench[2].weight, 147.5);
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

  const pablo = _private.buildCompetitionMeta({
    pageTitle: 'I Copa Catalana de Powerlifting y Press Banca',
    resultsLabel: 'Copa Catalana 2023',
  });
  assert.equal(pablo.date, null);
  assert.equal(pablo.year, 2023);

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

test('crawler/discovery: campeonatos-ano-2026 descubre Sub Junior Humilladero 2026', () => {
  const seedUrl = 'https://powerliftingspain.es/campeonatos-ano-2026/';
  const competitionUrl = 'https://powerliftingspain.es/aep-1-campeonato-de-espana-sub-junior-humilladero-malaga-2026/';

  assert.ok(crawlerPrivate.SEED_YEAR_PAGES.includes(seedUrl));

  const found = crawlerPrivate.discoverCompetitionPages(`
    <article>
      <a href="${competitionUrl}">
        AEP-1 Campeonato de España SUB JUNIOR, Humilladero, Málaga 2026
      </a>
    </article>
  `, seedUrl);

  assert.ok(found.pages.some((page) => page.url === competitionUrl));
});

test('crawler/discovery: página de competición extrae documentos bajo Resultados Hombres/Mujeres con texto no exacto', () => {
  const pageUrl = 'https://powerliftingspain.es/aep-1-campeonato-de-espana-sub-junior-humilladero-malaga-2026/';
  const menUrl = 'https://powerliftingspain.es/wp-content/uploads/2026/04/aep1-sub-h.pdf';
  const womenUrl = 'https://powerliftingspain.es/wp-content/uploads/2026/04/aep1-sub-m.pdf';

  const docs = crawlerPrivate.extractDocumentsFromCompetitionPage(`
    <h1>AEP-1 Campeonato de España SUB JUNIOR, Humilladero, Málaga 2026</h1>
    <h3>Resultados Hombres</h3>
    <p><a href="${menUrl}">Descargar PDF</a></p>
    <h3>Resultados Mujeres</h3>
    <p><a href="${womenUrl}" aria-label="Documento PDF">Ver archivo</a></p>
  `, pageUrl);

  assert.deepEqual(docs.map((doc) => doc.url).sort(), [menUrl, womenUrl].sort());
});

test('categoría GOODLIFT se infiere por peso corporal cuando el encabezado arrastrado no es fiable', () => {
  assert.equal(_private.inferPowerliftingCategoryFromBodyweight(91.70, 'M'), '-93kg');

  const entry = _private.parseGoodliftDetailedScoresheetLine(
    '9 86.92 660.0 3 260.0 245.0 235.0 4 147.5 142.5 135.0 2 252.5 245.0 230.0 14 0.1317 91.70 ZAB 2008 Aranda Sanchez Saul 2',
    competition('AEP 1 Sub Junior 2026'),
    'M',
    '-105kg'
  );

  assert.ok(entry);
  assert.equal(entry.category, '-93kg');
  assert.notEqual(entry.category, '-105kg');
});

test('búsqueda permite prefijos normalizados de tokens en cualquier orden', () => {
  const index = {
    athletes: [
      { athleteName: 'Aranda Sanchez Saul', athleteNameNormalized: 'aranda sanchez saul', entries: [] },
      { athleteName: 'Garin Martin Cristian', athleteNameNormalized: 'garin martin cristian', entries: [] },
      { athleteName: 'Borque Espinosa Antonio', athleteNameNormalized: 'borque espinosa antonio', entries: [] },
    ],
  };

  assert.equal(searchAthletes(index, 'saul arand')[0].athleteName, 'Aranda Sanchez Saul');
  assert.equal(searchAthletes(index, 'aran sau')[0].athleteName, 'Aranda Sanchez Saul');
  assert.equal(searchAthletes(index, 'crist gar')[0].athleteName, 'Garin Martin Cristian');
  assert.equal(searchAthletes(index, 'ant borq')[0].athleteName, 'Borque Espinosa Antonio');
});

test('GOODLIFT: ignora secciones de equipos sin cortar atletas individuales posteriores', () => {
  const entries = _private.parseGoodliftDetailedScoresheetLines([
    'DETAILED SCORESHEET',
    '9 86.92 660.0 3 260.0 245.0 235.0 4 147.5 142.5 135.0 2 252.5 245.0 230.0 14 0.1317 91.70 ZAB 2008 Aranda Sanchez Saul 2',
    'Team (points)',
    '1 SPARTA Murcia [12+12+9+9] 42',
    '2 POWERLIFTING ALBACETE [9+9+8] 26',
    'Best Lifters',
    '1 SOY POWERLIFTER Madrid 125.00',
    '10 70.00 500.0 2 200.0 190.0 180.0 3 110.0 105.0 100.0 4 190.0 180.0 170.0 15 0.1400 82.00 ABC 2007 Garin Martin Cristian 1',
    'Abbreviations',
    'ZAB Zabalategi'
  ], competition('AEP 1 Sub Junior 2026'), 'M');

  assert.deepEqual(entries.map((entry) => entry.athleteName), ['Aranda Sanchez Saul', 'Garin Martin Cristian']);
  assert.equal(
    _private.parseGoodliftDetailedScoresheetLine(
      '1 125.0 42.0 1 0 0 0 1 0 0 0 1 0 0 0 1 0.1234 90.00 SPARTA 2026 POWERLIFTING ALBACETE 1',
      competition('Resumen equipos'),
      'M',
      null
    ),
    null
  );
});

test('powerlifting sin sentadilla válida no es rankeable por Total/IPF GL', () => {
  const entry = _private.makeAthleteEntry({
    competition: competition('Competición con resultado incompleto'),
    sex: 'F',
    category: '-63kg',
    placing: '1',
    lifterName: 'Carrillo de Freitas Angely',
    yearOfBirth: 2000,
    club: 'CLUB TEST',
    bodyweight: 62.1,
    coefficient: null,
    order: 1,
    attempts: {
      squat: [
        { raw: '-112.5', weight: 112.5, good: false },
        { raw: '-112.5', weight: 112.5, good: false },
        { raw: '-115', weight: 115, good: false },
      ],
      bench: [
        { raw: '52.5', weight: 52.5, good: true },
        { raw: null, weight: null, good: null },
        { raw: null, weight: null, good: null },
      ],
      deadlift: [
        { raw: '57.5', weight: 57.5, good: true },
        { raw: '-60', weight: 60, good: false },
        { raw: '112.5', weight: 112.5, good: true },
      ],
      __labels: { squat: 'Sentadilla', bench: 'Banca', deadlift: 'Peso muerto' },
    },
    total: 122.5,
    ipfgl: 125,
    liftType: 'powerlifting',
  });

  assert.equal(entry.hasValidPowerliftingTotal, false);
  assert.equal(entry.isRankable, false);
});
