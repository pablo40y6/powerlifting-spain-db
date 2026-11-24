const state = {
  index: null,
  rows: [],
  filtered: [],
  clubs: new Map(),
};

const $ = (id) => document.getElementById(id);
const controls = {
  athlete: $('athleteFilter'),
  club: $('clubFilter'),
  category: $('categoryFilter'),
  sex: $('sexFilter'),
  year: $('yearFilter'),
  competition: $('competitionFilter'),
  eventType: $('eventTypeFilter'),
  sort: $('sortSelect'),
};

const rankingControls = {
  sex: $('rankingSex'),
  category: $('rankingCategory'),
  equipment: $('rankingEquipment'),
  metric: $('rankingMetric'),
};
const rankingCategories = {
  F: ['-43kg', '-47kg', '-52kg', '-57kg', '-63kg', '-69kg', '-76kg', '-84kg', '+84kg'],
  M: ['-53kg', '-59kg', '-66kg', '-74kg', '-83kg', '-93kg', '-105kg', '-120kg', '+120kg'],
};

function hydrateRankingCategories() {
  const select = rankingControls.category;
  select.replaceChildren();
  for (const category of rankingCategories[rankingControls.sex.value]) {
    const option = document.createElement('option');
    option.value = category;
    option.textContent = category;
    select.appendChild(option);
  }
  select.value = rankingControls.sex.value === 'F' ? '-57kg' : '-83kg';
}

function rankingCell(row, text, className) {
  const cell = document.createElement('td');
  cell.textContent = text;
  if (className) cell.className = className;
  row.appendChild(cell);
  return cell;
}

function renderRanking() {
  if (!state.index || $('rankingView').hidden) return;
  const options = Object.fromEntries(Object.entries(rankingControls).map(([key, control]) => [key, control.value]));
  const ranked = aepRanking.topRanking(state.rows, options);
  const body = $('rankingBody');
  body.replaceChildren();
  $('rankingSummary').textContent = ranked.length
    ? `${ranked.length} ${ranked.length === 1 ? 'atleta' : 'atletas'} · ${options.category}`
    : 'Sin marcas vigentes para estos filtros.';
  const points = options.metric === 'ipfgl';
  for (const [index, { row, value, expiration, daysRemaining }] of ranked.entries()) {
    const tr = document.createElement('tr');
    rankingCell(tr, String(index + 1), 'numeric');
    const nameCell = rankingCell(tr, '');
    const athlete = document.createElement('button');
    athlete.type = 'button';
    athlete.className = 'link-button';
    athlete.dataset.athlete = row.athleteId;
    if (row.rankingAthleteId) athlete.dataset.rankingAthlete = row.rankingAthleteId;
    athlete.textContent = row.athleteName;
    nameCell.appendChild(athlete);
    if (clubName(row)) {
      const club = document.createElement('small');
      club.className = 'ranking-context muted';
      club.textContent = clubName(row);
      nameCell.appendChild(club);
    }
    rankingCell(tr, `${formatNumber(value, points ? 3 : 2)} ${points ? 'GL' : 'kg'}`, 'numeric');
    const dateCell = rankingCell(tr, formatDate(row.competitionDate, row.competitionYear));
    if (row.competitionDateApproximate) {
      const dateBasis = document.createElement('small');
      dateBasis.className = 'ranking-context muted';
      dateBasis.textContent = 'Inicio del campeonato';
      dateCell.appendChild(dateBasis);
    }
    const meet = rankingCell(tr, row.competitionName);
    const context = document.createElement('small');
    context.className = 'ranking-context muted';
    context.textContent = `${row.sourceFederation || 'AEP'} · ${eventTypeLabel(eventTypeFromRow(row))}`;
    meet.appendChild(context);
    if (row.resultsUrl) meet.insertAdjacentHTML('beforeend', link(row.resultsUrl, 'Acta'));
    const expiry = rankingCell(tr, daysRemaining === 0 ? 'Último día' : `${daysRemaining} ${daysRemaining === 1 ? 'día' : 'días'}`, 'ranking-expiry');
    const date = document.createElement('small');
    date.className = 'ranking-context';
    date.textContent = formatDate(expiration);
    expiry.appendChild(date);
    body.appendChild(tr);
  }
}

