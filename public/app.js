const reindexBtn = document.getElementById('reindexBtn');
const searchBtn = document.getElementById('searchBtn');
const nameInput = document.getElementById('nameInput');
const statusBadge = document.getElementById('statusBadge');
const statusText = document.getElementById('statusText');
const summaryBox = document.getElementById('summaryBox');
const progressWrap = document.getElementById('progressWrap');
const progressFill = document.getElementById('progressFill');
const progressLabel = document.getElementById('progressLabel');
const progressDetails = document.getElementById('progressDetails');
const messageBox = document.getElementById('messageBox');
const resultsBox = document.getElementById('results');

let pollTimer = null;

function setMessage(text, type = 'info') {
  messageBox.className = `card message-${type}`;
  messageBox.textContent = text;
  messageBox.classList.remove('hidden');
}

function clearMessage() {
  messageBox.classList.add('hidden');
  messageBox.textContent = '';
}

function formatAttempt(attempt) {
  if (!attempt || attempt.weight === null) return '—';
  return `${attempt.weight} kg ${attempt.good ? '✓' : '✗'}`;
}

function formatDate(dateText) {
  if (!dateText) return 'Fecha no detectada';
  return dateText;
}

function renderSummary(summary) {
  summaryBox.innerHTML = '';
  if (!summary) return;

  const items = [
    ['Última indexación', new Date(summary.builtAt).toLocaleString('es-ES')],
    ['Atletas indexados', summary.athleteCount],
    ['Resultados guardados', summary.entryCount],
    ['Páginas de competición', summary.competitionPagesIndexed],
    ['Documentos procesados', summary.documentsIndexed],
  ];

  for (const [label, value] of items) {
    const div = document.createElement('div');
    div.className = 'summary-item';
    div.innerHTML = `<span class="muted">${label}</span><strong>${value}</strong>`;
    summaryBox.appendChild(div);
  }
}

function formatIndexPhase(phase) {
  const labels = {
    'seed-pages': 'Leyendo páginas por año',
    'competition-pages': 'Descubriendo competiciones',
    documents: 'Procesando PDFs y Excel',
    done: 'Completado',
    ready: 'Listo',
    starting: 'Arrancando',
    idle: 'Sin índice',
  };
  return labels[phase] || phase || 'Indexando';
}

function updateProgressBar(buildState) {
  if (!progressWrap || !progressFill || !progressLabel || !progressDetails) return;

  if (!buildState.running) {
    progressWrap.classList.add('hidden');
    progressFill.style.width = '0%';
    progressLabel.textContent = '0%';
    progressDetails.textContent = '';
    return;
  }

  const progress = buildState.progress || {};
  const percent = Math.max(0, Math.min(100, Number(progress.percent || 0)));
  progressWrap.classList.remove('hidden');
  progressFill.style.width = `${percent}%`;
  progressLabel.textContent = `${Math.round(percent)}%`;

  const detailParts = [];
  if (progress.seedPages) detailParts.push(`Años ${progress.processedSeedPages}/${progress.seedPages}`);
  if (progress.competitionPages) detailParts.push(`Competiciones ${progress.processedCompetitionPages}/${progress.competitionPages}`);
  if (progress.documents) detailParts.push(`Documentos ${progress.processedDocuments}/${progress.documents}`);
  progressDetails.textContent = detailParts.join(' · ');
}

function renderStatus(payload) {
  const { hasIndex, buildState, summary } = payload;
  renderSummary(summary);

  updateProgressBar(buildState);

  if (buildState.running) {
    statusBadge.textContent = 'Indexando…';
    const progress = buildState.progress || {};
    statusText.textContent = `Fase: ${formatIndexPhase(progress.phase || buildState.phase)}`;
    reindexBtn.disabled = true;
    startPolling();
    return;
  }

  reindexBtn.disabled = false;
  stopPolling();

  if (buildState.phase === 'error') {
    statusBadge.textContent = 'Error';
    statusText.textContent = buildState.error || 'Ha fallado la indexación.';
    return;
  }

  statusBadge.textContent = hasIndex ? 'Índice listo' : 'Sin índice';
  statusText.textContent = hasIndex
    ? 'Ya puedes buscar por nombre y apellidos.'
    : 'Pulsa “Actualizar índice” para construir la base inicial.';
}

function createAttemptPill(attempt) {
  const span = document.createElement('span');
  span.className = `attempt-pill ${attempt && attempt.good === false ? 'attempt-bad' : 'attempt-good'}`;
  span.textContent = formatAttempt(attempt);
  if (!attempt || attempt.weight === null) {
    span.className = 'attempt-pill';
  }
  return span;
}

function hasAnyAttempt(attempts) {
  return Array.isArray(attempts) && attempts.some((attempt) => attempt && attempt.weight !== null);
}

