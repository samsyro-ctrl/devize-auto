// scripts/sterge-nomenclator-proprii-mort.js
// Sterge copia statica, moarta, a colectiei "proprii" din nomenclator_articole
// (+ nomenclator_descompuneri) -- gasita in auditul de duplicare BC3
// (10.09.2026): niciun cod de rulare (panou.js, public-server.js, matching.js,
// generareDeviz.js, deviz.js) citeste vreodata nomenclator_articole filtrat pe
// colectie='proprii' -- singurul pret folosit efectiv vine din preturi_curente
// (vezi src/preturi.js), populat automat din recrutare-bot de
// scripts/sincronizeaza-preturi-server.js. recrutare-bot e sursa unica de
// adevar pentru "proprii" -- vezi si scripts/importa-nomenclator.js (COLECTII
// nu mai contine "proprii", ca sa nu recreeze copia moarta).
//
// Ruleaza pe UN SINGUR fisier .db pe rulare -- devize-auto are DOUA baze
// separate (devize.db, uz intern -- si public.db, public multi-firma), cu
// schema comuna dar copii separate ale acestei colectii moarte. Ruleaza-l pe
// fiecare, explicit.
//
// Rulare (din radacina proiectului):
//   node scripts/sterge-nomenclator-proprii-mort.js                    -- doar arata, NU sterge (implicit devize.db)
//   node scripts/sterge-nomenclator-proprii-mort.js --scrie             -- chiar sterge, devize.db
//   node scripts/sterge-nomenclator-proprii-mort.js --scrie --fisier public.db  -- chiar sterge, public.db
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const SCRIE = process.argv.includes('--scrie');
const iFisier = process.argv.indexOf('--fisier');
const NUME_FISIER = iFisier !== -1 ? process.argv[iFisier + 1] : 'devize.db';
const COLECTIE = 'proprii';

function main() {
  const db = require('../src/db');
  db.deschide(path.join(__dirname, '..', 'output'), NUME_FISIER);

  const inainte = db.statisticiNomenclator().find((r) => r.colectie === COLECTIE);
  console.log(`Fisier: ${NUME_FISIER}`);
  console.log(`Colectia "${COLECTIE}" inainte: ${inainte ? inainte.articole : 0} articole.`);
  console.log(`Mod: ${SCRIE ? 'STERG din baza' : 'doar test, NU sterg (adauga --scrie ca sa chiar stearga)'}.\n`);

  if (!inainte || inainte.articole === 0) {
    console.log('Nimic de sters -- colectia e deja goala sau nu exista.');
    return;
  }

  if (SCRIE) {
    // stergeNomenclator sterge din AMBELE tabele (articole + descompuneri),
    // doar pentru colectia data -- nu atinge celelalte 8 colectii istorice.
    db.stergeNomenclator(COLECTIE);
    db.reconstruiesteNomenclatorFts();
    const dupa = db.statisticiNomenclator().find((r) => r.colectie === COLECTIE);
    console.log(`Sters. Colectia "${COLECTIE}" dupa: ${dupa ? dupa.articole : 0} articole. Index FTS reconstruit.`);
  } else {
    console.log('Nimic sters -- ruleaza din nou cu --scrie ca sa chiar stearga.');
  }
}

main();