function switchView() {
  const views = { '#buscador': 'searchView', '#ranking': 'rankingView', '#clubes': 'clubsView' };
  const selected = views[location.hash] || 'searchView';
  for (const id of Object.values(views)) {
    $(id).hidden = id !== selected;
    const tab = $(id + 'Link');
    if (id === selected) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  renderRanking();
  renderClubs();
}

function clubName(row) {
  return state.clubs.get(row.clubId)?.name || row.club || '';
}

function renderClubs() {
  if (!state.index || $('clubsView').hidden) return;
  const { clubs = [], unresolved = [] } = state.index.clubCatalog || {};
  const query = normalize($('clubsSearch').value);
  const filter = $('clubsStatus').value;
  const matching = [...clubs.map((club) => ({ ...club, status: club.active ? 'active' : 'history' })),
    ...unresolved.map((club) => ({ ...club, status: 'pending' }))].filter((club) => {
    const keywords = [club.name, club.registered, club.region, ...(club.aliases || [])].filter(Boolean).join(' ');
    return (!filter || club.status === filter) && (!query || allTokensPresent(query, keywords) ||
      normalize(keywords).replace(/ /g, '').includes(query.replace(/ /g, '')));
  });
  $('clubsSummary').textContent = clubs.length.toLocaleString('es-ES') + ' clubes identificados · ' +
    unresolved.length.toLocaleString('es-ES') + ' nombres pendientes · ' + matching.length.toLocaleString('es-ES') + ' en la vista';
  const body = $('clubsBody');
  body.replaceChildren();
  for (const club of matching) {
    const row = document.createElement('tr');
    const name = rankingCell(row, club.name);
    const status = document.createElement('small');
    status.className = 'ranking-context muted';
    status.textContent = { active: 'Listado vigente AEP', history: 'Fuente histórica AEP', pending: 'Nombre pendiente de contrastar' }[club.status];
    name.appendChild(status);
    if (club.registered && normalize(club.registered) !== normalize(club.name)) {
      const official = document.createElement('small');
      official.className = 'ranking-context';
      official.textContent = club.registered;
      name.appendChild(official);
    }
    rankingCell(row, (club.aliases || []).filter((alias) => normalize(alias) !== normalize(club.name)).join(' · ') || '—');
    rankingCell(row, uniqueSorted([club.region, club.city]).join(' · ') || '—');
    const count = rankingCell(row, club.count.toLocaleString('es-ES'));
    if (club.firstYear) {
      const years = document.createElement('small');
      years.className = 'ranking-context muted';
      years.textContent = club.firstYear === club.lastYear ? club.firstYear : club.firstYear + '–' + club.lastYear;
      count.appendChild(years);
    }
    const source = rankingCell(row, '');
    source.innerHTML = (club.sources || [{ url: club.source }]).slice(0, 3).map((item) =>
      link(item.url, item.year ? 'AEP ' + item.year : 'Acta')).join(' ');
    body.appendChild(row);
  }
}

function normalize(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9ñü\s-]/gi, ' ').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokens(value) {
  return normalize(value).split(' ').filter(Boolean);
}

function allTokensPresent(query, target) {
  const queryTokens = tokens(query).filter((token) => token.length > 1);
  if (!queryTokens.length) return true;
  const targetTokens = tokens(target);
  return queryTokens.every((token) =>
    targetTokens.some((targetToken) => targetToken.startsWith(token))
  );
}

function formatNumber(value, digits = 1) {
  if (value === null || value === undefined || value === '') return '—';
  return Number(value).toLocaleString('es-ES', { maximumFractionDigits: digits });
}

function formatDate(value, year) {
  if (!value) return year ? String(year) : '—';
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('es-ES', { year: 'numeric', month: 'short', day: '2-digit', timeZone: 'UTC' });
}

function yearFromRow(row) {
  return row.competitionYear ? String(row.competitionYear) : (row.competitionDate ? row.competitionDate.slice(0, 4) : '');
}

function eventTypeFromRow(row) {
  return row.eventType || row.liftType || 'powerlifting';
}

function eventTypeLabel(value) {
  return {
    powerlifting: 'Powerlifting completo',
    bench: 'Press banca',
    deadlift: 'Peso muerto',
    squat: 'Sentadilla',
    other: 'Otra',
    mixed: 'Mixta',
  }[value || 'powerlifting'] || value || 'Powerlifting completo';
}

