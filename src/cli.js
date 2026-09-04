// src/cli.js
// Comenzile instrumentului: incarca, revizuieste, genereaza, preturi,
// incarca-preturi, export, proiecte.
'use strict';

const path = require('path');
const fs = require('fs');
const readline = require('readline');

const db = require('./db');
const extract = require('./extract');
const antemasuratoare = require('./antemasuratoare');
const matching = require('./matching');
const descompunere = require('./descompunere');
const preturi = require('./preturi');
const deviz = require('./deviz');
const { slug } = require('./util');

const OUTPUT_DIR = path.join(__dirname, '..', 'output');

function caleProiect(proiectId, ...parti) {
  return path.join(OUTPUT_DIR, 'proiecte', String(proiectId), ...parti);
}

async function comandaIncarca(args) {
  const fisier = args.find((a) => !a.startsWith('--'));
  const idxNume = args.indexOf('--proiect');
  const nume = idxNume >= 0 ? args[idxNume + 1] : (fisier ? path.basename(fisier) : null);

  if (!fisier || !fs.existsSync(fisier)) {
    console.error('Da calea catre fisierul de antemasuratoare (Excel/PDF/Word).');
    process.exit(1);
  }

  const avertismente = [];
  console.log(`Extrag text din ${path.basename(fisier)}...`);
  const text = await extract.textDinFisier({ nume: path.basename(fisier), cale: fisier }, avertismente);
  if (!text) {
    console.error('N-am putut extrage text din fisier.');
    avertismente.forEach((a) => console.error('  ' + a));
    process.exit(1);
  }

  console.log('Extrag liniile de antemasuratoare (Claude)...');
  const linii = await antemasuratoare.extrageLiniiAntemasuratoare(text, avertismente);
  if (!linii.length) {
    console.error('Nicio linie de antemasuratoare gasita in document.');
    process.exit(1);
  }

  const proiectId = db.creeazaProiect(nume, fisier);
  db.insereazaLiniiAntemasuratoare(proiectId, linii);

  let auto = 0;
  let deRevizuit = 0;
  let faraPotrivire = 0;
  for (const l of db.liniiPeProiect(proiectId)) {
    const rezolutie = matching.alegeMatch(l);
    db.salveazaRezolutie(l.id, rezolutie);
    if (rezolutie.stare === 'auto') auto++;
    else if (rezolutie.stare === 'fara_potrivire') faraPotrivire++;
    else deRevizuit++;
  }
  db.actualizeazaStareProiect(proiectId, 'matching');

  console.log(`\nProiect #${proiectId} "${nume}" -- ${linii.length} linii extrase.`);
  console.log(`  ${auto} auto-potrivite, ${deRevizuit} de revizuit, ${faraPotrivire} fara nicio potrivire.`);
  if (avertismente.length) {
    console.log('\nAvertismente:');
    avertismente.forEach((a) => console.log('  ' + a));
  }
  console.log(`\nUrmatorul pas: node index.js revizuieste ${proiectId}`);
}

