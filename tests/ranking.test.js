const test = require('node:test');
const assert = require('node:assert/strict');
const { todayInSpain, expiresOn, topRanking } = require('../web/ranking');
const {
  ipfResults, alignInternationalNames, findAepInternationalMeets,
  aepInternationalLinks, connectAepInternationalPages, classifyAepInternational, mergeInternationalResults, assignRankingIdentities,
} = require('../scraper/international');
const { parsePdfScoreRows } = require('../scraper/federation-scoresheets');

test('la vigencia usa meses naturales y el día de España', () => {
  assert.equal(expiresOn('2025-08-31'), '2027-02-28');
  assert.equal(expiresOn('2026-08-31'), '2028-02-29');
  assert.equal(expiresOn('2026-02-30'), null);
  assert.equal(todayInSpain(new Date('2026-07-31T22:15:00Z')), '2026-08-01');
});

function mark(overrides = {}) {
  return {
    athleteId: 'lifter', athleteName: 'Atleta de Prueba', sex: 'F', category: '-69kg',
    competitionDate: '2026-06-10', equipment: 'raw', isRankable: true, bodyweight: 65,
    eventType: 'powerlifting', total: 400, ipfgl: 84, country: 'ESP',
    attempts: { bench: [{ weight: 100, good: true }, { weight: 115, good: false }] },
    ...overrides,
  };
}

test('la banca mezcla ambas pruebas, con una sola marca vigente y válida por atleta', () => {
  const options = { sex: 'F', category: '-69kg', equipment: 'raw', metric: 'bench', today: '2026-11-24' };
  const rows = [
    mark(), mark({ eventType: 'bench', bestLifts: { bench: 110 } }),
    mark({ bestLifts: { bench: 130 }, competitionDate: '2025-05-23' }),
    mark({ bestLifts: { bench: 150 }, equipment: 'equipped' }),
    mark({ bestLifts: { bench: 180 }, competitionDate: '2026-11-25' }),
    mark({ athleteId: 'guest', bestLifts: { bench: 125 }, placing: 'AI' }),
    mark({ athleteId: 'france', bestLifts: { bench: 170 }, country: 'FRA' }),
    mark({ athleteId: 'unknown', bestLifts: { bench: 180 }, country: null }),
    mark({ athleteId: 'second', bestLifts: { bench: 90 }, competitionDate: '2025-05-24' }),
    mark({ athleteId: 'review', bestLifts: { bench: 150 }, sourceReview: {} }),
  ];
  assert.deepEqual(topRanking(rows, options).map((v) => [v.value, v.row.eventType, v.expiration, v.daysRemaining]), [
    [110, 'bench', '2027-12-10', 381], [90, 'powerlifting', '2026-11-24', 0],
  ]);
  assert.equal(topRanking(rows, { ...options, metric: 'ipfgl' })[0].row.eventType, 'powerlifting');
});

test('el ranking se limita a 50 atletas de la categoría y ordena por marca', () => {
  const rows = Array.from({ length: 65 }, (_, i) => mark({ athleteId: String(i), total: 300 + i }));
  const ranked = topRanking(rows, { sex: 'F', category: '-69kg', equipment: 'raw', today: '2026-11-24' });
  assert.equal(ranked.length, 50);
  assert.equal(ranked[0].value, 364);
  assert.equal(ranked.at(-1).value, 315);
});

test('el acta IPF de banca usa la columna de banca y conserva los nulos', () => {
  const html = `<div><h4>2026 IPF World Classic Bench Press Championships</h4><p>23 May - 31 May 2026</p></div>
    <h2>WOMEN - OPEN</h2><table><tr><td>69kg</td></tr><tr><td>1</td><td><a>Atleta Prueba</a></td>
    <td>1995</td><td>ESP</td><td>3</td><td>67.50</td><td>0.5</td>
    <td>X</td><td>X</td><td>X</td><td>-</td>
    <td class="G">90</td><td class="N">95</td><td class="G">95</td><td>95 [1]</td>
    <td>X</td><td>X</td><td>X</td><td>-</td><td>-</td><td>12</td><td>47.5</td><td>1</td></tr></table>`;
  const [entry] = ipfResults(html, 'https://ipf.powerlifting.sport/results/view/1');
  assert.deepEqual([entry.total, entry.ipfgl, entry.attempts.bench[1].good, entry.eventType], [95, 47.5, false, 'bench']);
});

