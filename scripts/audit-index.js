#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { normalizeName, extractYear } = require('../scraper/utils');

const DEFAULT_INDEX_PATH = path.join(__dirname, '..', 'data', 'index.json');
const DEFAULT_REPORT_JSON_PATH = path.join(__dirname, '..', 'data', 'audit-report.json');
const DEFAULT_REPORT_MD_PATH = path.join(__dirname, '..', 'data', 'audit-report.md');
const CURRENT_YEAR = new Date().getUTCFullYear();
const EPSILON = 0.01;

const MEN_CLASSES = [53, 59, 66, 74, 83, 93, 105, 120, Infinity];
const WOMEN_CLASSES = [43, 47, 52, 57, 63, 69, 76, 84, Infinity];
const CLUB_WORDS = ['POWERLIFTING', 'BARBELL', 'STRENGTH', 'TEAM', 'CLUB', 'GYM', 'ACADEMY', 'CROSSFIT'];
const REGRESSION_ATHLETES = [
  'Aranda Sanchez Saul',
  'Pablo Martinez Cordova',
  'Garin Martin Cristian',
  'Brunno Vasquez',
  'Oliver Prudencio',
  'Almarche Martinez Lucia',
  'Borque Espinosa Antonio',
];

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(String(value).replace(',', '.'));
  return Number.isFinite(num) ? num : null;
}

function normalizedKey(value) {
  return normalizeName(value).replace(/\s+/g, ' ').trim();
}

function normalizeCategory(value) {
  const text = String(value || '').trim().replace(/\s+/g, '').toLowerCase();
  if (!text) return '';
  const match = text.match(/^([+-])\s*(\d+(?:[.,]\d+)?)\s*(?:kg)?$/i);
  if (!match) return text;
  return `${match[1]}${Number(match[2].replace(',', '.'))}kg`;
}

function expectedCategoryForBodyweight(sex, bodyweight) {
  const bw = toNumber(bodyweight);
  if (!bw || bw <= 0) return null;
  const classes = sex === 'F' ? WOMEN_CLASSES : sex === 'M' ? MEN_CLASSES : null;
  if (!classes) return null;
  const limit = classes.find((item) => bw <= item);
  if (limit === Infinity) return sex === 'F' ? '+84kg' : '+120kg';
  return `-${limit}kg`;
}

function isKnownCategoryForSex(sex, category) {
  const normalized = normalizeCategory(category);
  if (!normalized) return false;
  const valid = sex === 'F'
    ? ['-43kg', '-47kg', '-52kg', '-57kg', '-63kg', '-69kg', '-76kg', '-84kg', '+84kg']
    : sex === 'M'
      ? ['-53kg', '-59kg', '-66kg', '-74kg', '-83kg', '-93kg', '-105kg', '-120kg', '+120kg']
      : [];
  return valid.includes(normalized);
}

function hasTeamPointsFormula(value) {
  return /\[(?:\s*\d+\s*\+)+\s*\d+\s*\]/.test(String(value || ''));
}

