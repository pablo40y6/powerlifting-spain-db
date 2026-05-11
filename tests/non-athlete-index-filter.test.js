const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeAthleteEntries, _private: parserPrivate } = require('../scraper/parser');
const { auditIndex } = require('../scripts/audit-index');

function competition(name = 'Competición de prueba') {
  return parserPrivate.buildCompetitionMeta({
    pageTitle: name,
    meetPageUrl: 'https://powerliftingspain.es/test/',
    resultsUrl: 'https://powerliftingspain.es/wp-content/uploads/2025/06/Clasificacion_AEP-1-BANCA-MUERTO_Almensilla-Sevilla_2025-06-22.xls',
  }, { name });
}

function emptyAttempts() {
  const empty = () => [
    { raw: null, weight: null, good: null },
    { raw: null, weight: null, good: null },
    { raw: null, weight: null, good: null },
  ];

  return { squat: empty(), bench: empty(), deadlift: empty() };
}

function validAttempts() {
  return {
    squat: [{ raw: '230', weight: 230, good: true }],
    bench: [{ raw: '140', weight: 140, good: true }],
    deadlift: [{ raw: '250', weight: 250, good: true }],
  };
}

function athleteEntry(overrides = {}) {
  return parserPrivate.makeAthleteEntry({
    competition: competition(),
    sex: 'M',
    category: '-105kg',
    placing: '1',
    lifterName: 'Aranda Sanchez Saul',
    yearOfBirth: 2008,
    club: 'ZAB',
    bodyweight: 91.7,
    coefficient: 0.1317,
    order: 14,
    attempts: validAttempts(),
    total: 620,
    ipfgl: 82.5,
    liftType: 'powerlifting',
    ...overrides,
  });
}

function shouldReject(athleteName, club = '') {
  return parserPrivate.resultLooksLikeTeamOrSummary({ athleteName, club });
}

test('no indexa filas de clubes reales como atletas', () => {
  assert.equal(shouldReject('720 POWERLIFTING Ourense'), true);
  assert.equal(shouldReject('84 POWERLIFTING TEAM Malaga'), true);
});

test('no indexa filas de clubes con ranking, sin total/IPF GL ni intentos', () => {
  const clubRows = [
    athleteEntry({
      lifterName: "ALTEA-FINESTRAT-L'ALFAS",
      club: '[6]',
      placing: '11',
      attempts: emptyAttempts(),
      total: null,
      ipfgl: null,
      liftType: 'bench',
    }),
    athleteEntry({
      lifterName: 'MIKEBARBELL Madrid',
      club: '[12]',
      placing: '9',
      attempts: emptyAttempts(),
      total: null,
      ipfgl: null,
      liftType: 'bench',
    }),
  ];

  assert.equal(parserPrivate.shouldRejectNonAthleteResult(clubRows[0]), true);
  assert.equal(parserPrivate.shouldRejectNonAthleteResult(clubRows[1]), true);
  assert.deepEqual(mergeAthleteEntries(clubRows), []);
});

test('mantiene atletas reales de regresión aunque el filtro de clubes esté activo', () => {
  const aranda = athleteEntry({ lifterName: 'Aranda Sanchez Saul' });
  const garin = athleteEntry({ lifterName: 'Garin Martin Cristian' });

  assert.equal(shouldReject('Aranda Sanchez Saul'), false);
  assert.equal(shouldReject('Garin Martin Cristian'), false);
  assert.equal(parserPrivate.shouldRejectNonAthleteResult(aranda), false);
  assert.equal(parserPrivate.shouldRejectNonAthleteResult(garin), false);
  assert.deepEqual(mergeAthleteEntries([aranda, garin]).map((entry) => entry.athleteName), [
    'Aranda Sanchez Saul',
    'Garin Martin Cristian',
  ]);
});

test('no reintroduce fórmulas de puntos de equipos en resultados', () => {
  assert.equal(shouldReject('RISING POWERLIFTING [12+12+8]'), true);
  assert.equal(shouldReject('Atleta Prueba', '[12+12+8]'), true);

  const report = auditIndex({
    entries: mergeAthleteEntries([
      athleteEntry({ lifterName: 'RISING POWERLIFTING [12+12+8]', club: '[12+12+8]' }),
      athleteEntry({ lifterName: 'Aranda Sanchez Saul' }),
    ]).map((entry) => ({
      athleteName: entry.athleteName,
      athleteNameNormalized: entry.athleteNameNormalized,
      competitionName: entry.competition.name,
      competitionYear: entry.competition.year,
      competitionDate: entry.competition.date,
      meetPageUrl: entry.competition.meetPageUrl,
      resultsUrl: entry.competition.resultsUrl,
      sex: entry.sex,
      category: entry.category,
      placing: entry.placing,
      bodyweight: entry.bodyweight,
      total: entry.total,
      ipfgl: entry.ipfgl,
      eventType: entry.eventType,
      isIndividualResult: entry.isIndividualResult,
      isRankable: entry.isRankable,
      hasValidPowerliftingTotal: entry.hasValidPowerliftingTotal,
      attempts: entry.attempts,
      club: entry.club,
    })),
  });

  assert.equal(report.summary.byType.team_points_formula_in_result?.total || 0, 0);
});
