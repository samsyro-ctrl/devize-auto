// scripts/sincronizeaza-preturi-server.js
// Sincronizare periodica a cache-ului de preturi cu ce e introdus/actualizat
// in nomenclatorul lui recrutare-bot.
//
// De la 10.09.2026, ruleaza PE SERVER (systemd timer, vezi deploy-ul), nu mai
// pe laptop -- devize-auto (panou.js) si recrutare-bot sunt pe ACELASI Hetzner
// (77.42.38.135), deci citim direct fisierul SQLite al lui recrutare-bot,
// fara SSH catre noi insine. Calea e configurabila prin RECRUTARE_BOT_DB
// pentru teste locale (default: calea reala de pe server).
//
// Rulare:
//   node scripts/sincronizeaza-preturi-server.js                -- doar arata ce ar aduce
//   node scripts/sincronizeaza-preturi-server.js --scrie         -- chiar scrie in cache
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const SCRIE = process.argv.includes('--scrie');

const RECRUTARE_BOT_DB = process.env.RECRUTARE_BOT_DB || '/opt/recrutare-bot/output/memorie.db';

function citesteRanduri() {
  const { DatabaseSync } = require('node:sqlite');
  // read-only, nu opreste/atinge serviciul recrutare-bot -- doar citeste.
  // Doar "proprii": e singura colectie cu preturi introduse/actualizate de noi
  // (celelalte sunt indicatoare istorice, fara pret curent de piata).
  const db = new DatabaseSync(RECRUTARE_BOT_DB, { readOnly: true });
  try {
    return db.prepare(
      "SELECT cod, descriere, pret FROM nomenclator_articole WHERE colectie='proprii' AND pret IS NOT NULL AND pret > 0"
    ).all();
  } finally {
    db.close();
  }
}

function main() {
  console.log(`Citesc din ${RECRUTARE_BOT_DB}...`);
  let randuri;
  try {
    randuri = citesteRanduri();
  } catch (e) {
    console.error(`Nu am putut citi baza recrutare-bot (${RECRUTARE_BOT_DB}):`, e.message);
    process.exit(1);
  }

  console.log(`Gasite ${randuri.length} articole din "proprii" cu pret.`);
  console.log(`Mod: ${SCRIE ? 'SCRIU in cache-ul local' : 'doar test, NU scriu (adauga --scrie ca sa chiar salveze)'}.\n`);
  randuri.slice(0, 5).forEach((r) => console.log(`   ${r.cod.padEnd(14)} ${String(r.pret).padStart(10)} lei  ${r.descriere}`));
  if (randuri.length > 5) console.log(`   ... si inca ${randuri.length - 5}.`);

  if (SCRIE) {
    const db = require('../src/db');
    db.deschide(path.join(__dirname, '..', 'output'));
    for (const r of randuri) db.salveazaPretCurent('proprii', r.cod, r.pret);
    console.log(`\nScrise/actualizate ${randuri.length} preturi in cache-ul local (preturi_curente).`);
  } else {
    console.log('\nNimic scris -- ruleaza din nou cu --scrie ca sa chiar salveze.');
  }
}

main();
