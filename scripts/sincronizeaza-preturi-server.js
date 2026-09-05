// scripts/sincronizeaza-preturi-server.js
// Sincronizare periodica a cache-ului de preturi cu ce e introdus/actualizat
// in nomenclatorul lui recrutare-bot, direct pe serverul de productie
// (nu mai e nevoie de rularea manuala a importa-preturi-proprii.js pe o
// copie locala invechita).
//
// De ce SSH catre server, nu un fisier local: recrutare-bot ruleaza LIVE pe
// Hetzner (77.42.38.135), nu pe masina asta -- copia locala de memorie.db e
// doar o copie de lucru, poate veche. Adresa serverului e scrisa direct aici
// (nu in .env), la fel ca in deploy.sh din licitatie-analiza/elicitatie-scraper
// -- e o conventie deja stabilita in familia asta de proiecte.
//
// Rulare:
//   node scripts/sincronizeaza-preturi-server.js                -- doar arata ce ar aduce
//   node scripts/sincronizeaza-preturi-server.js --scrie         -- chiar scrie in cache
'use strict';

const path = require('path');
const { execFileSync } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const SCRIE = process.argv.includes('--scrie');

const VPS = 'root@77.42.38.135';
const KEY = process.env.SSH_KEY_HETZNER || path.join(require('os').homedir(), '.ssh', 'hetzner');
const DIR_SERVER = '/opt/recrutare-bot';

// Interogare care ruleaza PE SERVER (nu local) -- citeste direct baza vie a
// lui recrutare-bot, read-only, fara sa opreasca sau sa atinga serviciul.
// Doar "proprii": e singura colectie cu preturi introduse/actualizate de noi
// (celelalte sunt indicatoare istorice, fara pret curent de piata).
const SCRIPT_REMOTE = `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('output/memorie.db', { readOnly: true });
const randuri = db.prepare(
  "SELECT cod, descriere, pret FROM nomenclator_articole WHERE colectie='proprii' AND pret IS NOT NULL AND pret > 0"
).all();
process.stdout.write(JSON.stringify(randuri));
`.trim();

function main() {
  console.log(`Ma conectez la ${VPS}...`);
  let stdout;
  try {
    stdout = execFileSync(
      'ssh',
      ['-i', KEY, VPS, `cd ${DIR_SERVER} && node -e "${SCRIPT_REMOTE.replace(/"/g, '\\"')}"`],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    );
  } catch (e) {
    console.error('Nu am putut citi de pe server:', e.message);
    process.exit(1);
  }

  let randuri;
  try {
    randuri = JSON.parse(stdout);
  } catch (e) {
    console.error('Raspuns neasteptat de pe server (nu e JSON valid):', stdout.slice(0, 500));
    process.exit(1);
  }

  console.log(`Gasite ${randuri.length} articole din "proprii" cu pret, pe server.`);
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
