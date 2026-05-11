const test = require('node:test');
const assert = require('node:assert/strict');
const {
  auditIndex,
  expectedCategoryForBodyweight,
  looksLikeClubAthleteName,
  buildRegressionSection,
} = require('../scripts/audit-index');

function entry(overrides = {}) {
  return {
    athleteName: 'Atleta Prueba',
    athleteNameNormalized: 'atleta prueba',
    competitionName: 'Open Test 2026',
    competitionYear: 2026,
    competitionDate: '2026-01-01',
    meetPageUrl: 'https://powerliftingspain.es/open-test-2026/',
    resultsUrl: 'https://powerliftingspain.es/wp-content/uploads/2026/01/resultados.pdf',
    sex: 'M',
    category: '-93kg',
    placing: '1',
    bodyweight: 91.7,
    total: 660,
    ipfgl: 86.92,
    eventType: 'powerlifting',
    isIndividualResult: true,
    isRankable: true,
    hasValidPowerliftingTotal: true,
    attempts: {
      squat: [{ weight: 250, good: true }],
      bench: [{ weight: 150, good: true }],
      deadlift: [{ weight: 260, good: true }],
    },
    ...overrides,
  };
}

function findingTypes(report) {
  return report.findings.map((finding) => finding.type);
}

test('categoría M 91.70 -105kg detecta expected -93kg', () => {
  assert.equal(expectedCategoryForBodyweight('M', 91.7), '-93kg');
  const report = auditIndex({ entries: [entry({ category: '-105kg' })] });
  const finding = report.findings.find((item) => item.type === 'category_bodyweight_mismatch');
  assert.ok(finding);
  assert.equal(finding.expected, '-93kg');
});

test('powerlifting sin sentadilla válida y con IPF GL alto genera warning/error', () => {
  const report = auditIndex({
    entries: [entry({
      ipfgl: 145,
      total: 410,
      isRankable: true,
      hasValidPowerliftingTotal: false,
      attempts: {
        squat: [{ weight: null, good: null }],
        bench: [{ weight: 150, good: true }],
        deadlift: [{ weight: 260, good: true }],
      },
    })],
  });
  const types = findingTypes(report);
  assert.ok(types.includes('powerlifting_missing_attempts'));
  assert.ok(types.includes('rankable_invalid_powerlifting_total'));
  assert.ok(types.includes('ipfgl_very_high'));
});

test('looksLikeClubAthleteName no marca nombres reales con capitalización normal o puntos', () => {
  const athleteNames = [
    'Abad Costa. Adrian',
    'Aranda Sanchez Saul',
    'Garin Martin Cristian',
    'Albers Galindo Elisa',
  ];

  for (const athleteName of athleteNames) {
    assert.equal(looksLikeClubAthleteName(athleteName), false, athleteName);
  }
});

test('looksLikeClubAthleteName no marca nombres reales aunque estén en mayúsculas', () => {
  const athleteNames = [
    'ABAD COSTA. ADRIAN',
    'ARANDA SANCHEZ SAUL',
    'GARIN MARTIN CRISTIAN',
    'ALBERS GALINDO ELISA',
  ];

  for (const athleteName of athleteNames) {
    assert.equal(looksLikeClubAthleteName(athleteName), false, athleteName);
  }
});

test('club/equipo como athleteName se detecta', () => {
  const clubNames = [
    '720 POWERLIFTING Ourense',
    '84 POWERLIFTING TEAM Malaga',
    'POWERLIFTING OURENSE',
    'SPARTA',
    'IRONSIDE',
    'SOY POWERLIFTER',
  ];

  for (const clubName of clubNames) {
    assert.equal(looksLikeClubAthleteName(clubName), true, clubName);
  }

  const report = auditIndex({ entries: [entry({ athleteName: 'IRONSIDE STRENGTH Madrid' })] });
  const finding = report.findings.find((item) => item.type === 'club_as_athlete');
  assert.ok(finding);
  assert.equal(finding.severity, 'error');
});

test('duplicado aproximado se detecta', () => {
  const base = entry({ rowKey: 'a' });
  const duplicate = entry({ rowKey: 'b', resultsUrl: 'https://example.com/other.pdf' });
  const report = auditIndex({ entries: [base, duplicate] });
  const finding = report.findings.find((item) => item.type === 'possible_duplicate');
  assert.ok(finding);
  assert.deepEqual(finding.value, ['a', 'b']);
});

test('Aranda regression helper reconoce el caso correcto', () => {
  const aranda = entry({
    athleteName: 'Aranda Sanchez Saul',
    athleteNameNormalized: 'aranda sanchez saul',
    competitionName: 'AEP 1 Campeonato de España Sub Junior Humilladero Malaga 2026',
    competitionYear: 2026,
    category: '-93kg',
    total: 660,
    ipfgl: 86.92,
  });
  const regression = buildRegressionSection([aranda]);
  assert.equal(regression.athletes.find((item) => item.athleteName === 'Aranda Sanchez Saul').count, 1);
  assert.equal(regression.aranda.has2026Result, true);
  assert.deepEqual(regression.aranda.checks, {
    competitionContainsSubJuniorOrHumilladero: true,
    categoryIs93: true,
    totalIs660: true,
    ipfglIsApprox8692: true,
  });
});

test('categorías ligeras Junior/Subjunior F -43kg y M -53kg son válidas con peso compatible', () => {
  assert.equal(expectedCategoryForBodyweight('F', 42.6), '-43kg');
  assert.equal(expectedCategoryForBodyweight('M', 51.38), '-53kg');

  const report = auditIndex({
    entries: [
      entry({
        athleteName: 'Albers Galindo Elisa',
        athleteNameNormalized: 'albers galindo elisa',
        sex: 'F',
        category: '-43kg',
        bodyweight: 42.6,
        competitionName: 'Campeonato de España JÚNIOR',
      }),
      entry({
        athleteName: 'Cartagena Gonzalez Joaquin',
        athleteNameNormalized: 'cartagena gonzalez joaquin',
        sex: 'M',
        category: '-53kg',
        bodyweight: 51.38,
        competitionName: 'Campeonato de España JÚNIOR',
      }),
    ],
  });

  const types = findingTypes(report);
  assert.equal(types.includes('category_invalid'), false);
  assert.equal(types.includes('category_bodyweight_mismatch'), false);
});

test('categorías open F -47kg y M -59kg siguen calculándose correctamente', () => {
  assert.equal(expectedCategoryForBodyweight('F', 44.5), '-47kg');
  assert.equal(expectedCategoryForBodyweight('M', 58.9), '-59kg');

  const report = auditIndex({
    entries: [
      entry({ sex: 'F', category: '-47kg', bodyweight: 44.5, rowKey: 'f47' }),
      entry({ sex: 'M', category: '-59kg', bodyweight: 58.9, rowKey: 'm59' }),
    ],
  });

  const types = findingTypes(report);
  assert.equal(types.includes('category_invalid'), false);
  assert.equal(types.includes('category_bodyweight_mismatch'), false);
});

test('categorías realmente inválidas generan category_invalid', () => {
  const report = auditIndex({ entries: [entry({ sex: 'F', category: '-45kg', bodyweight: 44.5 })] });
  const finding = report.findings.find((item) => item.type === 'category_invalid');
  assert.ok(finding);
  assert.equal(finding.severity, 'error');
});
