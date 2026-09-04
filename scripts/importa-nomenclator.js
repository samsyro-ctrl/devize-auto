// scripts/importa-nomenclator.js
// Importa indicatoarele de norme de deviz (fisiere .bc3, format FIEBDC-3) in
// baza proprie a acestui instrument -- adaptare dupa
// recrutare-bot/scripts/importa-nomenclator-devize.js, cu aceeasi logica,
// doar tinta schimbata (baza locala devize-auto, nu recrutare-bot).
//
// Import STATIC, o data pe colectie -- reruleaza sters-si-reinserat per
// colectie (idempotent), NU adauga la infinit.
//
// Rulare (din radacina proiectului):
//   node scripts/importa-nomenclator.js                -- doar arata ce ar importa
//   node scripts/importa-nomenclator.js --scrie         -- chiar scrie in baza
//   node scripts/importa-nomenclator.js "alt/folder" --scrie
'use strict';

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const SCRIE = process.argv.includes('--scrie');
const ARG_FOLDER = process.argv.slice(2).find((a) => !a.startsWith('--'));
const SURSA_DIR = ARG_FOLDER || process.env.NOMENCLATOR_BC3_DIR;

if (!SURSA_DIR) {
  console.error('Lipseste folderul sursa -- da-l ca argument sau seteaza NOMENCLATOR_BC3_DIR in .env.');
  process.exit(1);
}

// Nume fisier -> slug de colectie (cheia din coloana "colectie").
const COLECTII = {
  'Indicatoare__ 1. Colectia 1981.bc3': 'colectia_1981',
  'Indicatoare__ 2. Colectia 1991.bc3': 'colectia_1991',
  'Indicatoare__ 3. Colectia 1993.bc3': 'colectia_1993',
  'Indicatoare__ 4. Colectia 1999.bc3': 'colectia_1999',
  'Indicatoare__ 5. Colectia 2006.bc3': 'colectia_2006',
  'Indicatoare__ 6. Norme de Munca.bc3': 'norme_munca',
  'Indicatoare__ 7. Colectia Intersoft.bc3': 'intersoft',
  'Indicatoare__ 8. Colectia Plus Intersoft.bc3': 'intersoft_plus',
  'Indicatoare__10. Norme proprii.bc3': 'proprii',
};

async function main() {
  const db = require('../src/db');
  const { parcurgeBC3 } = require('../src/bc3');
  db.deschide(path.join(__dirname, '..', 'output'));

  console.log(`Sursa: ${SURSA_DIR}`);
  console.log(`Mod: ${SCRIE ? 'SCRIU in baza' : 'doar test, NU scriu (adauga --scrie ca sa chiar salveze)'}.\n`);

  let totalArticole = 0;
  let totalDescompuneri = 0;

  for (const [fisier, colectie] of Object.entries(COLECTII)) {
    const cale = path.join(SURSA_DIR, fisier);
    if (!fs.existsSync(cale)) {
      console.log(`   ⚠️  lipseste: ${fisier}`);
      continue;
    }

    const articole = [];
    const descompuneri = [];
    await parcurgeBC3(cale, {
      onArticol: (a) => articole.push(a),
      onDescompunere: (d) => descompuneri.push(d),
    });

    const cuPret = articole.filter((a) => a.pret != null).length;
    console.log(`   ${colectie.padEnd(14)} ${String(articole.length).padStart(7)} articole (${cuPret} cu pret), ${String(descompuneri.length).padStart(7)} muchii descompunere`);

    if (SCRIE) {
      db.stergeNomenclator(colectie);
      db.insereazaArticoleNomenclator(colectie, articole);
      db.insereazaDescompuneriNomenclator(colectie, descompuneri);
    }

    totalArticole += articole.length;
    totalDescompuneri += descompuneri.length;
  }

  if (SCRIE) {
    console.log('\nReconstruiesc indexul de cautare (FTS)...');
    db.reconstruiesteNomenclatorFts();
  }

  console.log(`\nTotal: ${totalArticole} articole, ${totalDescompuneri} muchii descompunere.`
    + (SCRIE ? ' Scrise in output/devize.db.' : ' Nimic scris -- ruleaza din nou cu --scrie ca sa chiar salveze.'));
}

main().catch((e) => { console.error(e); process.exit(1); });