function flattenIndex(index) {
  return (index.athletes || []).flatMap((athlete) =>
    (athlete.entries || []).map((entry) => ({
      ...entry,
      athleteName: entry.athleteName || athlete.athleteName,
      athleteNameNormalized: entry.athleteNameNormalized || athlete.athleteNameNormalized,
      athleteId: athlete.athleteId || athlete.athleteNameNormalized,
    }))
  );
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), 'es', { numeric: true }));
}

function populateSelect(select, values) {
  const first = select.querySelector('option[value=""]')?.textContent || 'Todos';
  select.innerHTML = `<option value="">${first}</option>`;
  for (const value of values) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  }
}

function hydrateFilters() {
  populateSelect(controls.category, uniqueSorted(state.rows.map((row) => row.category)));
  populateSelect(controls.year, uniqueSorted(state.rows.map(yearFromRow)).sort((a, b) => b.localeCompare(a)));
}

function matches(row) {
  if (row.isIndividualResult === false || row.isRankable === false || (row.country && row.country !== 'ESP')) return false;

  const athlete = normalize(controls.athlete.value);
  const club = normalize(controls.club.value);
  const competition = normalize(controls.competition.value);
  const category = controls.category.value;
  const sex = controls.sex.value;
  const year = controls.year.value;
  const eventType = controls.eventType.value;

  return (!athlete || allTokensPresent(athlete, row.athleteName)) &&
    (!club || [row.club, clubName(row), ...(state.clubs.get(row.clubId)?.aliases || [])].some((name) => normalize(name).includes(club))) &&
    (!competition || normalize(row.competitionName).includes(competition)) &&
    (!category || row.category === category) &&
    (!sex || row.sex === sex) &&
    (!year || yearFromRow(row) === year) &&
    (!eventType || eventTypeFromRow(row) === eventType);
}

function compareRows(a, b) {
  switch (controls.sort.value) {
    case 'ipfgl-desc': return (b.ipfgl || 0) - (a.ipfgl || 0);
    case 'date-desc': return String(b.competitionDate || '').localeCompare(String(a.competitionDate || ''));
    case 'athlete-asc': return String(a.athleteName || '').localeCompare(String(b.athleteName || ''), 'es');
    case 'club-asc': return clubName(a).localeCompare(clubName(b), 'es');
    case 'total-desc':
    default: return (b.total || 0) - (a.total || 0);
  }
}

function link(url, label) {
  if (!url) return '';
  try { if (!['https:', 'http:'].includes(new URL(url).protocol)) return ''; }
  catch { return ''; }
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = label;
  return a.outerHTML;
}

