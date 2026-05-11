const test = require('node:test');
const assert = require('node:assert/strict');
const { _private: parserPrivate } = require('../scraper/parser');

function shouldReject(athleteName, club = '') {
  return parserPrivate.resultLooksLikeTeamOrSummary({ athleteName, club });
}

test('no indexa filas de clubes reales como atletas', () => {
  assert.equal(shouldReject('720 POWERLIFTING Ourense'), true);
  assert.equal(shouldReject('84 POWERLIFTING TEAM Malaga'), true);
});

test('no indexa filas con fórmulas de puntos por equipos', () => {
  assert.equal(shouldReject('RISING POWERLIFTING [12+12+8]'), true);
  assert.equal(shouldReject('Atleta Prueba', '[12+12+8]'), true);
});

test('mantiene atletas reales de regresión', () => {
  assert.equal(shouldReject('Aranda Sanchez Saul'), false);
  assert.equal(shouldReject('Garin Martin Cristian'), false);
});
