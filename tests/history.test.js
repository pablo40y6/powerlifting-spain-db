const test = require('node:test');
const assert = require('node:assert/strict');
const { archiveLinks, htmlRows, parseArchiveRows, mergeHistory } = require('../scraper/history');
const { applyCountryEvidence, recordEvidence } = require('../scraper/countries');
const { clubDirectory, readActiveClubs } = require('../scraper/clubs');

const root = 'https://www.powerhispania.net/Resultados/';

test('el archivo antiguo corrige el enlace masculino del Noroeste de 2019', () => {
  const links = archiveLinks(Buffer.from('<p><a href="NorOeste_Power_Fem_2019.htm">Mujeres</a> <a href="NorOeste_Power_Fem_2019.htm">Hombres</a></p>'),
    root + '2019/Resultados.html', 2019);
  assert.deepEqual(links.map((row) => row.url), [
    root + '2019/NorOeste_Power_Fem_2019.htm', root + '2019/Noroeste_Power_Mas_2019.htm',
  ]);
});

test('el acta de banca histórica conserva la categoría antigua y los intentos nulos', () => {
  const html = Buffer.from('<meta charset="utf-8"><style>.fail { color: red; }</style><table>' +
    '<tr><td colspan="11">Campeonato de España de Press Banca</td></tr>' +
    '<tr><td colspan="11">Móstoles, 30 de abril de 1994</td></tr>' +
    '<tr><td colspan="11">Clasificación femenina</td></tr>' +
    '<tr><td></td><td>NOMBRE</td><td>CLUB</td><td>AÑO</td><td>PESO</td><td>Cat.</td><td>PB1</td><td>PB2</td><td>PB3</td><td>TOTAL</td><td>Wilks</td></tr>' +
    '<tr><td>1</td><td>Primera Atleta</td><td>Club Ejemplo</td><td>1970</td><td></td><td>67,5</td><td>50</td><td class="fail">60</td><td>55</td><td>55</td><td>42,36</td></tr></table>');
  const url = root + '1994/banca.htm';
  const [row] = parseArchiveRows(htmlRows(html), { url, label: 'Press Banca', description: 'Campeonato de España', year: 1994 });
  assert.deepEqual([row.sex, row.category, row.bodyweight, row.eventType, row.total, row.ipfgl],
    ['F', '-67.5kg', null, 'bench', 55, null]);
  assert.equal(row.attempts.bench[1].good, false);
  assert.equal(row.historicalPoints, 42.36);
  assert.equal(row.competition.date, '1994-04-30');
  assert.equal(mergeHistory([row], [{ ...row }]).length, 1);
});

test('el archivo HTML alinea los intentos cuando la cabecera ocupa dos filas', () => {
  const html = Buffer.from('<meta charset="utf-8"><table>' +
    '<tr><td rowspan="2">Mujeres (1)</td><td rowspan="2">Club</td><td rowspan="2">Peso</td><td colspan="3">Sentadillas</td><td colspan="3">Press banca</td><td colspan="3">Peso muerto</td><td rowspan="2">Total</td></tr>' +
    '<tr><td>SQ1</td><td>SQ2</td><td>SQ3</td><td>PB1</td><td>PB2</td><td>PB3</td><td>PM1</td><td>PM2</td><td>PM3</td></tr>' +
    '<tr><td>Atleta de Prueba</td><td>Club Histórico</td><td>47,2</td><td>70</td><td>75</td><td>80</td><td>50</td><td>55</td><td>60</td><td>85</td><td>90</td><td>95</td><td>235</td></tr></table>');
  const url = root + '2008/copa.htm';
  const [row] = parseArchiveRows(htmlRows(html), { url, label: 'Powerlifting', description: 'Copa de España 2008', year: 2008 });
  assert.deepEqual([row.sex, row.category, row.club, row.total, row.bestLifts.deadlift], ['F', '-48kg', 'Club Histórico', 235, 95]);
});

test('la nacionalidad exige fuente coincidente y respeta a los homónimos', () => {
  const origin = 'https://powerliftingspain.es/acta.pdf';
  const example = { sex: 'F', athleteName: 'Alfa Apellido Dos', yearOfBirth: 1998, club: 'Club de España' };
  const same = { ...example, athleteName: 'Apellido Dos Alfa' };
  const homonym = { ...example, yearOfBirth: 2000 };
  const guest = { sex: 'M', athleteName: 'Invitado Frances', club: 'France' };
  const uncertain = { sex: 'F', athleteName: 'Otra Persona', club: 'Club de España' };
  const records = recordEvidence('F RSBJ SQ 47 115.0 Ana María Prueba \tClub Test \tLocalidad', origin);
  assert.equal(records[0].athleteName, 'Ana María Prueba');
  applyCountryEvidence([same, homonym, guest, uncertain], [{ ...example, country: 'ESP', url: origin }, ...records]);
  assert.deepEqual([same.country, same.countrySource, homonym.country, guest.country, uncertain.country],
    ['ESP', origin, null, 'FRA', null]);
});

test('una sigla compartida solo se asigna con la leyenda de su acta', () => {
  const url = 'https://powerliftingspain.es/acta.pdf';
  const other = 'https://powerliftingspain.es/otra.pdf';
  const list = readActiveClubs('MADRID: 2\nMadrid \tMadrid \tCLUB ALFA \tPersona Privada nombre@example.com');
  assert.equal(list[0].short, 'CLUB ALFA');
  const entries = [url, other, 'https://powerliftingspain.es/sin-leyenda.pdf'].map((source) =>
    ({ club: 'CLA', competition: { resultsUrl: source, year: 2026 } }));
  const result = clubDirectory(entries, list, new Map([
    [url, [{ code: 'CLA', name: 'Club Alfa' }]],
    [other, [{ code: 'CLA', name: 'Club de Atletismo' }]],
  ]));
  assert.deepEqual(entries.map((entry) => entry.clubId), ['club-alfa', 'club-de-atletismo', undefined]);
  assert.equal(result.unresolved[0].count, 1);
  assert.equal(result.clubs.find((club) => club.id === 'club-alfa').active, true);
  assert.doesNotMatch(JSON.stringify(result), /Persona Privada|example\.com/);
});