function looksLikeClubAthleteName(name) {
  const raw = String(name || '').trim();
  if (!raw) return false;
  const upper = raw.toUpperCase();
  if (CLUB_WORDS.some((word) => upper.includes(word))) return true;
  if (/\b(SPARTA|IRONSIDE|SOY POWERLIFTER)\b/i.test(raw)) return true;
  const lettersOnly = raw.match(/\p{L}/gu)?.join('') || '';
  const upperLetters = raw.match(/\p{Lu}/gu)?.join('') || '';
  const tokens = raw.split(/\s+/).filter(Boolean);
  const allCaps = lettersOnly.length >= 8 && upperLetters.length === lettersOnly.length;
  const hasPersonStructure = tokens.length >= 2 && tokens.length <= 5 && tokens.every((token) => {
    const cleaned = token.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
    return /\p{L}{2,}/u.test(cleaned) && /^[\p{L}]+(?:[-'’][\p{L}]+)*$/u.test(cleaned);
  });
  return allCaps && !hasPersonStructure;
}

function getAttemptGroups(entry) {
  return {
    squat: Array.isArray(entry?.attempts?.squat) ? entry.attempts.squat : [],
    bench: Array.isArray(entry?.attempts?.bench) ? entry.attempts.bench : [],
    deadlift: Array.isArray(entry?.attempts?.deadlift) ? entry.attempts.deadlift : [],
  };
}

function validAttempt(attempt) {
  return attempt && attempt.good === true && toNumber(attempt.weight) !== null;
}

function bestAttempt(attempts) {
  return Math.max(0, ...attempts.filter(validAttempt).map((attempt) => toNumber(attempt.weight)));
}

function hasValidAttempt(entry, movement) {
  return getAttemptGroups(entry)[movement].some(validAttempt);
}

function computedPowerliftingTotal(entry) {
  const attempts = getAttemptGroups(entry);
  return bestAttempt(attempts.squat) + bestAttempt(attempts.bench) + bestAttempt(attempts.deadlift);
}

function computedSingleLiftTotal(entry) {
  const eventType = entry.eventType || entry.liftType || 'powerlifting';
  const attempts = getAttemptGroups(entry);
  if (!['squat', 'bench', 'deadlift'].includes(eventType)) return null;
  return bestAttempt(attempts[eventType]);
}

function hasValidPowerliftingTotalFromAttempts(entry) {
  return ['squat', 'bench', 'deadlift'].every((movement) => hasValidAttempt(entry, movement));
}

function flattenEntries(index) {
  if (Array.isArray(index)) return index.map((entry, index) => ({ ...entry, rowKey: entry.rowKey || `entry:${index}` }));
  if (Array.isArray(index?.entries)) return index.entries.map((entry, index) => ({ ...entry, rowKey: entry.rowKey || `entry:${index}` }));
  const rows = [];
  for (const athlete of index?.athletes || []) {
    for (const entry of athlete.entries || []) {
      rows.push({
        athleteName: entry.athleteName || athlete.athleteName,
        athleteNameNormalized: entry.athleteNameNormalized || athlete.athleteNameNormalized,
        ...entry,
        rowKey: entry.rowKey || `${athlete.athleteNameNormalized || normalizedKey(athlete.athleteName)}:${rows.length}`,
      });
    }
  }
  return rows;
}

function makeFinding(entry, severity, type, message, extras = {}) {
  return {
    severity,
    type,
    athleteName: entry?.athleteName || null,
    competitionName: entry?.competitionName || null,
    competitionYear: entry?.competitionYear ?? null,
    message,
    value: extras.value ?? null,
    expected: extras.expected ?? null,
    rowKey: entry?.rowKey || null,
  };
}

function auditCategory(entry) {
  const findings = [];
  const bw = toNumber(entry.bodyweight);
  const expected = expectedCategoryForBodyweight(entry.sex, bw);
  const category = normalizeCategory(entry.category);
  if (bw && entry.sex && !category) {
    findings.push(makeFinding(entry, 'warning', 'category_missing', 'Categoría vacía con peso corporal y sexo.', { value: entry.category, expected }));
    return findings;
  }
  if (category && entry.sex && !isKnownCategoryForSex(entry.sex, category)) {
    findings.push(makeFinding(entry, 'error', 'category_invalid', 'Categoría no reconocida para el sexo indicado.', { value: entry.category, expected }));
  }
  if (category && expected && category !== expected) {
    findings.push(makeFinding(entry, 'warning', 'category_bodyweight_mismatch', 'Categoría incompatible con el peso corporal.', { value: { bodyweight: bw, category: entry.category, sex: entry.sex }, expected }));
  }
  return findings;
}

function auditPowerliftingRankability(entry) {
  const findings = [];
  const eventType = entry.eventType || entry.liftType || 'powerlifting';
  if (eventType !== 'powerlifting') return findings;
  const total = toNumber(entry.total);
  const ipfgl = toNumber(entry.ipfgl);
  const hasAllAttempts = hasValidPowerliftingTotalFromAttempts(entry);
  if ((total > 0 || ipfgl > 0) && !hasAllAttempts) {
    findings.push(makeFinding(entry, 'warning', 'powerlifting_missing_attempts', 'Resultado de powerlifting con total/IPF GL pero sin intentos válidos en los tres movimientos.', { value: { total, ipfgl } }));
  }
  if (entry.isRankable === true && entry.hasValidPowerliftingTotal === false) {
    findings.push(makeFinding(entry, 'error', 'rankable_invalid_powerlifting_total', 'Resultado rankeable marcado con hasValidPowerliftingTotal=false.', { value: { isRankable: entry.isRankable, hasValidPowerliftingTotal: entry.hasValidPowerliftingTotal } }));
  }
  if (entry.hasValidPowerliftingTotal === true && !hasAllAttempts) {
    findings.push(makeFinding(entry, 'warning', 'valid_total_flag_missing_attempts', 'hasValidPowerliftingTotal=true pero faltan intentos válidos en algún movimiento.'));
  }
  return findings;
}

function auditIpfgl(entry) {
  const findings = [];
  const ipfgl = toNumber(entry.ipfgl);
  const total = toNumber(entry.total);
  const eventType = entry.eventType || entry.liftType || 'powerlifting';
  if (ipfgl === null) return findings;
  if (eventType === 'powerlifting' && entry.isIndividualResult !== false && ipfgl > 140) {
    findings.push(makeFinding(entry, 'warning', 'ipfgl_very_high', 'IPF GL muy alto en powerlifting individual; revisar si es real.', { value: ipfgl }));
  }
  if (entry.sex === 'F' && ipfgl > 120) {
    findings.push(makeFinding(entry, 'warning', 'ipfgl_female_high', 'IPF GL femenino por encima de 120; warning fuerte.', { value: ipfgl }));
  }
  if (ipfgl === 0 && total > 0) {
    findings.push(makeFinding(entry, 'warning', 'ipfgl_zero_with_total', 'IPF GL igual a 0 con total positivo.', { value: { ipfgl, total } }));
  }
  if (ipfgl > 80 && total > 0 && total < 200) {
    findings.push(makeFinding(entry, 'warning', 'ipfgl_high_low_total', 'IPF GL alto con total muy bajo.', { value: { ipfgl, total } }));
  }
  if (ipfgl > 0 && entry.isRankable === false) {
    findings.push(makeFinding(entry, 'warning', 'ipfgl_non_rankable', 'IPF GL numérico en resultado no rankeable.', { value: ipfgl }));
  }
  return findings;
}

function auditTotals(entry) {
  const findings = [];
  const total = toNumber(entry.total);
  const placing = toNumber(entry.placing);
  const eventType = entry.eventType || entry.liftType || 'powerlifting';
  if (total === 0 && placing !== null) {
    findings.push(makeFinding(entry, 'warning', 'total_zero_with_numeric_placing', 'Total 0 con puesto numérico.', { value: { total, placing: entry.placing } }));
  }
  if (total === null && entry.isRankable === true) {
    findings.push(makeFinding(entry, 'error', 'rankable_without_total', 'Resultado rankeable sin total.', { value: entry.total }));
  }
  if (total !== null && total > 0) {
    if (eventType === 'powerlifting' && hasValidPowerliftingTotalFromAttempts(entry)) {
      const computed = computedPowerliftingTotal(entry);
      if (Math.abs(total - computed) > EPSILON) {
        findings.push(makeFinding(entry, 'warning', 'total_attempt_sum_mismatch', 'El total no coincide con la suma de mejores intentos válidos.', { value: total, expected: computed }));
      }
    } else if (['squat', 'bench', 'deadlift'].includes(eventType)) {
      const computed = computedSingleLiftTotal(entry);
      if (computed !== null && computed > 0 && Math.abs(total - computed) > EPSILON) {
        findings.push(makeFinding(entry, 'warning', 'single_lift_total_mismatch', 'El total no coincide con el mejor intento válido del movimiento único.', { value: total, expected: computed }));
      }
    }
  }
  return findings;
}

function auditClubAthletes(entry) {
  const findings = [];
  if (looksLikeClubAthleteName(entry.athleteName)) {
    findings.push(makeFinding(entry, 'error', 'club_as_athlete', 'El nombre del atleta parece ser un club/equipo.', { value: entry.athleteName }));
  }
  if (hasTeamPointsFormula(entry.athleteName) || hasTeamPointsFormula(entry.club)) {
    findings.push(makeFinding(entry, 'error', 'team_points_formula_in_result', 'El atleta o club contiene una fórmula de puntuación por equipos.', { value: { athleteName: entry.athleteName, club: entry.club } }));
  }
  return findings;
}

function inferYearFromEntry(entry) {
  return extractYear([entry.competitionName, entry.resultsUrl, entry.meetPageUrl].filter(Boolean).join(' '));
}

function auditDates(entry, currentYear = CURRENT_YEAR) {
  const findings = [];
  const year = toNumber(entry.competitionYear);
  const dateYear = String(entry.competitionDate || '').match(/^(\d{4})-/)?.[1];
  if (!entry.competitionDate && !entry.competitionYear) {
    findings.push(makeFinding(entry, 'warning', 'date_and_year_missing', 'competitionDate y competitionYear están vacíos.'));
  }
  if (year !== null && (year < 2010 || year > currentYear + 1)) {
    findings.push(makeFinding(entry, 'warning', 'competition_year_out_of_range', 'competitionYear fuera de rango razonable.', { value: year, expected: `2010-${currentYear + 1}` }));
  }
  if (dateYear && year !== null && Number(dateYear) !== year) {
    findings.push(makeFinding(entry, 'warning', 'date_year_mismatch', 'competitionDate no coincide con competitionYear.', { value: entry.competitionDate, expected: year }));
  }
  const inferred = inferYearFromEntry(entry);
  if (!year && inferred) {
    findings.push(makeFinding(entry, 'info', 'competition_year_inferable', 'competitionYear ausente pero parece inferible desde nombre o URLs.', { value: null, expected: inferred }));
  }
  return findings;
}

function approximateDuplicateKey(entry) {
  const bw = toNumber(entry.bodyweight);
  const roundedBw = bw === null ? '' : Math.round(bw * 2) / 2;
  const total = toNumber(entry.total);
  return [
    normalizedKey(entry.athleteNameNormalized || entry.athleteName),
    normalizedKey(entry.competitionName),
    entry.competitionYear || '',
    entry.eventType || entry.liftType || 'powerlifting',
    total === null ? '' : total.toFixed(2),
    roundedBw,
  ].join('|');
}

function auditDuplicates(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = approximateDuplicateKey(entry);
    if (!key.startsWith('|')) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    }
  }
  const findings = [];
  for (const [key, group] of groups) {
    if (group.length > 1) {
      findings.push(makeFinding(group[0], 'warning', 'possible_duplicate', 'Posible resultado duplicado por clave aproximada.', {
        value: group.map((entry) => entry.rowKey),
        expected: key,
      }));
    }
  }
  return findings;
}

