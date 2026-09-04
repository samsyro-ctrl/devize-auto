// scripts/calibreaza-prag-matching.js
// PRAG_SCOR_MATCHING si PRAG_GAP_MATCHING nu se ghicesc -- se calibreaza
// uitandu-te la scorurile reale pe denumiri cunoscute. Acest script NU decide
// singur pragul (n-are de unde sa stie care candidat e "corect") -- doar
// arata, pentru fiecare denumire de test, top 5 candidati cu scorul lor si
// gap-ul fata de urmatorul. Uita-te la distributie: pentru denumirile unde
// primul candidat CHIAR e cel corect, ce scor si ce gap au -- acelea sunt
// pragurile de pus in .env.
//
// Rulare:
//   node scripts/calibreaza-prag-matching.js                    -- foloseste setul implicit de mai jos
//   node scripts/calibreaza-prag-matching.js denumiri-test.txt   -- un fisier, o denumire pe linie
'use strict';

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Set implicit, doar orientativ -- inlocuieste-l cu denumiri REALE dintr-o
// antemasuratoare pe care ai lucrat deja, ca sa stii care raspuns e corect.
const SET_IMPLICIT = [
  'Zidarie caramida',
  'Beton C20/25 turnat in cofraje',
  'Sapatura mecanica in teren categoria 2',
  'Tencuiala interioara',
  'Montaj tamplarie PVC',
  'Hidroizolatie terasa',
  'Termoizolatie polistiren expandat 10cm',
  'Pardoseala gresie',
  'Vopsitorii lavabile',
  'Cofraje pentru fundatii',
];

function main() {
  const db = require('../src/db');
  const { gasesteCandidati } = require('../src/matching');
  db.deschide(path.join(__dirname, '..', 'output'));

  const fisierArg = process.argv[2];
  const denumiri = fisierArg && fs.existsSync(fisierArg)
    ? fs.readFileSync(fisierArg, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    : SET_IMPLICIT;

  for (const denumire of denumiri) {
    console.log(`\n"${denumire}"`);
    const candidati = gasesteCandidati(denumire, 5);
    if (!candidati.length) { console.log('  (niciun candidat)'); continue; }
    candidati.forEach((c, i) => {
      const gap = i > 0 ? ` (gap fata de #${i}: ${(c.scor - candidati[i - 1].scor).toFixed(3)})` : '';
      console.log(`  ${i + 1}. scor=${c.scor.toFixed(3)}${gap}  [${c.colectie}/${c.cod}] ${c.descriere} (${c.unitate})`);
    });
  }

  console.log('\nUita-te la scorul si gap-ul candidatilor #1 CORECTI, pe denumirile pe care le cunosti --');
  console.log('acelea sunt PRAG_SCOR_MATCHING (scor maxim acceptat) si PRAG_GAP_MATCHING (gap minim fata de #2), de pus in .env.');
}

main();
