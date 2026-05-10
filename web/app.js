const state = {
  index: null,
  rows: [],
  filtered: [],
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
  if (row.isIndividualResult === false || row.isRankable === false) return false;

  const athlete = normalize(controls.athlete.value);
  const club = normalize(controls.club.value);
  const competition = normalize(controls.competition.value);
  const category = controls.category.value;
  const sex = controls.sex.value;
  const year = controls.year.value;
  const eventType = controls.eventType.value;

  return (!athlete || allTokensPresent(athlete, row.athleteName)) &&
    (!club || normalize(row.club).includes(club)) &&
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
    case 'club-asc': return String(a.club || '').localeCompare(String(b.club || ''), 'es');
    case 'total-desc':
    default: return (b.total || 0) - (a.total || 0);
  }
}

function link(url, label) {
  if (!url) return '';
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = label;
  return a.outerHTML;
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
      <td><button class="link-button" data-athlete="${row.athleteNameNormalized}">${row.athleteName || '—'}</button></td>
      <td>${row.club || '—'}</td>
      <td>${row.sex || '—'}</td>
      <td>${row.category || '—'}</td>
      <td class="numeric">${formatNumber(row.total)}</td>
      <td class="numeric">${formatNumber(row.ipfgl, 2)}</td>
      <td>${row.competitionName || '—'}</td>
      <td>${eventTypeLabel(eventTypeFromRow(row))}</td>
      <td class="links-cell">${link(row.meetPageUrl, 'Competición')} ${link(row.resultsUrl, 'Resultados')}</td>
    `;
    body.appendChild(tr);
  }
}

function applyFilters() {
  state.filtered = state.rows.filter(matches).sort(compareRows);
  renderTable();
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
    <tr><th>${labels[lift] || lift}</th><td>${(entry.attempts?.[lift] || []).map(attemptText).join('')}</td></tr>
  `).join('');
}

function showAthlete(normalizedName) {
  const rows = state.rows.filter((row) => row.athleteNameNormalized === normalizedName)
    .sort((a, b) => String(b.competitionDate || '').localeCompare(String(a.competitionDate || '')));
  if (!rows.length) return;
  const bestTotal = bestBy(rows, 'total');
  const bestGl = bestBy(rows, 'ipfgl');
  $('athleteDetail').innerHTML = `
    <h2>${rows[0].athleteName}</h2>
    <p class="muted">${uniqueSorted(rows.map((row) => row.club)).join(' · ') || 'Club no detectado'}</p>
    <div class="detail-stats">
      <div><span>Resultados</span><strong>${rows.length}</strong></div>
      <div><span>Mejor total</span><strong>${formatNumber(bestTotal?.total)} kg</strong></div>
      <div><span>Mejor IPF GL</span><strong>${formatNumber(bestGl?.ipfgl, 2)}</strong></div>
    </div>
    ${rows.map((row) => `
      <article class="detail-card">
        <h3>${row.competitionName || 'Competición'}</h3>
        <p class="muted">${formatDate(row.competitionDate, row.competitionYear)} · ${eventTypeLabel(eventTypeFromRow(row))} · ${row.sex || '—'} · ${row.category || '—'} · ${row.club || '—'}</p>
        <table class="attempt-table"><tbody>${renderAttempts(row)}</tbody></table>
        ${row.isRankable === false ? '<p class="muted"><strong>No rankeable:</strong> resultado incompleto o no individual.</p>' : ''}
        <p><strong>Total:</strong> ${formatNumber(row.total)} kg · <strong>IPF GL:</strong> ${formatNumber(row.ipfgl, 2)}</p>
        <p class="links-cell">${link(row.meetPageUrl, 'Página de competición')} ${link(row.resultsUrl, 'Documento de resultados')}</p>
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
  $('indexMeta').innerHTML = `<strong>${state.index.athleteCount?.toLocaleString('es-ES') || state.rows.length}</strong> atletas · <strong>${state.index.entryCount?.toLocaleString('es-ES') || state.rows.length}</strong> resultados<br><span>Actualizado: ${new Date(state.index.builtAt).toLocaleString('es-ES')}</span>`;
  hydrateFilters();
  applyFilters();
}

for (const control of Object.values(controls)) control.addEventListener('input', applyFilters);
$('resetBtn').addEventListener('click', () => {
  for (const control of Object.values(controls)) control.value = '';
  controls.eventType.value = 'powerlifting';
  controls.sort.value = 'total-desc';
  applyFilters();
});
$('resultsBody').addEventListener('click', (event) => {
  const button = event.target.closest('[data-athlete]');
  if (button) showAthlete(button.dataset.athlete);
});

loadIndex().catch((error) => {
  $('indexMeta').textContent = error.message;
  $('resultsBody').appendChild($('emptyTemplate').content.cloneNode(true));
});