test('el acta europea conserva el tachado y exige que los tres mejores válidos sumen el total', () => {
  const row = (values, failures = []) => values.map((text, index) => ({ text, failed: failures.includes(index) }));
  const marks = ['65,60', '0,15649', '7', '230', '240', '247,5', '3', '145', '152,5', '155', '3',
    '240', '252,5', '252,5', '5', '652,5', '102,04', '8'];
  const rows = [
    row(['European Open Classic Powerlifting Championships']),
    row(['15-22.03.2026']),
    row(['66 kg']),
    row(['3.', 'Fernandez Arcas Alvaro', '1989', 'ESP', ...marks], [13, 17]),
    row(['4.', 'Atleta de Francia', '1989', 'FRA', ...marks], [13, 17]),
    row(['5.', 'Total incorrecto', '1989', 'ESP', ...marks], [17]),
  ];
  const results = parsePdfScoreRows(rows, {
    fed: 'EPF', year: 2026, header: 'Men',
    title: 'European Open Classic Powerlifting Championships',
    url: 'https://www.europowerlifting.org/fileadmin/data/results/2026/open-classic/detailed_scoresheet_m.pdf',
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].competition.date, '2026-03-15');
  assert.equal(results[0].attempts.bench[2].good, false);
  assert.equal(results[0].total, 652.5);
  assert.deepEqual(results[0].bestLifts, { squat: 247.5, bench: 152.5, deadlift: 252.5 });

  const nomination = 'https://powerliftingspain.es/convocatoria-universitaria.pdf';
  const university = parsePdfScoreRows([...rows.slice(0, 3),
    row(['3.', 'Atleta Seleccionado', '2005', 'UGR', ...marks], [13, 17]),
    row(['4.', 'Atleta No Convocado', '2005', 'UGR', ...marks], [13, 17]),
  ], {
    fed: 'EPF', year: 2026, header: 'Men',
    title: 'European Classic University Cup',
    url: 'https://www.europowerlifting.org/fileadmin/data/results/2026/university-cup/detailed_scoresheet_m.pdf',
    roster: { url: nomination, athletes: [{ name: 'Seleccionado Atleta', sex: 'M', birth: 2005 }] },
  });
  assert.deepEqual(university.map((entry) => [entry.athleteName, entry.country, entry.countrySource]),
    [['Atleta Seleccionado', 'ESP', nomination]]);
});

test('el calendario internacional de la AEP enlaza el acta y se prioriza sobre la copia', () => {
  const [meet] = findAepInternationalMeets(`
    <div class="oew-accordion-title">EPF CAMPEONATOS de EUROPA 2026</div>
    <div class="oew-accordion-content"><h3><a href="/epf-test-2026/">Europeo Open Classic<br>Malta<br>15 - 22 marzo 2026</a></h3></div>
    <div class="oew-accordion-title">AEP-1 CAMPEONATOS de ESPAÑA 2026</div>
    <div class="oew-accordion-content"><h3><a href="/aep-domestico-2026/">AEP</a></h3></div>
  `, 'https://powerliftingspain.es/campeonatos-ano-2026/', 2026);
  assert.equal(meet.date, '2026-03-15');
  meet.links = aepInternationalLinks(`
    <a href="https://www.openipf.org/m/epf/2604">Clasificación OPEN IPF</a>
    <a href="http://goodlift.info/onecompetition.php?cid=1151">Resultados Hombres</a>
    <a href="https://goodlift.info/nominations.php">Inscripciones</a>
  `, meet.url);
  const local = {
    athleteNameNormalized: 'fernandez arcas alvaro', club: 'SPA', sex: 'M', category: '-66kg',
    equipment: 'raw', bodyweight: 65.6, total: 652.5, eventType: 'powerlifting',
    competition: { date: meet.date, year: 2026, meetPageUrl: meet.url, resultsUrl: 'https://powerliftingspain.es/acta.xls' },
  };
  const external = { ...local, athleteNameNormalized: 'alvaro fernandez arcas', country: 'ESP',
    sourceFederation: 'EPF', competition: { date: meet.date, year: 2026, resultsUrl: 'https://www.europowerlifting.org/fileadmin/data/results/2026/open-classic/detailed_scoresheet_m.pdf' } };
  const [matched] = connectAepInternationalPages([external], [meet]);
  assert.equal(matched.competition.meetPageUrl, meet.url);
  assert.deepEqual(matched.competition.officialResultsUrls, ['https://goodlift.info/onecompetition.php?cid=1151']);
  assert.equal(classifyAepInternational({ ...local, club: 'FRA' }, meet), null);
  const primary = classifyAepInternational(local, meet);
  assert.equal(primary.country, 'ESP');
  assert.deepEqual(mergeInternationalResults([primary], [matched]), [primary]);
});

test('el Top 50 no duplica a un atleta si su nombre aparece en otro orden', () => {
  const rows = [
    mark({ athleteName: 'Corta García Ana', athleteId: 'a', athleteNameNormalized: 'corta garcia ana', yearOfBirth: 1995 }),
    mark({ athleteName: 'Ana Corta García', athleteId: 'b', athleteNameNormalized: 'ana corta garcia', yearOfBirth: 1995, total: 410 }),
    mark({ athleteName: 'Ana Corta García', athleteId: 'c', athleteNameNormalized: 'ana corta garcia', yearOfBirth: 1997, total: 390 }),
  ];
  assignRankingIdentities(rows);
  assert.equal(rows[0].rankingAthleteId, rows[1].rankingAthleteId);
  assert.notEqual(rows[1].rankingAthleteId, rows[2].rankingAthleteId);
  assert.deepEqual(topRanking(rows, { sex: 'F', category: '-69kg', equipment: 'raw', today: '2026-11-24' }).map(({value}) => value), [410, 390]);
});