function auditAttempts(entry) {
  const findings = [];
  const eventType = entry.eventType || entry.liftType || 'powerlifting';
  const groups = getAttemptGroups(entry);
  for (const [movement, attempts] of Object.entries(groups)) {
    for (const attempt of attempts) {
      const weight = toNumber(attempt?.weight);
      if (weight === null) continue;
      if (weight <= 0) findings.push(makeFinding(entry, 'warning', 'attempt_non_positive', `Intento ${movement} con peso <= 0.`, { value: attempt }));
      if (weight > 500) findings.push(makeFinding(entry, 'warning', 'attempt_extremely_high', `Intento ${movement} extremadamente alto.`, { value: attempt }));
      if (weight > 50 && weight < 170 && !Number.isInteger(weight * 2) && (Math.abs(weight - toNumber(entry.ipfgl)) < 0.01 || Math.abs(weight - toNumber(entry.bodyweight)) < 0.01)) {
        findings.push(makeFinding(entry, 'warning', 'attempt_suspicious_decimal', `Intento ${movement} parece IPF GL o peso corporal.`, { value: attempt }));
      }
    }
  }
  if ((toNumber(entry.total) > 0 || toNumber(entry.placing) !== null) && Object.values(groups).every((attempts) => attempts.length === 0 || attempts.every((attempt) => toNumber(attempt?.weight) === null))) {
    findings.push(makeFinding(entry, 'warning', 'all_attempts_empty_with_total_or_ranking', 'Todos los intentos están vacíos pero hay total o ranking.', { value: { total: entry.total, placing: entry.placing } }));
  }
  if (['squat', 'bench', 'deadlift'].includes(eventType)) {
    for (const [movement, attempts] of Object.entries(groups)) {
      if (movement !== eventType && attempts.some((attempt) => toNumber(attempt?.weight) !== null)) {
        findings.push(makeFinding(entry, 'warning', 'single_lift_wrong_movement_attempts', `Resultado de ${eventType} con intentos en ${movement}.`, { value: attempts }));
      }
    }
  }
  return findings;
}

