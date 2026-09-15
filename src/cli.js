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
const dosarLicitatie = require('./dosarLicitatie');
const documenteServer = require('./documenteServer');
const { slug } = require('./util');

const OUTPUT_DIR = path.join(__dirname, '..', 'output');

function caleProiect(proiectId, ...parti) {
  return path.join(OUTPUT_DIR, 'proiecte', String(proiectId), ...parti);
}

// Clasele chiar consumate mai departe (importa-licitatie/predefineste) --
// un dosar local FARA NICIUNA din astea (ex. doar analiza.json/analiza.html
// de la analiza GO/NO-GO, fara documentele PT propriu-zise) nu e util,
// indiferent ca folderul exista pe disc. Gasire reala (12.09.2026,
// SCN1179715): dosarul local exista (licitatia a fost analizata GO/NO-GO),
// dar contine DOAR analiza -- niciun document PT -- si vechea verificare
// (doar fs.existsSync) alegea gresit calea locala, gasea 0 documente utile,
// si esua cu "nimic de importat" in loc sa incerce sursa server, unde
// documentele chiar exista.
const CLASE_RELEVANTE = ['liste_cantitati', 'caiet_sarcini', 'fisa_date', 'clarificari'];

// Clasele carora li se aplica selectia explicita de la Pasul 2 (panoul
// Participare, licitatie-analiza) -- vezi aplicaSelectieDocumente. Celelalte
// (caiet_sarcini/fisa_date/clarificari) raman NEATINSE, indiferent de
// selectie -- ele nu fac parte din mecanismul de bifare (intotdeauna toate,
// ca la scopProiect.js).
const CLASE_FILTRATE_PRIN_SELECTIE = ['liste_cantitati', 'desene'];

/**
 * Restrange peClasa[clasa] (pt clasele din CLASE_FILTRATE_PRIN_SELECTIE) la
 * documentele bifate explicit la Pasul 2, DACA exista o selectie ne-goala --
 * vezi documenteServer.selectiaDocumentelor (fail-open: null/eroare de retea
 * -> nicio filtrare, comportamentul de azi). O selectie GOALA (dosar gol pe
 * partea licitatie-analiza) e tratata identic cu "nicio selectie" -- nu
 * blocheaza importul pentru licitatii unde Cristian n-a ajuns inca la pasul
 * de bifare (implicitul de pe partea lor e oricum liste_cantitati+desene,
 * vezi panou.js:calculeazaPasul2 -- gol inseamna genuine "dosar gol", nu
 * "nimeni n-a bifat inca").
 */
async function aplicaSelectieDocumente(peClasa, idLicitatie, avertismente) {
  const selectie = await documenteServer.selectiaDocumentelor(idLicitatie);
  if (!selectie || !selectie.documente.length) return peClasa;

  const numeSelectate = new Set(selectie.documente.map((d) => d.nume));
  const provenienta = selectie.salvatDe ? `bifat de ${selectie.salvatDe}` : 'implicit, nesalvat inca la Pasul 2';
  for (const clasa of CLASE_FILTRATE_PRIN_SELECTIE) {
    if (!peClasa[clasa]?.length) continue; // eslint-disable-line no-continue
    const inainte = peClasa[clasa].length;
    peClasa[clasa] = peClasa[clasa].filter((d) => numeSelectate.has(d.nume));
    if (peClasa[clasa].length !== inainte) {
      avertismente.push(`${clasa}: ${peClasa[clasa].length}/${inainte} documente pastrate, dupa selectia din panoul Participare (${provenienta}).`);
    }
  }
  return peClasa;
}

/**
 * Documentele unei licitatii (grupate pe clasa, vezi dosarLicitatie.js),
 * indiferent daca au fost deja descarcate in licitatie-analiza (analiza
 * GO/NO-GO facuta) sau exista doar in mirror-ul SharePoint sincronizat pe
 * server (licitatii "IN LUCRU pentru depunere", fara dosar local aici --
 * cazul comun, verificat pe SCN1179408). Local intai (gratuit, fara retea) --
 * DAR doar daca dosarul local chiar are macar un document dintr-o clasa
 * relevanta; server oricand local nu exista SAU nu are nimic util -- clar
 * semnalat de fiecare data care sursa a fost folosita, niciodata ghicit tacut.
 * Selectia de la Pasul 2 (aplicaSelectieDocumente) se aplica LA FEL,
 * indiferent de sursa -- selectia e o proprietate a licitatiei, nu a felului
 * in care noi am ajuns la fisierele ei.
 * @param {string} idLicitatie
 * @param {string[]} avertismente
 * @returns {Promise<Object<string, Array<{nume, cale, clasa}>>>}
 * @throws {Error} daca nici local, nici pe server nu se gaseste nimic.
 */
