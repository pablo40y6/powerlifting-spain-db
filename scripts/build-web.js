#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const distDir = path.join(root, 'dist');
const dataDir = path.join(distDir, 'data');

const required = [
  ['web/index.html', 'index.html'],
  ['web/app.js', 'app.js'],
  ['web/styles.css', 'styles.css'],
  ['data/index.json', 'data/index.json'],
];

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

fs.writeFileSync(path.join(distDir, '.nojekyll'), '', 'utf8');

for (const [source, target] of required) {
  const sourcePath = path.join(root, source);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Falta ${source}. Ejecuta npm run build:index antes de npm run build:web.`);
  }
  fs.copyFileSync(sourcePath, path.join(distDir, target));
}

console.log('Web estática generada en dist/.');