async function comandaRevizuieste(args) {
  const proiectId = Number(args[0]);
  if (!proiectId) { console.error('Da id-ul proiectului.'); process.exit(1); }

  const linii = db.liniiCuRezolutiiPeProiect(proiectId).filter((l) => l.stare !== 'confirmat' && l.stare !== 'auto');
  if (!linii.length) {
    console.log('Nimic de revizuit -- toate liniile sunt deja auto-potrivite sau confirmate.');
    console.log('Poti totusi revedea liniile "auto" direct in baza, daca vrei -- nu sunt ascunse, doar nu cer atentie.');
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const intreaba = (q) => new Promise((res) => rl.question(q, res));

  for (const l of linii) {
    console.log(`\n#${l.ordine} "${l.denumire}" -- ${l.cantitate} ${l.unitate} (capitol: ${l.capitol})`);
    let candidati = JSON.parse(l.candidati_json || '[]');
    if (!candidati.length) console.log('  (niciun candidat gasit automat)');
    candidati.forEach((c, i) => console.log(`  ${i + 1}. [${c.colectie}/${c.cod}] ${c.descriere} (${c.unitate})`));

    // eslint-disable-next-line no-await-in-loop
    const raspuns = (await intreaba('  Alege numarul, "c" pentru cautare noua, sau Enter ca sa sari: ')).trim();
    if (!raspuns) continue;

    if (raspuns.toLowerCase() === 'c') {
      // eslint-disable-next-line no-await-in-loop
      const textCautare = await intreaba('  Cauta dupa: ');
      candidati = matching.gasesteCandidati(textCautare);
      candidati.forEach((c, i) => console.log(`  ${i + 1}. [${c.colectie}/${c.cod}] ${c.descriere} (${c.unitate})`));
      // eslint-disable-next-line no-await-in-loop
      const alegere = await intreaba('  Alege numarul (sau Enter ca sa renunti): ');
      const ales = candidati[Number(alegere) - 1];
      if (ales) db.confirmaRezolutie(l.id, ales.colectie, ales.cod);
      continue;
    }

    const ales = candidati[Number(raspuns) - 1];
    if (ales) db.confirmaRezolutie(l.id, ales.colectie, ales.cod);
    else console.log('  Numar invalid, sarit.');
  }
  rl.close();
  console.log('\nRevizuire terminata.');
}

function comandaGenereaza(args) {
  const proiectId = Number(args[0]);
  if (!proiectId) { console.error('Da id-ul proiectului.'); process.exit(1); }

  const linii = db.liniiCuRezolutiiPeProiect(proiectId);
  const nerezolvate = linii.filter((l) => !l.colectie || !l.cod || !['auto', 'confirmat'].includes(l.stare));
  if (nerezolvate.length) {
    console.error(`${nerezolvate.length} linii nerezolvate -- ruleaza intai: node index.js revizuieste ${proiectId}`);
    process.exit(1);
  }

  db.stergeResurseAgregate(proiectId);
  const avertismente = [];
  for (const l of linii) {
    const reteta = descompunere.descompuneLinie(l.colectie, l.cod, l.cantitate, avertismente);
    for (const frunza of reteta.values()) {
      db.adaugaResursaAgregata(proiectId, {
        colectie: frunza.colectie, cod: frunza.cod, tip: frunza.tip,
        unitate: frunza.unitate, descriere: frunza.descriere, cantitate: frunza.cantitateTotala,
      });
    }
  }
  db.actualizeazaStareProiect(proiectId, 'generat');

  const resurse = db.resurseAgregatePeProiect(proiectId);
  console.log(`Generat: ${resurse.length} resurse distincte, din ${linii.length} linii.`);
  if (avertismente.length) {
    console.log(`\n${avertismente.length} avertismente:`);
    avertismente.forEach((a) => console.log('  ' + a));
  }
  console.log(`\nUrmatorul pas: node index.js preturi ${proiectId}`);
}

function comandaPreturi(args) {
  const proiectId = Number(args[0]);
  if (!proiectId) { console.error('Da id-ul proiectului.'); process.exit(1); }
  const cale = args[1] || caleProiect(proiectId, 'preturi.xlsx');
  const n = preturi.exportaPreturiExcel(proiectId, cale);
  console.log(`Exportate ${n} resurse in:\n  ${cale}`);
  console.log(`\nCompleteaza coloana "Pret unitar", apoi:\n  node index.js incarca-preturi ${cale}`);
}

function comandaIncarcaPreturi(args) {
  const cale = args[0];
  if (!cale || !fs.existsSync(cale)) { console.error('Da calea catre fisierul de preturi (exportat cu "preturi").'); process.exit(1); }
  const { salvate, ignorate } = preturi.incarcaPreturiExcel(cale);
  console.log(`Salvate ${salvate} preturi in cache-ul global. ${ignorate} randuri ignorate (fara pret completat).`);
}

function comandaExport(args) {
  const proiectId = Number(args[0]);
  if (!proiectId) { console.error('Da id-ul proiectului.'); process.exit(1); }
  const proiect = db.proiectDupaId(proiectId);
  if (!proiect) { console.error(`Proiect inexistent: ${proiectId}`); process.exit(1); }
  const cale = args[1] || caleProiect(proiectId, `deviz-${slug(proiect.nume)}.xlsx`);
  try {
    const { avertismente } = deviz.exportaDevizExcel(proiectId, cale);
    console.log(`Deviz exportat:\n  ${cale}`);
    if (avertismente.length) console.log(`\n${avertismente.length} avertismente -- vezi foaia "Avertismente" din fisier.`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

function comandaProiecte() {
  const proiecte = db.toateProiectele();
  if (!proiecte.length) { console.log('Niciun proiect inca. Incepe cu "incarca".'); return; }
  for (const p of proiecte) {
    console.log(`#${p.id}  ${p.nume.padEnd(40)} [${p.stare}]  ${p.creat_la}`);
  }
}

async function main() {
  const [comanda, ...args] = process.argv.slice(2);
  db.deschide(OUTPUT_DIR);

  switch (comanda) {
    case 'incarca': return comandaIncarca(args);
    case 'revizuieste': return comandaRevizuieste(args);
    case 'genereaza': return comandaGenereaza(args);
    case 'preturi': return comandaPreturi(args);
    case 'incarca-preturi': return comandaIncarcaPreturi(args);
    case 'export': return comandaExport(args);
    case 'proiecte': return comandaProiecte();
    default:
      console.log(`Comenzi disponibile:
  incarca <fisier> --proiect "Nume"    incarca o antemasuratoare (Excel/PDF/Word)
  revizuieste <proiectId>              revizuieste liniile nesigure/nepotrivite
  genereaza <proiectId>                descompune liniile confirmate in resurse
  preturi <proiectId> [cale.xlsx]      exporta lista de resurse pentru pretuire
  incarca-preturi <cale.xlsx>          reincarca preturile completate
  export <proiectId> [cale.xlsx]       genereaza devizul final
  proiecte                             lista proiectelor existente`);
  }
}

module.exports = { main };
