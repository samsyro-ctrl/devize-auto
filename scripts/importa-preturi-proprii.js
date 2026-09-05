// scripts/importa-preturi-proprii.js
// Punct de plecare pentru cache-ul de preturi (preturi_curente): colectia
// "proprii" din recrutare-bot are deja 1.006 articole cu pret introdus
// manual de-a lungul timpului -- nu are sens sa le reintroduci de la zero
// aici. Citeste DIRECT fisierul SQLite al lui recrutare-bot (doar citire,
// nu-l atinge), fara nicio dependinta de codul lui -- devize-auto ramane
// un instrument de sine statator, doar imprumuta datele o singura data.
//
// Rulare:
//   node scripts/importa-preturi-proprii.js                -- doar arata ce ar importa
//   node scripts/importa-preturi-proprii.js --scrie         -- chiar scrie in cache
'use strict';

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const SCRIE = process.argv.includes('--scrie');
const CALE_RECRUTARE_BOT_DB = process.env.RECRUTARE_BOT_DB
  || path.join(__dirname, '..', '..', 'recrutare-bot', 'output', 'memorie.db');

function main() {
  if (!fs.existsSync(CALE_RECRUTARE_BOT_DB)) {
    console.error(`Nu gasesc baza recrutare-bot la: ${CALE_RECRUTARE_BOT_DB}`);
    console.error('Seteaza RECRUTARE_BOT_DB in .env daca e in alta parte.');
    process.exit(1);
  }

  const { DatabaseSync } = require('node:sqlite');
  const sursa = new DatabaseSync(CALE_RECRUTARE_BOT_DB, { readOnly: true });
  const randuri = sursa.prepare(`
    SELECT cod, descriere, unitate, pret FROM nomenclator_articole
    WHERE colectie = 'proprii' AND pret IS NOT NULL AND pret > 0
  `).all();
  sursa.close();

  console.log(`Sursa: ${CALE_RECRUTARE_BOT_DB}`);
  console.log(`Gasite ${randuri.length} articole din "proprii" cu pret introdus.`);
  console.log(`Mod: ${SCRIE ? 'SCRIU in cache-ul de preturi' : 'doar test, NU scriu (adauga --scrie ca sa chiar salveze)'}.\n`);

  randuri.slice(0, 5).forEach((r) => console.log(`   ${r.cod.padEnd(14)} ${String(r.pret).padStart(10)} lei  ${r.descriere}`));
  if (randuri.length > 5) console.log(`   ... si inca ${randuri.length - 5}.`);

  if (SCRIE) {
    const db = require('../src/db');
    db.deschide(path.join(__dirname, '..', 'output'));
    for (const r of randuri) db.salveazaPretCurent('proprii', r.cod, r.pret);
    console.log(`\nScrise ${randuri.length} preturi in cache-ul global (preturi_curente).`);
  } else {
    console.log('\nNimic scris -- ruleaza din nou cu --scrie ca sa chiar salveze.');
  }
}

main();
