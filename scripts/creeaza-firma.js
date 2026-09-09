// scripts/creeaza-firma.js
// Creeaza un cont nou pe public.db (devize.buildandfix.ai) -- singura cale de
// a inregistra o firma in prima versiune, fara inregistrare libera (vezi
// planul). Parola temporara se afiseaza O SINGURA DATA, in consola -- se
// transmite firmei pe alt canal (WhatsApp/email), nu se salveaza in clar
// nicaieri.
//
// Rulare:
//   node scripts/creeaza-firma.js "Nume Firma" email@firma.ro
//   node scripts/creeaza-firma.js "Nume Firma" email@firma.ro --scrie
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const SCRIE = process.argv.includes('--scrie');
const [nume, email] = process.argv.slice(2).filter((a) => !a.startsWith('--'));

if (!nume || !email) {
  console.error('Rulare: node scripts/creeaza-firma.js "Nume Firma" email@firma.ro [--scrie]');
  process.exit(1);
}

function main() {
  const db = require('../src/db');
  db.deschide(path.join(__dirname, '..', 'output'), 'public.db');
  const firmePublic = require('../src/firmePublic');

  console.log(`Firma: ${nume}`);
  console.log(`Email: ${email}`);
  console.log(`Mod: ${SCRIE ? 'SCRIU contul' : 'doar test, NU scriu (adauga --scrie ca sa chiar creeze)'}.\n`);

  if (!SCRIE) {
    console.log('Nimic creat -- ruleaza din nou cu --scrie ca sa chiar creeze contul.');
    return;
  }

  try {
    const r = firmePublic.creeaza({ nume, email });
    console.log(`✔ Cont creat (id ${r.id}).\n`);
    console.log(`Parola temporara (trimite-o firmei acum -- nu mai apare niciodata):`);
    console.log(`   ${r.parolaTemporara}\n`);
    console.log(`Login la: https://devize.buildandfix.ai`);
  } catch (e) {
    console.error(`✖ ${e.message}`);
    process.exit(1);
  }
}

main();