function auditLinks(entry) {
  const findings = [];
  if (!entry.meetPageUrl) findings.push(makeFinding(entry, 'warning', 'meet_page_url_missing', 'meetPageUrl ausente.'));
  if (!entry.resultsUrl) findings.push(makeFinding(entry, 'warning', 'results_url_missing', 'resultsUrl ausente.'));
  for (const field of ['meetPageUrl', 'resultsUrl']) {
    const value = entry[field];
    if (value && !/^https?:\/\//i.test(value)) {
      findings.push(makeFinding(entry, 'warning', `${field}_non_http`, `${field} no usa http/https.`, { value }));
    }
  }
  if (entry.resultsUrl && /(club|juez|jueces|cuadrante|horario|inscrip|cartel|guia|normativa)/i.test(entry.resultsUrl)) {
    findings.push(makeFinding(entry, 'warning', 'results_url_suspicious_document', 'resultsUrl parece apuntar a documento que no es de resultados.', { value: entry.resultsUrl }));
  }
  return findings;
}

function buildRegressionSection(entries) {
  const byName = new Map();
  for (const entry of entries) {
    const key = normalizedKey(entry.athleteNameNormalized || entry.athleteName);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(entry);
  }
  const athletes = REGRESSION_ATHLETES.map((name) => {
    const matches = byName.get(normalizedKey(name)) || [];
    return { athleteName: name, count: matches.length };
  });
  const arandaEntries = byName.get(normalizedKey('Aranda Sanchez Saul')) || [];
  const aranda2026 = arandaEntries.find((entry) => Number(entry.competitionYear) === 2026);
  return {
    athletes,
    aranda: {
      found: arandaEntries.length > 0,
      has2026Result: Boolean(aranda2026),
      checks: aranda2026 ? {
        competitionContainsSubJuniorOrHumilladero: /sub\s*junior|subjunior|humilladero/i.test(aranda2026.competitionName || ''),
        categoryIs93: normalizeCategory(aranda2026.category) === '-93kg',
        totalIs660: Math.abs((toNumber(aranda2026.total) || 0) - 660) <= EPSILON,
        ipfglIsApprox8692: Math.abs((toNumber(aranda2026.ipfgl) || 0) - 86.92) <= EPSILON,
      } : {},
    },
  };
}