function escapeHtml(value) {
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value ?? '').replace(/[&<>"']/g, (character) => entities[character]);
}

function renderTable() {
  const body = $('resultsBody');
  body.innerHTML = '';
  const rows = state.filtered.slice(0, 1000);
  $('resultCount').textContent = `${state.filtered.length.toLocaleString('es-ES')} resultados` + (state.filtered.length > rows.length ? ' (mostrando los primeros 1.000)' : '');

  if (!rows.length) {
    body.appendChild($('emptyTemplate').content.cloneNode(true));
    return;
  }

  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${formatDate(row.competitionDate, row.competitionYear)}</td>
      <td><button class="link-button" data-athlete="${escapeHtml(row.athleteId)}">${escapeHtml(row.athleteName || '—')}</button></td>
      <td>${escapeHtml(clubName(row) || '—')}</td>
      <td>${row.sex || '—'}</td>
      <td>${row.category || '—'}</td>
      <td class="numeric">${formatNumber(row.total)}</td>
      <td class="numeric">${formatNumber(row.ipfgl, 2)}</td>
      <td>${escapeHtml(row.competitionName || '—')}${row.sourceFederation ? ` <small class="muted">· ${escapeHtml(row.sourceFederation)}</small>` : ''}</td>
      <td>${eventTypeLabel(eventTypeFromRow(row))}</td>
      <td class="links-cell">${link(row.meetPageUrl, 'Competición')} ${link(row.resultsUrl, 'Resultados')}</td>
    `;
    body.appendChild(tr);
  }
}

function renderReviewedAthletes() {
  const query = normalize(controls.athlete.value);
  const reviewed = new Map(state.rows
    .filter((row) => row.sourceReview && (!query || allTokensPresent(query, row.athleteName)))
    .map((row) => [row.athleteId, row.athleteName]));
  $('reviewedResults').hidden = reviewed.size === 0;
  const list = $('reviewedAthletes');
  list.replaceChildren();
  for (const [id, name] of reviewed) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'link-button';
    button.dataset.athlete = id;
    button.textContent = name;
    item.appendChild(button);
    list.appendChild(item);
  }
}

function applyFilters() {
  state.filtered = state.rows.filter(matches).sort(compareRows);
  renderTable();
  renderReviewedAthletes();
}

function bestBy(rows, key) {
  return rows
    .filter((row) => row.isIndividualResult !== false && row.isRankable !== false)
    .reduce((best, row) => (Number(row[key] || 0) > Number(best?.[key] || 0) ? row : best), null);
}

function attemptText(attempt) {
  if (!attempt || attempt.weight === null || attempt.weight === undefined) return '<span class="attempt empty-attempt">—</span>';
  const cls = attempt.good === false ? 'bad-attempt' : attempt.good === true ? 'good-attempt' : 'unknown-attempt';
  const marker = attempt.good === false ? '✗' : attempt.good === true ? '✓' : '?';
  return `<span class="attempt ${cls}">${formatNumber(attempt.weight)} ${marker}</span>`;
}

function renderAttempts(entry) {
  const labels = entry.attempts?.__labels || { squat: 'Sentadilla', bench: 'Banca', deadlift: 'Peso muerto' };
  return ['squat', 'bench', 'deadlift'].map((lift) => `
    <tr><th>${escapeHtml(labels[lift] || lift)}</th><td>${(entry.attempts?.[lift] || []).some((attempt) => attempt?.weight != null)
      ? entry.attempts[lift].map(attemptText).join('')
      : Number.isFinite(entry.bestLifts?.[lift]) ? `Mejor válido · ${formatNumber(entry.bestLifts[lift], 2)} kg` : '—'}</td></tr>
  `).join('');
}

const sourceReviewMessages = {
  conflicting_total: 'El total del acta difiere de la suma de los mejores intentos válidos.',
  conflicting_category: 'El peso anotado supera el límite de la categoría del acta.',
  incomplete_total: 'El acta no acredita un intento válido en los tres movimientos.',
  unclassified_placing: 'El acta indica un puesto y un total de 0 kg.',
  disqualified_score: 'El acta indica descalificación y publica una puntuación.',
};

function renderSourceReview(review) {
  const reason = sourceReviewMessages[review?.reason];
  if (!reason || !review.published) return '';
  const { category, placing, total, ipfgl } = review.published;
  const publishedCategory = /^[+-]\d{2,3}kg$/.test(category) ? category : '—';
  const publishedPlacing = /^(?:\d+|AI|DQ|[-–—]+)$/.test(placing) ? placing : '—';
  return `
    <p class="muted"><strong>Fuera del ranking.</strong> ${reason}</p>
    <p class="muted"><strong>En el acta</strong> · Categoría ${publishedCategory} · Puesto ${publishedPlacing} · Total ${formatNumber(total)} kg · IPF GL ${formatNumber(ipfgl, 2)}${Number.isFinite(review.attemptSum) ? ` · Suma de intentos ${formatNumber(review.attemptSum)} kg` : ''}</p>
  `;
}

function showAthlete(athleteId, rankingAthleteId) {
  const rows = state.rows.filter((row) => rankingAthleteId
    ? row.rankingAthleteId === rankingAthleteId
    : row.athleteId === athleteId)
    .sort((a, b) => String(b.competitionDate || '').localeCompare(String(a.competitionDate || '')));
  if (!rows.length) return;
  const bestTotal = bestBy(rows, 'total');
  const bestGl = bestBy(rows, 'ipfgl');
  $('athleteDetail').innerHTML = `
    <h2>${escapeHtml(rows[0].athleteName)}</h2>
    <p class="muted">${escapeHtml(uniqueSorted(rows.map(clubName)).join(' · ') || 'Club no detectado')}</p>
    <div class="detail-stats">
      <div><span>Resultados</span><strong>${rows.length}</strong></div>
      <div><span>Mejor total</span><strong>${formatNumber(bestTotal?.total)} kg</strong></div>
      <div><span>Mejor IPF GL</span><strong>${formatNumber(bestGl?.ipfgl, 2)}</strong></div>
    </div>
    ${rows.map((row) => `
      <article class="detail-card">
        <h3>${escapeHtml(row.competitionName || 'Competición')}</h3>
        <p class="muted">${formatDate(row.competitionDate, row.competitionYear)} · ${eventTypeLabel(eventTypeFromRow(row))} · ${row.sex || '—'} · ${row.category || '—'} · ${escapeHtml(clubName(row) || '—')}</p>
        <table class="attempt-table"><tbody>${renderAttempts(row)}</tbody></table>
        ${row.sourceReview ? renderSourceReview(row.sourceReview) : row.isRankable === false ? '<p class="muted"><strong>No rankeable:</strong> resultado incompleto o no individual.</p>' : ''}
        <p><strong>Total:</strong> ${formatNumber(row.total)} kg · <strong>IPF GL:</strong> ${formatNumber(row.ipfgl, 2)}</p>
        ${Number.isFinite(row.historicalPoints) ? `<p class="muted">${escapeHtml(row.historicalPointsLabel || 'Puntos del acta')} · ${formatNumber(row.historicalPoints, 2)}</p>` : ''}
        ${row.countrySource && row.country === 'ESP' && row.countrySource !== row.resultsUrl ? `<p class="links-cell">${link(row.countrySource, 'Fuente que acredita a España')}</p>` : ''}
        <p class="links-cell">${row.meetPageUrl !== row.resultsUrl ? link(row.meetPageUrl, 'Página de competición') : ''} ${link(row.resultsUrl, 'Acta original')}
          ${(row.officialResultsUrls || []).filter((url) => url !== row.resultsUrl && url !== row.meetPageUrl).map((url, index) => link(url, `Acta federativa ${index + 1}`)).join(' ')}
        </p>
      </article>
    `).join('')}
  `;
  $('athleteDialog').showModal();
}

async function loadIndex() {
  const response = await fetch('data/index.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('No se pudo cargar data/index.json. Ejecuta npm run build:index y npm run build:web.');
  state.index = await response.json();
  state.rows = flattenIndex(state.index);
  state.clubs = new Map((state.index.clubCatalog?.clubs || []).map((club) => [club.id, club]));
  $('indexMeta').innerHTML = `<strong>${state.index.athleteCount?.toLocaleString('es-ES') || state.rows.length}</strong> atletas · <strong>${state.index.entryCount?.toLocaleString('es-ES') || state.rows.length}</strong> resultados<br><span>Actualizado: ${new Date(state.index.builtAt).toLocaleString('es-ES')}</span>`;
  const internationalCount = state.index.internationalEntryCount || 0;
  if (internationalCount) {
    const sources = document.createElement('small');
    sources.className = 'ranking-context';
    const missing = (state.index.warnings || []).some((warning) => warning.includes('archivo internacional'));
    sources.textContent = `${internationalCount.toLocaleString('es-ES')} resultados internacionales${missing ? ' · fuentes pendientes de actualización' : ''}`;
    $('indexMeta').appendChild(sources);
  }
  if (state.index.historicalEntryCount) {
    const archive = document.createElement('small');
    archive.className = 'ranking-context';
    archive.textContent = state.index.historicalEntryCount.toLocaleString('es-ES') + ' resultados anteriores a 2021';
    $('indexMeta').appendChild(archive);
  }
  hydrateFilters();
  applyFilters();
  renderRanking();
  renderClubs();
}

for (const id of ['clubsSearch', 'clubsStatus']) $(id).addEventListener('input', renderClubs);
for (const control of Object.values(controls)) control.addEventListener('input', applyFilters);
for (const control of Object.values(rankingControls)) control.addEventListener('change', () => {
  if (control === rankingControls.sex) hydrateRankingCategories();
  renderRanking();
});
hydrateRankingCategories();
window.addEventListener('hashchange', switchView);
switchView();
window.setInterval(renderRanking, 60000);
$('resetBtn').addEventListener('click', () => {
  for (const control of Object.values(controls)) control.value = '';
  controls.eventType.value = 'powerlifting';
  controls.sort.value = 'total-desc';
  applyFilters();
});
for (const id of ['resultsBody', 'reviewedAthletes', 'rankingBody']) {
  $(id).addEventListener('click', (event) => {
    const button = event.target.closest('[data-athlete]');
    if (button) showAthlete(button.dataset.athlete, button.dataset.rankingAthlete);
  });
}

loadIndex().catch((error) => {
  $('indexMeta').textContent = error.message;
  $('rankingSummary').textContent = 'No se han podido cargar los resultados.';
  $('resultsBody').appendChild($('emptyTemplate').content.cloneNode(true));
});
