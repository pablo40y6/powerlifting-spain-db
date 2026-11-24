// Filas contrastadas con las actas oficiales. Las comprobaciones usan los
// valores de origen para que una revisión de un acta vuelva a pasar por el
// importador y la auditoría normales.
const { normalizeName } = require('./utils');

const AEP_UPLOADS = 'https://powerliftingspain.es/wp-content/uploads/';
const RESULT_FIELDS = ['category', 'placing', 'total', 'ipfgl', 'isRankable'];

const decisions = {
  incomplete_total: {
    "alonso abalde henar": ["2023/03/Clasificacion_AEP-2_Ria_Ferrol_Regional_NorOeste-1_Ferrol_2023.xls", "powerlifting", 53.48, "-57kg", "—", 227.5, 0, false],
    "oyeghe blasco daniel": ["2024/11/Clasificacion_AEP-2_Praetorians-Cup_Montornes-Tarragona_2024-1.xls", "powerlifting", 104.02, "-105kg", "2", 750, 93, false],
    "ruiz perez david": ["2026/03/Resultados-AEP2-Young-Ambition-Cup-2.xls", "powerlifting", 71.92, "-74kg", "6", 200, 29.801, false],
  },
  conflicting_total: {
    "blasco aledo sandra": ["2024/06/Clasificaciones_AEP-2_Regional_Valencia_Chiva_2024.xls", "powerlifting", 67.66, "-69kg", "2", 350, 73.33, true, 345],
    "david garcia gomez": ["2022/04/Clasificacion_AEP-3_Entrena_Intenso_Rivas-Vaciamadrid_2022_mas.pdf", "powerlifting", 90.33, "-93kg", "5", 525, 69.67, true, 527.5],
    "norocel norocel bianca elena": ["2024/07/Clasificaciones_AEP-1_SUBJUNIOR_Gines_Sevilla_2024-07-30.xls", "powerlifting", 54.6, "-57kg", "10", 255, 61.84, true, 250],
    "perez chorda mariola corega": ["2024/11/Clasificacion_AEP-1_Copa_MASTERs_Chiva-Valencia_2024-1.xls", "powerlifting", 60.26, "-63kg", "1", 255, 57.48, true, 247.5],
  },
  unclassified_placing: {
    "diaz martin adrian": ["2026/11/Resultados-AEP2-IV-Campeonato-de-Canarias.pdf", "powerlifting", 103.7, "-105kg", "3", 0, 0, false],
    "elba recalde unciti": ["2022/07/Clasificaciones_AEP-3_Powerlifting_Navarra_Mutilva_2022-07-06_fem.pdf", "powerlifting", 73.4, "-76kg", "2", 0, 0, false],
    "gonzalez marino angel": ["2023/03/Clasificacion_AEP-2_Ria_Ferrol_Regional_NorOeste-1_Ferrol_2023.xls", "bench", 73.64, "-74kg", "1", 0, 0, false],
    "juan garcia": ["2022/09/Clasificacion_AEP-3_Catalunya_Promeses_Esplugues_2021_mas.pdf", "powerlifting", 82.7, "-83kg", "5", 0, 0, false],
    "victor amoros fuentes": ["2022/06/Clasificaciones_AEP-3_Torneo_Social_ALFA_Madrid_2022-06-27.pdf", "powerlifting", 92.85, "-93kg", "1", 0, 0, false],
  },
  disqualified_score: {
    "garcia seller jose manuel": ["2025/02/Clasificacion_AEP-3_Fuerza-Isabel-Atlas_Chiva_2025.xls", "bench", 92.25, "-93kg", "DQ", 130, 61.84, false],
  },
  conflicting_category: {
    "valladolid velasques leire sofia": ["2024/03/Clasificaciones_AEP-2_Reino_Toledo_AEP-3_Berserkers_Viso-San-Juan_2024.xls", "powerlifting", 75, "-69kg", "6", 250, 49.6, true],
  },
};

// Indices: acta, modalidad, peso corporal, categoría, puesto, total, IPF GL,
// indicador de clasificación y, para totales discrepantes, suma verificada.
const reviewedRows = new Map();
for (const [reason, rows] of Object.entries(decisions)) {
  for (const [name, [file, eventType, bodyweight, category, placing, total, ipfgl, isRankable, attemptSum]] of Object.entries(rows)) {
    reviewedRows.set(`${AEP_UPLOADS}${file}#${name}`, {
      reason, eventType, bodyweight, category, placing, total, ipfgl, isRankable, attemptSum,
    });
  }
}

function bestPowerliftingAttempts(entry) {
  return ['squat', 'bench', 'deadlift'].map((movement) => Math.max(0, ...(entry.attempts?.[movement] || [])
    .filter((attempt) => attempt.good === true && Number.isFinite(attempt.weight))
    .map((attempt) => attempt.weight)));
}

function reviewResult(entry) {
  const resultsUrl = entry.resultsUrl || entry.competition?.resultsUrl;
  const decision = reviewedRows.get(`${resultsUrl}#${normalizeName(entry.athleteName)}`);
  if (!decision || decision.eventType !== entry.eventType || decision.bodyweight !== entry.bodyweight ||
      !RESULT_FIELDS.every((field) => decision[field] === entry[field])) return entry;

  if (decision.reason === 'conflicting_total' || decision.reason === 'incomplete_total') {
    const bestAttempts = bestPowerliftingAttempts(entry);
    if (decision.reason === 'conflicting_total' &&
        (!bestAttempts.every(Boolean) || bestAttempts.reduce((total, weight) => total + weight, 0) !== decision.attemptSum)) return entry;
    if (decision.reason === 'incomplete_total' && bestAttempts.every(Boolean)) return entry;
  }

  const sourceReview = {
    reason: decision.reason,
    published: Object.fromEntries(RESULT_FIELDS.map((field) => [field, entry[field]])),
    ...(decision.attemptSum !== undefined && { attemptSum: decision.attemptSum }),
  };

  if (decision.reason === 'unclassified_placing') return { ...entry, placing: null, sourceReview };
  if (decision.reason === 'disqualified_score') return { ...entry, total: null, ipfgl: null, sourceReview };
  return {
    ...entry,
    category: decision.reason === 'conflicting_category' ? null : entry.category,
    placing: null,
    total: null,
    ipfgl: null,
    isRankable: false,
    sourceReview,
  };
}

function validateSourceReview(entry) {
  const { published, reason, attemptSum } = entry.sourceReview || {};
  if (!published) return false;
  const replayed = reviewResult({ ...entry, ...Object.fromEntries(RESULT_FIELDS.map((field) => [field, published[field]])), sourceReview: null });
  return replayed.sourceReview?.reason === reason && replayed.sourceReview?.attemptSum === attemptSum &&
    RESULT_FIELDS.every((field) => replayed[field] === entry[field]);
}

module.exports = { reviewResult, validateSourceReview };