function auditIndex(index, options = {}) {
  const entries = flattenEntries(index);
  const findings = [];
  for (const entry of entries) {
    findings.push(
      ...auditCategory(entry),
      ...auditPowerliftingRankability(entry),
      ...auditIpfgl(entry),
      ...auditTotals(entry),
      ...auditClubAthletes(entry),
      ...auditDates(entry, options.currentYear || CURRENT_YEAR),
      ...auditAttempts(entry),
      ...auditLinks(entry)
    );
  }
  findings.push(...auditDuplicates(entries));

  const athletes = new Set(entries.map((entry) => normalizedKey(entry.athleteNameNormalized || entry.athleteName)).filter(Boolean));
  const byType = {};
  for (const finding of findings) {
    byType[finding.type] ||= { info: 0, warning: 0, error: 0, total: 0 };
    byType[finding.type][finding.severity] += 1;
    byType[finding.type].total += 1;
  }
  return {
    generatedAt: new Date().toISOString(),
    summary: {
      totalResults: entries.length,
      totalAthletes: athletes.size,
      totalFindings: findings.length,
      info: findings.filter((finding) => finding.severity === 'info').length,
      warnings: findings.filter((finding) => finding.severity === 'warning').length,
      errors: findings.filter((finding) => finding.severity === 'error').length,
      byType,
    },
    regression: buildRegressionSection(entries),
    findings,
  };
}

function severityRank(severity) {
  return severity === 'error' ? 3 : severity === 'warning' ? 2 : 1;
}

function topFindings(findings, limit = 20) {
  return [...findings]
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || String(a.type).localeCompare(String(b.type)))
    .slice(0, limit);
}

