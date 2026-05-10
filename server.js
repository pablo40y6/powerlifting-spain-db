const express = require('express');
const path = require('path');
const { buildIndex, loadIndex, searchAthletes } = require('./scraper/crawler');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'web')));

let currentIndex = loadIndex();
let buildState = {
  running: false,
  phase: currentIndex ? 'ready' : 'idle',
  startedAt: null,
  finishedAt: currentIndex ? currentIndex.builtAt : null,
  progress: null,
  error: null,
};

async function triggerBuild() {
  if (buildState.running) return;

  buildState = {
    running: true,
    phase: 'starting',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    progress: null,
    error: null,
  };

  try {
    currentIndex = await buildIndex({
      onProgress: (progress) => {
        buildState.phase = progress.phase;
        buildState.progress = progress;
      },
    });
    buildState.running = false;
    buildState.phase = 'ready';
    buildState.finishedAt = new Date().toISOString();
  } catch (error) {
    buildState.running = false;
    buildState.phase = 'error';
    buildState.error = error.message;
    buildState.finishedAt = new Date().toISOString();
  }
}

app.get('/api/status', (_req, res) => {
  res.json({
    ok: true,
    hasIndex: Boolean(currentIndex),
    buildState,
    summary: currentIndex
      ? {
          builtAt: currentIndex.builtAt,
          athleteCount: currentIndex.athleteCount,
          entryCount: currentIndex.entryCount,
          competitionPagesIndexed: currentIndex.competitionPagesIndexed,
          documentsIndexed: currentIndex.documentsIndexed,
          warnings: currentIndex.warnings || [],
        }
      : null,
  });
});

app.post('/api/index', async (_req, res) => {
  if (!buildState.running) {
    triggerBuild();
  }
  res.json({ ok: true, buildState });
});

app.get('/api/search', (req, res) => {
  const name = String(req.query.name || '').trim();
  if (!name) {
    return res.status(400).json({ ok: false, error: 'Debes indicar un nombre.' });
  }

  if (!currentIndex) {
    return res.status(409).json({
      ok: false,
      error: 'Todavía no existe un índice. Pulsa “Actualizar índice” primero.',
      buildState,
    });
  }

  const matches = searchAthletes(currentIndex, name);
  res.json({
    ok: true,
    query: name,
    count: matches.length,
    results: matches,
  });
});

app.get('/{*any}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'web', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`PowerliftingSpain Finder escuchando en http://localhost:${PORT}`);
});
