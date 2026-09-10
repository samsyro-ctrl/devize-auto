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
const bfla = require('./bfla');
const { slug } = require('./util');

const OUTPUT_DIR = path.join(__dirname, '..', 'output');

function caleProiect(proiectId, ...parti) {
  return path.join(OUTPUT_DIR, 'proiecte', String(proiectId), ...parti);
}

/**
 * Comun celor doua fluxuri de incarcare: extrage textul, extrage liniile
 * (AI), creeaza proiectul si ruleaza matching-ul cu functia primita.
 * @param {Function} alegeMatchFn matching.alegeMatch (antemasuratoare libera)
 *   sau matching.alegeMatchCuCod (deviz impus, cu cod posibil dat).
 */
async function proceseazaIncarcare(args, alegeMatchFn) {
  const fisier = args.find((a) => !a.startsWith('--'));
  const idxNume = args.indexOf('--proiect');
  const nume = idxNume >= 0 ? args[idxNume + 1] : (fisier ? path.basename(fisier) : null);

  if (!fisier || !fs.existsSync(fisier)) {
    console.error('Da calea catre fisier (Excel/PDF/Word).');
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

  console.log('Extrag liniile (Claude)...');
  const linii = await antemasuratoare.extrageLiniiAntemasuratoare(text, avertismente);
  if (!linii.length) {
    console.error('Nicio linie gasita in document.');
    process.exit(1);
  }

  const proiectId = db.creeazaProiect(nume, fisier);
  db.insereazaLiniiAntemasuratoare(proiectId, linii);

  const bflaEntries = bfla.ACTIV ? await bfla.cauta({ tip: 'potrivire_articol', limita: 500 }) : [];
  let auto = 0;
  let deRevizuit = 0;
  let faraPotrivire = 0;
  for (const l of db.liniiPeProiect(proiectId)) {
    const rezolutie = alegeMatchFn(l, bflaEntries);
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
  return proiectId;
}

/** Antemasuratoare LIBERA -- nicio structura impusa, aleg singur ce articol
 * din nomenclator reprezinta fiecare linie. */
const comandaIncarca = (args) => proceseazaIncarcare(args, matching.alegeMatch);

/** Deviz DEJA structurat (impus de beneficiar/licitatie), fara valori --
 * daca vine cu propriul cod de nomenclator pe fiecare linie, codul acela
 * are prioritate (vezi matching.alegeMatchCuCod); doar cand lipseste sau
 * nu exista se cade pe cautare libera, semnalat explicit. */
const comandaIncarcaDeviz = (args) => proceseazaIncarcare(args, matching.alegeMatchCuCod);

/** Confirma local (sursa de adevar), apoi scrie in BFLA -- esecul scrierii
 * in BFLA nu trebuie sa strice confirmarea, deja salvata (REGULA DE AUR). */
async function confirmaSiScrieInBfla(linie, ales) {
  db.confirmaRezolutie(linie.id, ales.colectie, ales.cod);
  if (!bfla.ACTIV) return;
  await bfla.scrie({
    tip: 'potrivire_articol',
    cheie: linie.denumire,
    continut: { colectie: ales.colectie, cod: ales.cod },
    validatDe: 'Cristian Samson (CLI)',
    stare: 'HUMAN_VALIDATED',
  });
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
    if (l.cod_dat) console.log(`  cod dat in deviz: ${l.cod_dat}`);
    if (l.nota) console.log(`  ⚠️  ${l.nota}`);
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
      // eslint-disable-next-line no-await-in-loop
      if (ales) await confirmaSiScrieInBfla(l, ales);
      continue;
    }

    const ales = candidati[Number(raspuns) - 1];
    // eslint-disable-next-line no-await-in-loop
    if (ales) await confirmaSiScrieInBfla(l, ales);
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

/**
 * Concateneaza textul caiet de sarcini + fisa de date + clarificari dintr-un
 * dosar deja clasificat (dosarLicitatie.documenteDinDosar) -- acelasi text
 * folosit atat pentru extragerea scopului (scopProiect.js), cat si, la
 * "predefineste", pentru cautarea cantitatilor (generareDeviz.js). Extras
 * intr-un singur loc ca sa nu difere intre cele doua comenzi.
 * @returns {Promise<{documente: Array, text: string}>}
 */
async function asambleazaTextScop(peClasa, avertismente) {
  const documente = [...(peClasa.caiet_sarcini || []), ...(peClasa.fisa_date || []), ...(peClasa.clarificari || [])];
  let text = '';
  for (const d of documente) {
    // eslint-disable-next-line no-await-in-loop
    const t = await extract.textDinFisier({ nume: d.nume, cale: d.cale }, avertismente);
    if (t) text += `\n\n--- ${d.clasa}: ${d.nume} ---\n${t}`;
  }
  return { documente, text };
}

/**
 * Importa antemasuratoarea + scopul proiectului direct dintr-o licitatie
 * urmarita in licitatie-analiza -- gaseste dosarul, clasifica documentele
 * (src/dosarLicitatie.js), importa "liste_cantitati" (flux existent, impus)
 * si extrage scopul din caiet de sarcini/fisa de date/clarificari
 * (src/scopProiect.js), ca "verifica-completitudine" sa aiba fata de ce sa
 * verifice devizul.
 */
async function comandaImportaLicitatie(args) {
  const idLicitatie = args.find((a) => !a.startsWith('--'));
  const idxNume = args.indexOf('--proiect');
  const nume = idxNume >= 0 ? args[idxNume + 1] : (idLicitatie ? `Licitatie ${idLicitatie}` : null);
  if (!idLicitatie) { console.error('Da id-ul licitatiei (ex. SCN1177636).'); process.exit(1); }

  const dirLicitatieAnaliza = process.env.LICITATIE_ANALIZA_DIR;
  if (!dirLicitatieAnaliza) { console.error('Lipseste LICITATIE_ANALIZA_DIR in .env.'); process.exit(1); }
  const caleDosar = path.join(dirLicitatieAnaliza, 'dosare', idLicitatie);

  const dosarLicitatie = require('./dosarLicitatie');
  let peClasa;
  try {
    peClasa = dosarLicitatie.documenteDinDosar(caleDosar);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  console.log(`Documente gasite in dosarul ${idLicitatie}:`);
  for (const [clasa, docs] of Object.entries(peClasa)) {
    console.log(`  ${clasa}: ${docs.map((d) => d.nume).join(', ')}`);
  }

  const listeCantitati = peClasa.liste_cantitati || [];
  if (!listeCantitati.length) {
    console.error('\nNiciun document clasificat ca "liste_cantitati" (deviz/antemasuratoare) in acest dosar -- nimic de importat.');
    process.exit(1);
  }
  if (listeCantitati.length > 1) {
    console.log(`\n⚠️  ${listeCantitati.length} documente "liste_cantitati" gasite -- import doar primul (${listeCantitati[0].nume}). Restul, de importat manual daca e cazul.`);
  }

  console.log(`\nImport antemasuratoare din: ${listeCantitati[0].nume}`);
  const proiectId = await proceseazaIncarcare([listeCantitati[0].cale, '--proiect', nume], matching.alegeMatchCuCod);
  if (!proiectId) { console.error('Importul antemasuratorii a esuat.'); process.exit(1); }

  const avertismenteScop = [];
  const { documente: documenteScop, text: textScop } = await asambleazaTextScop(peClasa, avertismenteScop);
  if (!documenteScop.length) {
    console.log('\n⚠️  Niciun caiet de sarcini/fisa de date/clarificare gasit -- scopul proiectului NU a fost extras, "verifica-completitudine" nu va functiona pana nu-l completezi manual.');
    return;
  }
  console.log(`\nExtrag scopul proiectului din ${documenteScop.length} documente (${documenteScop.map((d) => d.nume).join(', ')})...`);
  if (!textScop.trim()) {
    console.log('⚠️  N-am putut extrage text din niciun document de scop -- verifica manual.');
    if (avertismenteScop.length) avertismenteScop.forEach((a) => console.log('  ' + a));
    return;
  }

  const scopProiect = require('./scopProiect');
  const scop = await scopProiect.extrageScopProiect(textScop, avertismenteScop);
  db.actualizeazaScopProiect(proiectId, scop);

  console.log(`\nProdus: ${scop.produs}`);
  console.log(`Nivel de livrare: ${scop.nivel_livrare}`);
  console.log(`${scop.activitati.length} activitati extrase din documentatie.`);
  if (avertismenteScop.length) {
    console.log('\nAvertismente:');
    avertismenteScop.forEach((a) => console.log('  ' + a));
  }
  console.log(`\nUrmatorul pas: node index.js verifica-completitudine ${proiectId}`);
}

/**
 * "Devize predefinite": genereaza liniile de deviz DE LA ZERO, dintr-o
 * licitatie urmarita in licitatie-analiza care NU are niciun document
 * "liste_cantitati" (spre deosebire de "importa-licitatie") -- ex. contracte
 * proiectare+executie, unde ofertantul isi face singur devizul. Vezi
 * src/generareDeviz.js pentru cei doi pasi (descompunere activitati + cautare
 * cantitati in documentatie).
 */
async function comandaPredefineste(args) {
  const idLicitatie = args.find((a) => !a.startsWith('--'));
  const idxNume = args.indexOf('--proiect');
  const nume = idxNume >= 0 ? args[idxNume + 1] : (idLicitatie ? `Licitatie ${idLicitatie}` : null);
  if (!idLicitatie) { console.error('Da id-ul licitatiei (ex. SCN1177636).'); process.exit(1); }

  const dirLicitatieAnaliza = process.env.LICITATIE_ANALIZA_DIR;
  if (!dirLicitatieAnaliza) { console.error('Lipseste LICITATIE_ANALIZA_DIR in .env.'); process.exit(1); }
  const caleDosar = path.join(dirLicitatieAnaliza, 'dosare', idLicitatie);

  const dosarLicitatie = require('./dosarLicitatie');
  let peClasa;
  try {
    peClasa = dosarLicitatie.documenteDinDosar(caleDosar);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  console.log(`Documente gasite in dosarul ${idLicitatie}:`);
  for (const [clasa, docs] of Object.entries(peClasa)) {
    console.log(`  ${clasa}: ${docs.map((d) => d.nume).join(', ')}`);
  }

  const avertismente = [];
  const { documente: documenteScop, text: textScop } = await asambleazaTextScop(peClasa, avertismente);
  if (!documenteScop.length || !textScop.trim()) {
    console.error('\nNiciun caiet de sarcini/fisa de date/clarificare citibil in acest dosar -- fara documentatie tehnica nu se poate genera nimic.');
    process.exit(1);
  }

  console.log(`\nExtrag scopul proiectului din ${documenteScop.length} documente (${documenteScop.map((d) => d.nume).join(', ')})...`);
  const scopProiect = require('./scopProiect');
  const scop = await scopProiect.extrageScopProiect(textScop, avertismente);
  console.log(`Produs: ${scop.produs}`);
  console.log(`Nivel de livrare: ${scop.nivel_livrare}`);
  console.log(`${scop.activitati.length} activitati extrase din documentatie.`);
  if (!scop.activitati.length) {
    console.error('\nNicio activitate extrasa -- nimic de generat.');
    process.exit(1);
  }

  console.log('\nGenerez pozitii de deviz din activitati (Claude)...');
  const generareDeviz = require('./generareDeviz');
  const linii = await generareDeviz.genereazaLiniiPredefinite(scop, textScop, avertismente);
  if (!linii.length) {
    console.error('Nicio pozitie generata.');
    avertismente.forEach((a) => console.error('  ' + a));
    process.exit(1);
  }

  const proiectId = db.creeazaProiect(nume, `predefinit din ${idLicitatie}`);
  db.insereazaLiniiAntemasuratoare(proiectId, linii);
  db.actualizeazaScopProiect(proiectId, scop);

  const bflaEntries = bfla.ACTIV ? await bfla.cauta({ tip: 'potrivire_articol', limita: 500 }) : [];
  let auto = 0; let deRevizuit = 0; let faraPotrivire = 0;
  for (const l of db.liniiPeProiect(proiectId)) {
    const rezolutie = matching.alegeMatch(l, bflaEntries);
    db.salveazaRezolutie(l.id, rezolutie);
    if (rezolutie.stare === 'auto') auto++;
    else if (rezolutie.stare === 'fara_potrivire') faraPotrivire++;
    else deRevizuit++;
  }
  db.actualizeazaStareProiect(proiectId, 'matching');

  const faraCantitate = linii.filter((l) => l.cantitateNecunoscuta).length;
  console.log(`\n${linii.length} pozitii generate -- ${auto} auto-potrivite, ${deRevizuit} de revizuit, ${faraPotrivire} fara potrivire in nomenclator.`);
  console.log(`${faraCantitate} din ${linii.length} pozitii n-au cantitate gasita in documentatie -- de completat manual (proiectDupaId ${proiectId}, tabel antemasuratoare_linii) inainte sa se poata genera devizul.`);
  if (avertismente.length) {
    console.log('\nAvertismente:');
    avertismente.forEach((a) => console.log('  ' + a));
  }
  console.log(`\nProiect creat: #${proiectId}. Urmatorul pas: node index.js revizuieste ${proiectId}`);
}

/** Verifica daca devizul (deja generat) acopera toate activitatile cerute de
 * documentatia licitatiei -- vezi src/completitudine.js. */
async function comandaVerificaCompletitudine(args) {
  const proiectId = Number(args[0]);
  if (!proiectId) { console.error('Da id-ul proiectului.'); process.exit(1); }

  const completitudine = require('./completitudine');
  let rezultat;
  try {
    rezultat = await completitudine.verificaCompletitudine(proiectId);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  console.log(`Produs: ${rezultat.produs}`);
  console.log(`Nivel de livrare: ${rezultat.nivel_livrare}\n`);

  const acoperite = rezultat.verificari.filter((v) => v.stare === 'acoperita');
  const partiale = rezultat.verificari.filter((v) => v.stare === 'partial');
  const lipsa = rezultat.verificari.filter((v) => v.stare === 'lipsa');
  console.log(`${acoperite.length} acoperite, ${partiale.length} partiale, ${lipsa.length} lipsa (din ${rezultat.verificari.length} activitati).\n`);

  if (lipsa.length) {
    console.log('LIPSA din deviz:');
    lipsa.forEach((v) => console.log(`  ✖ ${v.activitate}\n    ${v.detaliu}`));
  }
  if (partiale.length) {
    console.log('\nPARTIALE:');
    partiale.forEach((v) => console.log(`  ~ ${v.activitate}\n    ${v.detaliu}`));
  }
  if (rezultat.avertismente.length) {
    console.log('\nAvertismente:');
    rezultat.avertismente.forEach((a) => console.log('  ' + a));
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
    case 'incarca-deviz': return comandaIncarcaDeviz(args);
    case 'revizuieste': return comandaRevizuieste(args);
    case 'genereaza': return comandaGenereaza(args);
    case 'preturi': return comandaPreturi(args);
    case 'incarca-preturi': return comandaIncarcaPreturi(args);
    case 'export': return comandaExport(args);
    case 'importa-licitatie': return comandaImportaLicitatie(args);
    case 'predefineste': return comandaPredefineste(args);
    case 'verifica-completitudine': return comandaVerificaCompletitudine(args);
    case 'proiecte': return comandaProiecte();
    default:
      console.log(`Comenzi disponibile:
  incarca <fisier> --proiect "Nume"        antemasuratoare LIBERA (Excel/PDF/Word) -- aleg singur articolele din nomenclator
  incarca-deviz <fisier> --proiect "Nume"  deviz DEJA structurat (impus), fara valori -- respecta codurile date, semnaleaza ce nu se leaga
  importa-licitatie <idLicitatie> --proiect "Nume"   importa direct dintr-o licitatie urmarita in licitatie-analiza (antemasuratoare + scop)
  predefineste <idLicitatie> --proiect "Nume"        genereaza devizul DE LA ZERO (fara liste_cantitati in dosar) -- din scop + documentatie tehnica
  verifica-completitudine <proiectId>  verifica daca devizul acopera tot ce cere documentatia licitatiei (dupa importa-licitatie/predefineste)
  revizuieste <proiectId>              revizuieste liniile nesigure/nepotrivite
  genereaza <proiectId>                descompune liniile confirmate in resurse
  preturi <proiectId> [cale.xlsx]      exporta lista de resurse pentru pretuire
  incarca-preturi <cale.xlsx>          reincarca preturile completate
  export <proiectId> [cale.xlsx]       genereaza devizul final
  proiecte                             lista proiectelor existente`);
  }
}

module.exports = { main };