function renderMarkdown(report) {
  const lines = [];
  lines.push('# Auditoría de data/index.json', '');
  lines.push(`Generado: ${report.generatedAt}`, '');
  lines.push('## Resumen', '');
  lines.push(`- Resultados: ${report.summary.totalResults}`);
  lines.push(`- Atletas: ${report.summary.totalAthletes}`);
  lines.push(`- Hallazgos: ${report.summary.totalFindings}`);
  lines.push(`- Info: ${report.summary.info}`);
  lines.push(`- Warnings: ${report.summary.warnings}`);
  lines.push(`- Errores críticos: ${report.summary.errors}`, '');
  lines.push('## Hallazgos por tipo', '');
  lines.push('| Tipo | Info | Warnings | Errores | Total |');
  lines.push('| --- | ---: | ---: | ---: | ---: |');
  for (const [type, counts] of Object.entries(report.summary.byType).sort((a, b) => b[1].total - a[1].total)) {
    lines.push(`| ${type} | ${counts.info} | ${counts.warning} | ${counts.error} | ${counts.total} |`);
  }
  lines.push('', '## Atletas de regresión', '');
  for (const athlete of report.regression.athletes) lines.push(`- ${athlete.athleteName}: ${athlete.count}`);
  lines.push(`- Aranda 2026 encontrado: ${report.regression.aranda.has2026Result ? 'sí' : 'no'}`);
  for (const [check, ok] of Object.entries(report.regression.aranda.checks || {})) lines.push(`  - ${check}: ${ok ? 'OK' : 'REVISAR'}`);
  lines.push('', '## Top 20 problemas', '');
  for (const finding of topFindings(report.findings)) {
    lines.push(`- **${finding.severity.toUpperCase()}** ${finding.type}: ${finding.message} (${finding.athleteName || 'sin atleta'} · ${finding.competitionName || 'sin competición'} · ${finding.rowKey || 'sin rowKey'})`);
  }
  return `${lines.join('\n')}\n`;
}

function printSummary(report) {
  console.log('Auditoría de data/index.json');
  console.log(`Resultados: ${report.summary.totalResults}`);
  console.log(`Atletas: ${report.summary.totalAthletes}`);
  console.log(`Hallazgos: ${report.summary.totalFindings} (${report.summary.errors} errores, ${report.summary.warnings} warnings, ${report.summary.info} info)`);
  console.log('\nTop 20 problemas:');
  for (const finding of topFindings(report.findings)) {
    console.log(`- [${finding.severity}] ${finding.type}: ${finding.message} :: ${finding.athleteName || 'sin atleta'} / ${finding.competitionName || 'sin competición'} / ${finding.rowKey || 'sin rowKey'}`);
  }
}

function parseArgs(argv) {
  return {
    strict: argv.includes('--strict'),
    indexPath: argv.find((arg) => arg.startsWith('--index='))?.slice('--index='.length) || DEFAULT_INDEX_PATH,
    jsonPath: argv.find((arg) => arg.startsWith('--json='))?.slice('--json='.length) || DEFAULT_REPORT_JSON_PATH,
    mdPath: argv.find((arg) => arg.startsWith('--md='))?.slice('--md='.length) || DEFAULT_REPORT_MD_PATH,
  };
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (!fs.existsSync(options.indexPath)) {
    console.warn(`No existe ${path.relative(process.cwd(), options.indexPath)}; no se genera informe.`);
    return 0;
  }
  const index = JSON.parse(fs.readFileSync(options.indexPath, 'utf8'));
  const report = auditIndex(index);
  fs.mkdirSync(path.dirname(options.jsonPath), { recursive: true });
  fs.writeFileSync(options.jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(options.mdPath, renderMarkdown(report));
  printSummary(report);
  console.log(`\nInforme JSON: ${path.relative(process.cwd(), options.jsonPath)}`);
  console.log(`Informe Markdown: ${path.relative(process.cwd(), options.mdPath)}`);
  return options.strict && report.summary.errors > 0 ? 1 : 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  auditIndex,
  expectedCategoryForBodyweight,
  hasValidPowerliftingTotalFromAttempts,
  looksLikeClubAthleteName,
  approximateDuplicateKey,
  buildRegressionSection,
  normalizeCategory,
  flattenEntries,
};