function formatMovementLabel(rawLabel, fallback) {
  const text = String(rawLabel || '').trim();
  if (!text) return fallback;

  // Los Excel pueden traer cabeceras en mayúsculas: SENTADILLAS, PRESS BANCA,
  // PESO MUERTO, etc. Las mostramos con formato legible sin cambiar el sentido.
  return text
    .toLocaleLowerCase('es-ES')
    .replace(/(^|\s|-)\p{L}/gu, (match) => match.toLocaleUpperCase('es-ES'));
}

function getDisplayedLiftRows(entry) {
  const labels = entry.attempts?.__labels || {};
  const rows = [
    [formatMovementLabel(labels.squat, 'Sentadilla'), entry.attempts?.squat || []],
    [formatMovementLabel(labels.bench, 'Banca'), entry.attempts?.bench || []],
    [formatMovementLabel(labels.deadlift, 'Peso muerto'), entry.attempts?.deadlift || []],
  ];

  const withAttempts = rows.filter(([, attempts]) => hasAnyAttempt(attempts));
  return withAttempts.length ? withAttempts : rows;
}

function renderCompetition(entry) {
  const article = document.createElement('article');
  article.className = 'competition-card';

  const displayedRows = getDisplayedLiftRows(entry);
  const attemptsRows = displayedRows
    .map(([lift], index) => `
      <tr>
        <td><strong>${lift}</strong></td>
        <td class="attempt-cell" data-lift-index="${index}"></td>
      </tr>
    `)
    .join('');

  article.innerHTML = `
    <div class="competition-title">
      <h3>${entry.competitionName}</h3>
      <span class="muted">${formatDate(entry.competitionDate || entry.competitionLocationDateText)}</span>
    </div>
    ${entry.competitionSubtitle ? `<p class="muted">${entry.competitionSubtitle}</p>` : ''}
    <div class="meta-grid">
      <div class="meta-item"><span class="muted">Club</span><br>${entry.club || '—'}</div>
      <div class="meta-item"><span class="muted">Categoría</span><br>${entry.category || '—'}</div>
      <div class="meta-item"><span class="muted">Peso corporal</span><br>${entry.bodyweight ?? '—'} kg</div>
      <div class="meta-item"><span class="muted">Total</span><br>${entry.total ?? '—'} kg</div>
      <div class="meta-item"><span class="muted">Puesto</span><br>${entry.placing || '—'}</div>
      <div class="meta-item"><span class="muted">IPF GL</span><br>${entry.ipfgl ?? '—'}</div>
    </div>
    <table class="attempt-table">
      <thead>
        <tr>
          <th>Movimiento</th>
          <th>Intentos</th>
        </tr>
      </thead>
      <tbody>${attemptsRows}</tbody>
    </table>
    <div class="links">
      ${entry.meetPageUrl ? `<a href="${entry.meetPageUrl}" target="_blank" rel="noreferrer">Página de la competición</a>` : ''}
      ${entry.resultsUrl ? `<a href="${entry.resultsUrl}" target="_blank" rel="noreferrer">Documento de resultados</a>` : ''}
    </div>
  `;

  const rowCells = article.querySelectorAll('.attempt-cell');
  displayedRows.forEach(([, attempts], index) => {
    rowCells[index].append(...attempts.map(createAttemptPill));
  });

  return article;
}


function renderResults(results) {
  resultsBox.innerHTML = '';

  if (!results.length) {
    setMessage('No he encontrado atletas que coincidan con esa búsqueda en el índice actual.', 'info');
    return;
  }

  clearMessage();

  results.forEach((athlete) => {
    const section = document.createElement('section');
    section.className = 'athlete-card';
    section.innerHTML = `
      <div class="athlete-header">
        <div>
          <h2>${athlete.athleteName}</h2>
          <div class="clubs">${athlete.clubs.join(' · ') || 'Club no detectado'}</div>
        </div>
        <div class="badge">${athlete.entries.length} competiciones</div>
      </div>
    `;

    athlete.entries.forEach((entry) => section.appendChild(renderCompetition(entry)));
    resultsBox.appendChild(section);
  });
}

async function refreshStatus() {
  const response = await fetch('/api/status');
  const payload = await response.json();
  renderStatus(payload);
  return payload;
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(refreshStatus, 1000);
}

function stopPolling() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

async function buildIndex() {
  clearMessage();
  await fetch('/api/index', { method: 'POST' });
  await refreshStatus();
}

async function search() {
  const name = nameInput.value.trim();
  if (!name) {
    setMessage('Escribe un nombre y apellidos antes de buscar.', 'error');
    return;
  }

  const response = await fetch(`/api/search?name=${encodeURIComponent(name)}`);
  const payload = await response.json();

  if (!response.ok) {
    setMessage(payload.error || 'No se pudo completar la búsqueda.', 'error');
    return;
  }

  renderResults(payload.results);
}

reindexBtn.addEventListener('click', buildIndex);
searchBtn.addEventListener('click', search);
nameInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') search();
});

refreshStatus().catch((error) => {
  setMessage(`No se pudo cargar el estado inicial: ${error.message}`, 'error');
});
