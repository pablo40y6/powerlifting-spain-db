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


function deadliftOnlyAttempt(weight) {
  const attempts = emptyAttempts();
  attempts.deadlift[0] = { raw: String(weight), weight, good: true };
  return attempts;
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



test('no indexa clasificaciones de clubes detectadas por ranking en el club aunque el nombre no sea obvio', () => {
  const clubRows = [
    athleteEntry({
      lifterName: 'ALFA Forjando Atletas Madrid',
      club: '[9]',
      competition: competition('Copa de España Absoluta'),
      category: '+120kg',
      placing: '7',
      bodyweight: null,
      attempts: emptyAttempts(),
      total: null,
      ipfgl: null,
      liftType: 'bench',
    }),
    athleteEntry({
      lifterName: 'ALFA Forjando Atletas Madrid',
      club: '[9] 73,73 GL Pts',
      competition: competition('30º Campeonato de España Absoluto de PRESS BANCA'),
      category: '+120kg',
      placing: '10',
      bodyweight: null,
      attempts: emptyAttempts(),
      total: null,
      ipfgl: null,
      liftType: 'bench',
    }),
    athleteEntry({
      lifterName: 'ALTERNATIVE RAW Huelva',
      club: '[12]',
      competition: competition('Campeonato de España OPEN de PESO MUERTO'),
      category: '-120kg',
      placing: '3',
      bodyweight: null,
      attempts: emptyAttempts(),
      total: null,
      ipfgl: null,
      liftType: 'deadlift',
    }),
    athleteEntry({
      lifterName: 'BLACK CROWN Madrid',
      club: '[8]',
      placing: '6',
      bodyweight: null,
      attempts: emptyAttempts(),
      total: null,
      ipfgl: null,
      liftType: 'bench',
    }),
    athleteEntry({
      lifterName: 'DANIGPOWER Madrid',
      club: '[11]',
      placing: '8',
      bodyweight: null,
      attempts: emptyAttempts(),
      total: null,
      ipfgl: null,
      liftType: 'bench',
    }),
  ];

  for (const row of clubRows) {
    assert.equal(parserPrivate.shouldRejectNonAthleteResult(row), true, row.athleteName);
  }
  assert.deepEqual(mergeAthleteEntries(clubRows), []);
});

test('no indexa filas de clasificación por clubes con puntos desplazados', () => {
  const clubRows = [
    athleteEntry({
      competition: competition('I Campeonato Interregional del ESTE'),
      lifterName: "ALTEA-FINESTRAT-L'ALFAS",
      club: '[12]',
      category: '+84kg',
      placing: '3',
      bodyweight: null,
      attempts: deadliftOnlyAttempt(8),
      total: 78.36,
      ipfgl: null,
      liftType: 'powerlifting',
    }),
    athleteEntry({
      competition: competition('Copa de España OPEN (ABSOLUTO)'),
      lifterName: "ALTEA-FINESTRAT-L'ALFAS",
      club: '[12]',
      category: '+120kg',
      placing: '10',
      bodyweight: null,
      attempts: deadliftOnlyAttempt(6),
      total: 86,
      ipfgl: null,
      liftType: 'powerlifting',
    }),
    athleteEntry({
      competition: competition('30º Campeonato de España Absoluto de PRESS BANCA'),
      lifterName: "ALTEA-FINESTRAT-L'ALFAS",
      club: '[7] 64,37 GL Pts',
      category: '+120kg',
      placing: '15',
      bodyweight: null,
      attempts: emptyAttempts(),
      total: null,
      ipfgl: null,
      liftType: 'bench',
    }),
  ];

  assert.equal(parserPrivate.shouldRejectNonAthleteResult(clubRows[0]), true);
  assert.equal(parserPrivate.shouldRejectNonAthleteResult(clubRows[1]), true);
  assert.equal(parserPrivate.shouldRejectNonAthleteResult(clubRows[2]), true);
  assert.deepEqual(mergeAthleteEntries(clubRows), []);
});


test('no indexa rankings de equipos con puntuación desplazada a club o bodyweight', () => {
  const clubRows = [
    athleteEntry({
      lifterName: 'ATLETAS FUERZA CASARICHE',
      club: '71,71',
      competition: competition('XI Campeonato SUR'),
      category: '+120kg',
      placing: '4',
      bodyweight: null,
      attempts: emptyAttempts(),
      total: null,
      ipfgl: null,
      liftType: 'powerlifting',
    }),
    athleteEntry({
      lifterName: 'BEGOAL Alicante',
      club: '[9]',
      competition: competition('Copa de España OPEN y MASTERS'),
      category: null,
      placing: '8',
      bodyweight: 70.05,
      attempts: emptyAttempts(),
      total: null,
      ipfgl: null,
      liftType: 'bench',
    }),
    athleteEntry({
      lifterName: 'DANIGPOWER Madrid',
      club: '[11]',
      placing: '8',
      bodyweight: 73.73,
      attempts: emptyAttempts(),
      total: null,
      ipfgl: null,
      liftType: 'bench',
    }),
    athleteEntry({
      lifterName: 'FUERZA GUADAIRA',
      club: '[8] 65,50 GL Pts',
      placing: '6',
      bodyweight: null,
      attempts: emptyAttempts(),
      total: null,
      ipfgl: null,
      liftType: 'bench',
    }),
    athleteEntry({
      lifterName: 'FUERZA NAZARI',
      club: '69,25',
      placing: '5',
      bodyweight: null,
      attempts: emptyAttempts(),
      total: null,
      ipfgl: null,
      liftType: 'powerlifting',
    }),
    athleteEntry({
      lifterName: 'INDAR POWER',
      club: '[7]',
      placing: '4',
      bodyweight: 68.4,
      attempts: emptyAttempts(),
      total: null,
      ipfgl: null,
      liftType: 'deadlift',
    }),
    athleteEntry({
      lifterName: 'LIFT AMBITION',
      club: '[6]',
      placing: '3',
      bodyweight: null,
      attempts: emptyAttempts(),
      total: null,
      ipfgl: null,
      liftType: 'bench',
    }),
    athleteEntry({
      lifterName: 'SIDEROPOLIS',
      club: '[5]',
      placing: '2',
      bodyweight: 72.1,
      attempts: emptyAttempts(),
      total: null,
      ipfgl: null,
      liftType: 'bench',
    }),
  ];

  for (const row of clubRows) {
    assert.equal(parserPrivate.shouldRejectNonAthleteResult(row), true, row.athleteName);
  }
  assert.deepEqual(mergeAthleteEntries(clubRows), []);
});


test('no indexa filas de equipos nacionales con fórmula decimal de puntos', () => {
  const rows = [
    athleteEntry({
      lifterName: 'ESPAÑA',
      club: '[102,83+99,54+97,67+96,41+93,39]',
      competition: competition('II Copa de los Pirineos'),
      placing: '1',
      bodyweight: null,
      attempts: emptyAttempts(),
      total: null,
      ipfgl: null,
      liftType: 'powerlifting',
    }),
    athleteEntry({
      lifterName: 'FRANCIA',
      club: '[104,17+102,76+102,06+93,03+86,16]',
      competition: competition('II Copa de los Pirineos'),
      placing: '2',
      bodyweight: null,
      attempts: emptyAttempts(),
      total: null,
      ipfgl: null,
      liftType: 'powerlifting',
    }),
  ];

  for (const row of rows) {
    assert.equal(parserPrivate.shouldRejectNonAthleteResult(row), true, row.athleteName);
  }
  assert.deepEqual(mergeAthleteEntries(rows), []);
});

test('no indexa filas incompletas no rankeables sin marcas deportivas', () => {
  const rows = [
    athleteEntry({
      lifterName: 'Fariña Crepo Raul',
      club: 'CLUB TEST',
      placing: '4',
      bodyweight: 90.02,
      coefficient: null,
      attempts: emptyAttempts(),
      total: null,
      ipfgl: null,
      liftType: 'powerlifting',
    }),
    athleteEntry({
      lifterName: 'Moldovan (AI) Valentin',
      club: 'CLUB TEST',
      placing: 'AI',
      bodyweight: 96.44,
      coefficient: null,
      attempts: emptyAttempts(),
      total: null,
      ipfgl: null,
      liftType: 'powerlifting',
    }),
  ];

  for (const row of rows) {
    assert.equal(parserPrivate.shouldRejectNonAthleteResult(row), true, row.athleteName);
  }
  assert.deepEqual(mergeAthleteEntries(rows), []);
});

test('no filtra atletas con nombre personal aunque tengan datos parciales raros', () => {
  const partialAthlete = athleteEntry({
    lifterName: 'Aranda Sanchez Saul',
    club: '[12]',
    bodyweight: null,
    attempts: deadliftOnlyAttempt(8),
    total: 86,
    ipfgl: null,
    liftType: 'powerlifting',
  });

  assert.equal(parserPrivate.shouldRejectNonAthleteResult(partialAthlete), false);
  assert.deepEqual(mergeAthleteEntries([partialAthlete]).map((entry) => entry.athleteName), [
    'Aranda Sanchez Saul',
  ]);
});

test('mantiene atletas reales con club real aunque no tengan marca rankeable', () => {
  const realAthlete = athleteEntry({
    lifterName: 'Eduardo Rallo Madrid',
    club: 'ZAB',
    placing: '4',
    bodyweight: null,
    attempts: emptyAttempts(),
    total: null,
    ipfgl: null,
    liftType: 'bench',
  });

  assert.equal(parserPrivate.shouldRejectNonAthleteResult(realAthlete), false);
  assert.deepEqual(mergeAthleteEntries([realAthlete]).map((entry) => entry.athleteName), [
    'Eduardo Rallo Madrid',
  ]);
});


test('mantiene atleta real con bodyweight válido si el club no parece ranking ni puntos', () => {
  const realAthlete = athleteEntry({
    lifterName: 'Eduardo Rallo Madrid',
    club: 'ZAB',
    placing: '4',
    bodyweight: 70.05,
    attempts: emptyAttempts(),
    total: null,
    ipfgl: null,
    liftType: 'bench',
  });

  assert.equal(parserPrivate.shouldRejectNonAthleteResult(realAthlete), false);
  assert.deepEqual(mergeAthleteEntries([realAthlete]).map((entry) => entry.athleteName), [
    'Eduardo Rallo Madrid',
  ]);
});

test('mantiene atletas reales con intentos significativos aunque tengan placing y club con ranking', () => {
  const realAthlete = athleteEntry({
    lifterName: 'Eduardo Rallo Madrid',
    club: '[9]',
    placing: '4',
    bodyweight: null,
    attempts: deadliftOnlyAttempt(180),
    total: null,
    ipfgl: null,
    liftType: 'deadlift',
  });

  assert.equal(parserPrivate.shouldRejectNonAthleteResult(realAthlete), false);
  assert.deepEqual(mergeAthleteEntries([realAthlete]).map((entry) => entry.athleteName), [
    'Eduardo Rallo Madrid',
  ]);
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