async function gasesteDocumenteLicitatie(idLicitatie, avertismente) {
  let peClasa;
  const dirLicitatieAnaliza = process.env.LICITATIE_ANALIZA_DIR;
  if (dirLicitatieAnaliza) {
    const caleDosar = path.join(dirLicitatieAnaliza, 'dosare', idLicitatie);
    if (fs.existsSync(caleDosar)) {
      const peClasaLocal = dosarLicitatie.documenteDinDosar(caleDosar);
      const areCevaRelevant = CLASE_RELEVANTE.some((c) => (peClasaLocal[c] || []).length > 0);
      if (areCevaRelevant) {
        console.log(`Dosar local gasit (licitatie-analiza): ${caleDosar}`);
        peClasa = peClasaLocal;
      } else {
        console.log(`Dosar local gasit (${caleDosar}), dar fara niciun document relevant (probabil doar analiza GO/NO-GO) -- incerc sursa server...`);
      }
    }
  }
  if (!peClasa) {
    console.log(`Niciun dosar local util pentru ${idLicitatie} -- incerc sursa server (SharePoint sync, prin Core API)...`);
    const dirDescarcare = path.join(OUTPUT_DIR, '_documente-server', idLicitatie);
    peClasa = await documenteServer.documenteDinServer(idLicitatie, dirDescarcare, avertismente);
  }
  return aplicaSelectieDocumente(peClasa, idLicitatie, avertismente);
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

  // NU process.exit() aici -- proceseazaIncarcare e apelata si din
  // importaLicitatieAutomat (deci din procesul LUNG-VIU al lui panou.js,
  // nu doar din CLI-ul de o singura rulare). Un process.exit() de aici
  // omoara tot serviciul web, nu doar cererea curenta -- gasit real
  // 15.09.2026: SCN1177707 (0 linii gasite in document) a crapat
  // devize-auto-panou de 5 ori la rand, systemd l-a tot repornit, fiecare
  // apel extern a vazut "fetch failed" in loc de un raspuns de eroare
  // curat. Aruncam Error in schimb -- main() din index.js (CLI) o prinde
  // si oricum face process.exit(1), comportament CLI neschimbat; panou.js
  // (web) o prinde in try/catch si raspunde 422, fara sa cada.
  if (!fisier || !fs.existsSync(fisier)) {
    throw new Error('Da calea catre fisier (Excel/PDF/Word).');
  }

  const avertismente = [];
  console.log(`Extrag text din ${path.basename(fisier)}...`);
  const text = await extract.textDinFisier({ nume: path.basename(fisier), cale: fisier }, avertismente);
  if (!text) {
    throw new Error(['N-am putut extrage text din fisier.', ...avertismente].join(' '));
  }

  console.log('Extrag liniile (Claude)...');
  const linii = await antemasuratoare.extrageLiniiAntemasuratoare(text, avertismente);
  if (!linii.length) {
    throw new Error('Nicio linie gasita in document.');
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

  // Aceeasi poarta ca in panou.js (web) -- vezi db.verificariBlocanteExport.
  if (!args.includes('--forteaza')) {
    const { completitudine, cantitati } = db.verificariBlocanteExport(proiectId);
    if (completitudine.length || cantitati.length) {
      console.error(`Exportul e blocat -- ${completitudine.length} activitati lipsa/partiale, ${cantitati.length} cantitati insuficiente/fara corespondent:`);
      completitudine.forEach((v) => console.error(`  [completitudine/${v.stare}] ${v.activitate} -- ${v.detaliu || ''}`));
      cantitati.forEach((v) => console.error(`  [cantitati/${v.stare}] ${v.activitate} -- ${v.motiv || ''}`));
      console.error('\nRezolva-le, sau exporta oricum cu: --forteaza');
      process.exit(1);
    }
  }

  const pozitionale = args.filter((a) => !a.startsWith('--'));
  const cale = pozitionale[1] || caleProiect(proiectId, `deviz-${slug(proiect.nume)}.xlsx`);
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
  const nume = idxNume >= 0 ? args[idxNume + 1] : undefined;
  if (!idLicitatie) { console.error('Da id-ul licitatiei (ex. SCN1177636).'); process.exit(1); }

  let rezultat;
  try {
    rezultat = await importaLicitatieAutomat(idLicitatie, nume);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  if (rezultat.avertismenteDocumente.length) rezultat.avertismenteDocumente.forEach((a) => console.log(`⚠️  ${a}`));
  console.log(`Documente gasite in dosarul ${idLicitatie}:`);
  for (const [clasa, docs] of Object.entries(rezultat.peClasa)) {
    console.log(`  ${clasa}: ${docs.map((d) => d.nume).join(', ')}`);
  }

  console.log(`\nProiect #${rezultat.proiectId} creat.`);
  if (rezultat.scop) {
    console.log(`\nProdus: ${rezultat.scop.produs}`);
    console.log(`Nivel de livrare: ${rezultat.scop.nivelLivrare}`);
    console.log(`${rezultat.scop.activitatiCount} activitati extrase din documentatie.`);
  }
  if (rezultat.avertismenteScop.length) {
    console.log('\nAvertismente:');
    rezultat.avertismenteScop.forEach((a) => console.log('  ' + a));
  }
  console.log(`\nUrmatorul pas: node index.js verifica-completitudine ${rezultat.proiectId}`);
}

/**
 * Miezul comenzii "importa-licitatie", extras ca functie reutilizabila --
 * apelata si de comandaImportaLicitatie (CLI, mai sus) si de ruta HTTP
 * POST /api/proiecte/importa-licitatie (panou.js), cerut de Orchestrator
 * (14.09.2026): dispecerizarea lui presupunea mereu un proiect deja creat
 * manual pe un cod de licitatie -- pentru un cod nou, netestat, /api/
 * plan-executie dadea mereu 404, la infinit, niciun mecanism nu crea
 * proiectul singur.
 *
 * NU face console.log/process.exit -- arunca Error pe esec (documente
 * negasite, nicio lista de cantitati etc.), apelantul decide cum
 * raporteaza. Extragerea scopului ramane BEST-EFFORT (nu arunca daca
 * lipseste documentatia de scop) -- proiectul tot se creeaza, doar
 * "verifica-completitudine" nu va functiona pana nu se completeaza manual,
 * exact ca la fluxul CLI de dinainte.
 * @param {string} idLicitatie
 * @param {string} [numeProiect]
 * @returns {Promise<{proiectId, peClasa, avertismenteDocumente:string[], scop:{produs,nivelLivrare,activitatiCount}|null, avertismenteScop:string[]}>}
 */
async function importaLicitatieAutomat(idLicitatie, numeProiect) {
  if (!idLicitatie) throw new Error('Da id-ul licitatiei (ex. SCN1177636).');
  const nume = numeProiect || `Licitatie ${idLicitatie}`;

  const avertismenteDocumente = [];
  const peClasa = await gasesteDocumenteLicitatie(idLicitatie, avertismenteDocumente);

  const listeCantitati = peClasa.liste_cantitati || [];
  if (!listeCantitati.length) {
    throw new Error(`Niciun document clasificat ca "liste_cantitati" (deviz/antemasuratoare) in dosarul ${idLicitatie} -- nimic de importat.`);
  }
  if (listeCantitati.length > 1) {
    avertismenteDocumente.push(`${listeCantitati.length} documente "liste_cantitati" gasite -- import doar primul (${listeCantitati[0].nume}). Restul, de importat manual daca e cazul.`);
  }

  const proiectId = await proceseazaIncarcare([listeCantitati[0].cale, '--proiect', nume], matching.alegeMatchCuCod);
  if (!proiectId) throw new Error('Importul antemasuratorii a esuat.');
  db.seteazaCodLicitatie(proiectId, idLicitatie);

  const avertismenteScop = [];
  let scop = null;
  const { documente: documenteScop, text: textScop } = await asambleazaTextScop(peClasa, avertismenteScop);
  if (!documenteScop.length) {
    avertismenteScop.push('Niciun caiet de sarcini/fisa de date/clarificare gasit -- scopul proiectului NU a fost extras, "verifica-completitudine" nu va functiona pana nu-l completezi manual.');
  } else if (!textScop.trim()) {
    avertismenteScop.push('N-am putut extrage text din niciun document de scop -- verifica manual.');
  } else {
    const scopProiect = require('./scopProiect');
    const scopExtras = await scopProiect.extrageScopProiect(textScop, avertismenteScop);
    db.actualizeazaScopProiect(proiectId, scopExtras);
    scop = { produs: scopExtras.produs, nivelLivrare: scopExtras.nivel_livrare, activitatiCount: scopExtras.activitati.length };
  }

  return {
    proiectId, peClasa, avertismenteDocumente, scop, avertismenteScop,
  };
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

  const avertismente = [];
  let peClasa;
  try {
    peClasa = await gasesteDocumenteLicitatie(idLicitatie, avertismente);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  console.log(`Documente gasite in dosarul ${idLicitatie}:`);
  for (const [clasa, docs] of Object.entries(peClasa)) {
    console.log(`  ${clasa}: ${docs.map((d) => d.nume).join(', ')}`);
  }

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
  db.seteazaCodLicitatie(proiectId, idLicitatie);
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

/**
 * Robot A+B+C+D (vezi src/verificareCantitatiPT.js) -- verifica daca
 * CANTITATILE din deviz ajung fata de Proiectul Tehnic, nu doar daca
 * activitatile exista (asta face deja "verifica-completitudine"). Robotul B
 * (vedere, per pagina de desen) e costisitor pe documente mari -- arata un
 * estimat REAL (dintr-o pagina-esantion, nu o cifra inventata) si cere
 * confirmare explicita inainte sa proceseze restul paginilor.
 */
async function comandaVerificaCantitatiPT(args) {
  const proiectId = Number(args[0]);
  if (!proiectId) { console.error('Da id-ul proiectului.'); process.exit(1); }

  const proiect = db.proiectDupaId(proiectId);
  if (!proiect) { console.error(`Proiect inexistent: ${proiectId}`); process.exit(1); }
  if (!proiect.cod_licitatie) {
    console.error(`Proiectul ${proiectId} n-are cod de licitatie asociat (proiecte.cod_licitatie) -- `
      + 'necesar ca sa gaseasca documentele Proiectului Tehnic. Proiectele create prin '
      + '"importa-licitatie"/"predefineste" de-acum incolo il au automat.');
    process.exit(1);
  }

  const verificareCantitatiPT = require('./verificareCantitatiPT');
  const avertismente = [];

  console.log(`Caut documentele Proiectului Tehnic pentru ${proiect.cod_licitatie}...`);
  const { documenteText, documenteDesenate } = await verificareCantitatiPT.gasesteDocumentePT(proiect.cod_licitatie, avertismente);
  console.log(`  ${documenteText.length} document(e) cu piese scrise, ${documenteDesenate.length} document(e) cu piese desenate.`);

  console.log('\nRulez Robotul A (cantitati din piese scrise)...');
  const cantitatiText = await verificareCantitatiPT.ruleazaRobotA(documenteText, avertismente);
  console.log(`  ${cantitatiText.length} cantitati gasite.`);

  let cantitatiDesen = [];
  if (documenteDesenate.length) {
    console.log('\nEstimez costul Robotului B (o pagina reala, esantion)...');
    const { esantion, paginiTotale, costEstimatTotal } = await verificareCantitatiPT.estimeazaCostRobotB(documenteDesenate, avertismente);
    if (!paginiTotale) {
      console.log('  Niciun document desenat cu pagini de procesat.');
    } else {
      console.log(`  Esantion (${esantion.document}, pagina 1): cost real $${esantion.costUsd ?? 'necunoscut'}.`);
      console.log(`  Total de procesat: ${paginiTotale} pagini${costEstimatTotal != null ? ` -- estimat ~$${costEstimatTotal}` : ' (estimat de cost indisponibil)'}.`);

      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const raspuns = (await new Promise((res) => rl.question('  Continui cu restul paginilor? (da/nu): ', res))).trim().toLowerCase();
      rl.close();
      if (raspuns === 'da' || raspuns === 'd' || raspuns === 'y' || raspuns === 'yes') {
        console.log('\nRulez Robotul B (restul paginilor)...');
        const restul = await verificareCantitatiPT.ruleazaRobotB(documenteDesenate, avertismente, { sarePagina1Din: esantion.document });
        cantitatiDesen = [...esantion.cantitati, ...restul];
      } else {
        console.log('  Sarit -- rulez doar cu esantionul (pagina 1).');
        cantitatiDesen = esantion.cantitati;
        avertismente.push(`Robotul B a rulat doar pe pagina-esantion (${esantion.document}, pagina 1) -- restul de ${paginiTotale - 1} pagini n-a fost procesat (sarit de utilizator).`);
      }
    }
  } else {
    console.log('\nNiciun document cu piese desenate -- Robotul B sarit.');
  }
  console.log(`  ${cantitatiDesen.length} cantitati gasite din piese desenate.`);

  console.log('\nReconciliez (Robot C) si compar cu devizul (Robot D)...');
  const { comparatii, deVerificatManual } = await verificareCantitatiPT.reconciliazaSiCompara(proiectId, cantitatiText, cantitatiDesen, avertismente);

  const suficiente = comparatii.filter((c) => c.stare === 'suficienta');
  const insuficiente = comparatii.filter((c) => c.stare === 'insuficienta');
  const faraCorespondent = comparatii.filter((c) => c.stare === 'fara_corespondent');
  console.log(`\n${suficiente.length} suficiente, ${insuficiente.length} insuficiente, ${faraCorespondent.length} fara corespondent in deviz (din ${comparatii.length} activitati cu cantitate-tinta).\n`);

  if (insuficiente.length) {
    console.log('CANTITATE INSUFICIENTA:');
    insuficiente.forEach((c) => console.log(`  ✖ ${c.activitate} -- tinta ${c.cantitateTinta} ${c.unitateTinta}, in deviz ${c.cantitateDeviz} (${c.motiv})`));
  }
  if (faraCorespondent.length) {
    console.log('\nFARA CORESPONDENT in deviz:');
    faraCorespondent.forEach((c) => console.log(`  ? ${c.activitate} -- tinta ${c.cantitateTinta} ${c.unitateTinta}`));
  }
  if (deVerificatManual.length) {
    console.log('\nDE VERIFICAT MANUAL (unitati incompatibile intre text si desen):');
    deVerificatManual.forEach((r) => console.log(`  ⚠ ${r.activitate} -- ${r.motivManual}`));
  }
  if (avertismente.length) {
    console.log('\nAvertismente:');
    avertismente.forEach((a) => console.log('  ' + a));
  }
}

/** Importa preturi reale din devize vechi CASTIGATOARE (C6/C7/C8/C9 --
 * materiale/manopera/utilaj/transport), intr-un folder dat, recursiv. Vezi
 * src/istoricDevize.js -- scrie DOAR in istoric_preturi (aditiv), nu
 * atinge preturi_curente/nomenclator_articole. */
function comandaImportaPreturiIstorice(args) {
  const dirRadacina = args.find((a) => !a.startsWith('--'));
  if (!dirRadacina || !fs.existsSync(dirRadacina)) {
    console.error('Da folderul cu devize vechi (recursiv, .xlsx F1/F2cp/F3/C6-C9).');
    process.exit(1);
  }
  const istoricDevize = require('./istoricDevize');
  const t0 = Date.now();
  const stare = istoricDevize.importaPreturiIstorice(dirRadacina);
  const durata = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`Durata: ${durata}s`);
  console.log(`Fisiere C6/C7/C8/C9 procesate: ${stare.fisiereProcesate}`);
  console.log(`Randuri de resurse gasite: ${stare.randuriGasite}`);
  console.log(`  potrivite exact in nomenclator: ${stare.potriviteExact}`);
  console.log(`  rezolvate prin contextul formularului (C7=meserie, C6/C8/C9=nu): ${stare.rezolvatePrinContext}`);
  console.log(`  ramase ambiguue (istoric_ambiguu, de verificat manual): ${stare.potriviteAmbiguu}`);
  console.log(`  nepotrivite (cod inexistent in nomenclator): ${stare.nepotrivite}`);
  if (stare.avertismente.length) {
    console.log(`\n${stare.avertismente.length} avertismente (primele 20):`);
    stare.avertismente.slice(0, 20).forEach((a) => console.log('  - ' + a));
  }
}

/** Importa articolele F3 (cu pret total) din toate proiectele castigatoare
 * disponibile prin Core API (/api/devize-castigate), in istoric_articole_castigate.
 * Sterge-si-reinsereaza -- de rulat din nou dupa ce apar proiecte noi in API. */
async function comandaImportaArticoleIstorice() {
  const istoricArticole = require('./istoricArticole');
  const t0 = Date.now();
  const stare = await istoricArticole.importaArticoleIstorice();
  console.log(`Durata: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`Proiecte procesate: ${stare.proiecteProcesate}`);
  console.log(`Fisiere F3 procesate: ${stare.fisiereProcesate}`);
  console.log(`Articole gasite: ${stare.articoleGasite}`);
  if (stare.avertismente.length) {
    console.log(`\n${stare.avertismente.length} avertismente (primele 20):`);
    stare.avertismente.slice(0, 20).forEach((a) => console.log('  - ' + a));
  }
}

/**
 * Referinte istorice de pret pentru liniile unui proiect -- cauta, pentru
 * fiecare linie de antemasuratoare, cel mai apropiat articol dintr-un deviz
 * VECHI CASTIGATOR (Aiud/Deva/Panciu/Vaslui/Zam, vezi istoricArticole.js).
 * Intai dupa codul de nomenclator (daca linia are unul, de la matching.js --
 * semnalul cel mai de incredere), altfel prin cautare de text (denumire+
 * capitol). NU alege un pret automat -- doar arata cel mai relevant precedent
 * gasit, ca sugestie/validare pentru omul care revizuieste preturile.
 */
function comandaReferinteIstorice(args) {
  const proiectId = Number(args[0]);
  if (!proiectId) { console.error('Da id-ul proiectului.'); process.exit(1); }

  const linii = db.liniiCuRezolutiiPeProiect(proiectId);
  if (!linii.length) { console.error(`Proiectul ${proiectId} n-are nicio linie de antemasuratoare.`); process.exit(1); }

  const istoricArticole = require('./istoricArticole');
  let cuReferinta = 0;

  for (const l of linii) {
    const referinte = istoricArticole.gasesteReferintaIstorica({ denumire: l.denumire, capitol: l.capitol, cod: l.cod }, 3);
    console.log(`\n#${l.ordine} [${l.capitol || 'Nespecificat'}] ${l.denumire} -- ${l.cantitate} ${l.unitate}`);
    if (!referinte.length) {
      console.log('  (nicio referinta istorica gasita)');
      continue; // eslint-disable-line no-continue
    }
    cuReferinta += 1;
    const [celMaiBun] = referinte;
    const potrivireDupaCod = l.cod && celMaiBun.cod === l.cod;
    console.log(`  -> [${celMaiBun.proiect}]${potrivireDupaCod ? ' (cod exact)' : ' (dupa text)'} ${celMaiBun.cod} -- ${celMaiBun.denumire}`);
    console.log(`     pret istoric: ${celMaiBun.pret_unitar} lei/${celMaiBun.unitate || '?'} (sursa: ${celMaiBun.document_sursa})`);
    if (referinte.length > 1) {
      console.log(`     +${referinte.length - 1} alt(e) precedent(e) gasit(e) (${referinte.slice(1).map((r) => r.proiect).join(', ')}).`);
    }
  }

  console.log(`\n${cuReferinta} din ${linii.length} linii au cel putin o referinta istorica gasita.`);
}

/**
 * Plan de executie (WBS, resurse, durate, dependinte, drum critic, curba S,
 * PERT) -- dedus din devizul CURENT al proiectului (linii + descompunere +
 * preturi), vezi planExecutie.js. Instrument ORIENTATIV, nu cere ca toate
 * liniile sa fie confirmate (spre deosebire de "export").
 */
function comandaPlanExecutie(args) {
  const proiectId = Number(args[0]);
  if (!proiectId) { console.error('Da id-ul proiectului.'); process.exit(1); }

  const planExecutie = require('./planExecutie');
  let rezultat;
  try {
    rezultat = planExecutie.construiestePlanExecutie(proiectId);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  console.log(`Durata totala estimata: ${rezultat.durataTotalaZile} zile lucratoare\n`);
  console.log(`Drum critic (${rezultat.drumCritic.length} capitole):`);
  rezultat.drumCritic.forEach((c) => console.log(`  * ${c}`));

  console.log('\nActivitati (WBS):');
  for (const a of rezultat.activitati) {
    const interval = a.esd !== null ? `zilele ${a.esd + 1}-${a.efd}` : 'NEANCORAT (fara faza detectata)';
    console.log(`\n#${a.id} [${a.fazaNume || 'fara faza'}] ${a.capitol}`);
    console.log(`  ${interval}${a.peDrumulCritic ? ' -- PE DRUMUL CRITIC' : ''}`);
    console.log(`  ${a.numarLinii} linii, ${a.oreManopera} ore manopera, durata estimata ${a.durataZile} zile (PERT: ${a.pert.optimist}/${a.pert.realist}/${a.pert.pesimist})`);
    console.log(`  valoare: ${Math.round(a.valoare.total)} lei (materiale ${Math.round(a.valoare.materiale)}, manopera ${Math.round(a.valoare.manopera)}, utilaj ${Math.round(a.valoare.utilaj)}, transport ${Math.round(a.valoare.transport)})`);
  }

  console.log(`\nCurba S -- valoare cumulata la ziua ${rezultat.durataTotalaZile}: ${rezultat.curbaS[rezultat.curbaS.length - 1]?.valoareCumulata || 0} lei`);

  if (rezultat.avertismente.length) {
    console.log(`\n${rezultat.avertismente.length} avertismente:`);
    rezultat.avertismente.forEach((a) => console.log('  - ' + a));
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
    case 'verifica-cantitati-pt': return comandaVerificaCantitatiPT(args);
    case 'importa-preturi-istorice': return comandaImportaPreturiIstorice(args);
    case 'importa-articole-istorice': return comandaImportaArticoleIstorice();
    case 'referinte-istorice': return comandaReferinteIstorice(args);
    case 'plan-executie': return comandaPlanExecutie(args);
    case 'proiecte': return comandaProiecte();
    default:
      console.log(`Comenzi disponibile:
  incarca <fisier> --proiect "Nume"        antemasuratoare LIBERA (Excel/PDF/Word) -- aleg singur articolele din nomenclator
  incarca-deviz <fisier> --proiect "Nume"  deviz DEJA structurat (impus), fara valori -- respecta codurile date, semnaleaza ce nu se leaga
  importa-licitatie <idLicitatie> --proiect "Nume"   importa direct dintr-o licitatie (dosar local licitatie-analiza, sau -- daca nu exista -- direct din server/SharePoint prin Core API)
  predefineste <idLicitatie> --proiect "Nume"        genereaza devizul DE LA ZERO (fara liste_cantitati in dosar) -- din scop + documentatie tehnica (aceeasi sursa dubla ca importa-licitatie)
  verifica-completitudine <proiectId>  verifica daca devizul acopera tot ce cere documentatia licitatiei (dupa importa-licitatie/predefineste)
  verifica-cantitati-pt <proiectId>    verifica daca CANTITATILE din deviz ajung fata de Proiectul Tehnic (Robot A/B/C/D, cere proiecte.cod_licitatie)
  importa-preturi-istorice <folder>    importa preturi reale (C6-C9) din devize vechi CASTIGATOARE, in istoric_preturi
  importa-articole-istorice            importa articolele F3 din devizele castigatoare (prin Core API), in istoric_articole_castigate
  referinte-istorice <proiectId>       cauta, pentru fiecare linie, cel mai apropiat precedent de pret dintr-un deviz vechi castigator (F3)
  plan-executie <proiectId>            WBS + durate + dependinte + drum critic + curba S, dedus din devizul curent
  revizuieste <proiectId>              revizuieste liniile nesigure/nepotrivite
  genereaza <proiectId>                descompune liniile confirmate in resurse
  preturi <proiectId> [cale.xlsx]      exporta lista de resurse pentru pretuire
  incarca-preturi <cale.xlsx>          reincarca preturile completate
  export <proiectId> [cale.xlsx] [--forteaza]   genereaza devizul final (blocat daca sunt verificari completitudine/cantitati nerezolvate, --forteaza ocoleste explicit)
  proiecte                             lista proiectelor existente`);
  }
}

// "gasesteDocumenteLicitatie" e exportata ca sa poata fi refolosita si de
// verificareCantitatiPT.js (Robot A/B/C/D) -- fara sa duplice logica de
// rutare local/server (inclusiv fix-ul CLASE_RELEVANTE de mai sus).
module.exports = { main, gasesteDocumenteLicitatie, importaLicitatieAutomat };
