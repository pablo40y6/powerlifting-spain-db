const aepRanking = (() => {
  const DAY = 86400000;
  const MOVEMENTS = ['squat', 'bench', 'deadlift'];

  function todayInSpain(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now);
    const date = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    return `${date.year}-${date.month}-${date.day}`;
  }

  function dayValue(iso) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return NaN;
    const ms = Date.parse(`${iso}T00:00:00Z`);
    return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === iso ? ms : NaN;
  }

  function expiresOn(iso) {
    if (!Number.isFinite(dayValue(iso))) return null;
    const [year, month, day] = iso.split('-').map(Number);
    const targetMonth = month - 1 + 18;
    const last = new Date(Date.UTC(year, targetMonth + 1, 0)).getUTCDate();
    return new Date(Date.UTC(year, targetMonth, Math.min(day, last))).toISOString().slice(0, 10);
  }

  function bestMovement(row, movement) {
    if (!MOVEMENTS.includes(movement)) return null;
    const published = row.bestLifts?.[movement];
    if (Number.isFinite(published) && published > 0) return published;
    const weights = (row.attempts?.[movement] || []).filter((attempt) => attempt?.good === true && Number.isFinite(attempt.weight));
    return Math.max(0, ...weights.map(({ weight }) => weight)) || null;
  }

  function metricValue(row, metric) {
    const event = row.eventType || row.liftType || 'powerlifting';
    if (event !== 'powerlifting' && !(metric === 'bench' && event === 'bench')) return null;
    return metric === 'total' || metric === 'ipfgl' ? row[metric] : bestMovement(row, metric);
  }

  function topRanking(rows, { sex, category, equipment, metric = 'total', today = todayInSpain() }) {
    const bestByAthlete = new Map();
    const now = dayValue(today);
    for (const row of rows) {
      if (row.sex !== sex || row.category !== category || row.equipment !== equipment ||
          row.isRankable !== true || row.isIndividualResult === false || row.sourceReview ||
          /^AI\*?$/i.test(row.placing || '') || (row.country && row.country !== 'ESP')) continue;
      const competition = dayValue(row.competitionDate);
      const expiration = expiresOn(row.competitionDate);
      const daysRemaining = (dayValue(expiration) - now) / DAY;
      if (!Number.isFinite(now) || !Number.isFinite(daysRemaining) || daysRemaining < 0 || competition > now) continue;
      const value = metricValue(row, metric);
      const athleteKey = row.rankingAthleteId || row.athleteId || row.athleteNameNormalized;
      if (!athleteKey || !Number.isFinite(value) || value <= 0) continue;
      const item = { row, value, expiration, daysRemaining };
      const previous = bestByAthlete.get(athleteKey);
      if (!previous || value > previous.value ||
          (value === previous.value && expiration > previous.expiration) ||
          (value === previous.value && expiration === previous.expiration && row.bodyweight < previous.row.bodyweight)) {
        bestByAthlete.set(athleteKey, item);
      }
    }
    return Array.from(bestByAthlete.values()).sort((a, b) => b.value - a.value ||
      (a.row.bodyweight ?? Infinity) - (b.row.bodyweight ?? Infinity) ||
      a.row.athleteName.localeCompare(b.row.athleteName, 'es')).slice(0, 50);
  }

  return { todayInSpain, expiresOn, topRanking, bestMovement };
})();

if (typeof module !== 'undefined') module.exports = aepRanking;
