// scripts/verifica-nomenclator.js
// Verificare rapida dupa import: cate articole are fiecare colectie, si daca
// totalul se potriveste cu numerele deja cunoscute din recrutare-bot
// (294.475 articole / 1.434.444 muchii de descompunere, la momentul scrierii
// acestui script -- daca sursa .bc3 se schimba, numerele astea nu mai sunt
// reperul corect si trebuie actualizate aici).
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const REPER_ARTICOLE = 294475;

function main() {
  const db = require('../src/db');
  db.deschide(path.join(__dirname, '..', 'output'));

  const stats = db.statisticiNomenclator();
  if (!stats.length) {
    console.log('Nomenclatorul e gol -- ruleaza intai scripts/importa-nomenclator.js --scrie.');
    process.exit(1);
  }

  console.log('Colectie'.padEnd(16), 'Articole'.padStart(9), 'Cu pret'.padStart(9));
  let total = 0;
  for (const s of stats) {
    console.log(s.colectie.padEnd(16), String(s.articole).padStart(9), String(s.cu_pret).padStart(9));
    total += s.articole;
  }
  console.log('-'.repeat(36));
  console.log('TOTAL'.padEnd(16), String(total).padStart(9));

  const diferenta = total - REPER_ARTICOLE;
  if (diferenta === 0) {
    console.log(`\n✅ Se potriveste exact cu reperul cunoscut (${REPER_ARTICOLE}).`);
  } else {
    console.log(`\n⚠️  Difera de reperul cunoscut (${REPER_ARTICOLE}) cu ${diferenta > 0 ? '+' : ''}${diferenta}.`
      + ' Poate fi normal (surse .bc3 actualizate) sau semn ca importul n-a mers complet -- verifica manual.');
  }
}

main();
