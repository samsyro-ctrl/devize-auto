// src/istoricDevize.js
// Invatare din devize VECHI CASTIGATOARE (Zam, Vaslui, Panciu, Deva, Aiud --
// RED a castigat licitatiile cu ele) -- formulare oficiale F1/F2cp/F3/C6-C9
// (HG 907/2016), dezarhivate separat de sesiunea "Server" la
// /root/scratch/extras-proiecte-vechi/. Confirmat manual (11.09.2026) ca
// toate cele 5 proiecte respecta acelasi format, verificat pe ZAM/DEVA/VASLUI.
//
// Scop v1: DOAR pretul (C6/C7/C8/C9 -- liste de resurse materiale/manopera/
// utilaj/transport, cu cod+denumire+pret unitar REAL, din oferte castigatoare).
// Structura F1/F2cp/F3 (ierarhia oficiala completa a devizului) e clasificata
// aici (parseazaFisier), dar NU se extrag randuri din ea -- ramane un task
// separat, viitor ("export in format oficial complet"), nu parte din
// calibrarea de pret.
//
// Preturile gasite se scriu in istoric_preturi (aditiv, NU in preturi_curente
// -- vezi db.js: "preturi_curente poate fi derivat de-aici, dar asta ramane
// un pas separat, viitor"), cu tipSursa 'CONTRACTED_PRICE' -- pretul la care
// s-a castigat licitatia, nu un pret de piata estimat si nici un cost final
// executat. Fiecare cod se leaga de nomenclator_articole DACA exista un
// articol cu acelasi cod (confirmat manual: codurile chiar coincid intre
// devizele vechi si nomenclator, ex. "2100969 Beton de ciment B250" apare
// identic in ambele) -- fara potrivire, ramane sub colectia speciala
// 'istoric_nematchuit', niciodata inventat sau aruncat la gunoi tacut.
'use strict';

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const db = require('./db');

const TIPURI_FORMULAR = [
  { cheie: 'F1', rx: /-\s*F1\s*-/i },
  { cheie: 'F2cp', rx: /-\s*F2cp\s*-/i },
  { cheie: 'F3', rx: /-\s*F3\s*-/i },
  { cheie: 'C6', rx: /-\s*C6\s*-/i },
  { cheie: 'C7', rx: /-\s*C7\s*-/i },
  { cheie: 'C8', rx: /-\s*C8\s*-/i },
  { cheie: 'C9', rx: /-\s*C9\s*-/i },
];

/** Tipul formularului, dupa numele fisierului (tiparul deja folosit de sesiunea
 * "Server" la dezarhivare: "<nr> - <capitol> - <TIP> - <descriere>.xlsx"). */
function tipFormular(numeFisier) {
  const g = TIPURI_FORMULAR.find((t) => t.rx.test(numeFisier));
  return g ? g.cheie : null;
}

const CLASE_CU_RESURSE = new Set(['C6', 'C7', 'C8', 'C9']);

/** Toate fisierele .xlsx/.xls dintr-un folder, recursiv, cu tipul lor de
 * formular (dupa numele fisierului -- null pt fisiere consolidate, vezi
 * extrageResurseConsolidate mai jos, care le identifica dupa CONTINUT). */
function listeazaFisiere(dirRadacina) {
  const rezultat = [];
  function recurs(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const cale = path.join(dir, e.name);
      if (e.isDirectory()) recurs(cale);
      else if (/\.xlsx?$/i.test(e.name)) {
        rezultat.push({ cale, nume: e.name, tip: tipFormular(e.name) });
      }
    }
  }
  recurs(dirRadacina);
  return rezultat;
}

/** Citeste antetul (OBIECTIV/OBIECTUL/STADIUL FIZIC/Beneficiar/Ofertant etc.)
 * din primele randuri -- eticheta in prima celula nevida, valoarea in
 * urmatoarea celula nevida de pe acelasi rand. Robust la nr. variabil de
 * coloane goale intre ele (merge de celule difera intre fisiere/proiecte). */
const ETICHETE_ANTET = ['OBIECTIV', 'INVESTITIA', 'OBIECTUL', 'STADIUL FIZIC', 'BENEFICIAR', 'PROIECTANT', 'EXECUTANT', 'OFERTANT'];
function citesteAntet(rows) {
  const antet = {};
  for (const r of rows.slice(0, 12)) {
    const prima = String(r[0] || '').trim().replace(/:$/, '').toUpperCase();
    const eticheta = ETICHETE_ANTET.find((e) => prima === e);
    if (!eticheta) continue; // eslint-disable-line no-continue
    const valoare = r.slice(1).find((c) => String(c || '').trim());
    if (valoare) antet[eticheta] = String(valoare).trim();
  }
  return antet;
}

/**
 * Randul de numerotare a coloanelor din formular (ex. C6: "0","1","","","2",
 * "3","4","","5 = 3 x 4","6",...) -- ancora ROBUSTA pentru pozitia reala a
 * fiecarei coloane in foaia de calcul, care difera intre fisiere (celule
 * combinate diferit) dar respecta mereu ACEEASI numerotare oficiala a
 * formularului. Intoarce { '0': idxReal, '1': idxReal, ... }.
 */
function gasesteNumerotareaColoanelor(rows) {
  const randNumerotare = rows.find((r) => String(r[0] || '').trim() === '0');
  if (!randNumerotare) return null;
  const harta = {};
  randNumerotare.forEach((celula, idx) => {
    const m = /^(\d+)/.exec(String(celula || '').trim());
    if (m) harta[m[1]] = idx;
  });
  return { harta, indexRand: rows.indexOf(randNumerotare) };
}

// Ce coloana din formular (dupa numerotarea oficiala) contine ce, per tip --
// vezi comentariile din investigatia initiala (ZAM/DEVA/VASLUI, identice).
const SCHEMA_RESURSE = {
  C6: {
    denumire: '1', cantitate: '3', pretUnitar: '4', unitate: null, furnizor: '6',
  },
  C7: {
    denumire: '1', cantitate: '2', pretUnitar: '3', unitate: null, furnizor: null,
  },
  C8: {
    denumire: '1', cantitate: '2', pretUnitar: '3', unitate: null, furnizor: null,
  },
  C9: {
    denumire: '1', cantitate: null, pretUnitar: '5', unitate: null, furnizor: null,
  },
};
// C6 e singurul cu U.M. explicit -- pe un rand separat, nu in numerotare
// (coloana "2" din antet, vezi "Nr./Denumire//U.M./Consumul/Pret unitar").
// Cautam eticheta "U.M." direct in randul de antet-coloane (cel de dinaintea
// numerotarii), la orice pozitie -- mai robust decat un index fix.
function gasesteColoanaUM(rows, indexNumerotare) {
  for (let i = Math.max(0, indexNumerotare - 2); i < indexNumerotare; i += 1) {
    const idx = (rows[i] || []).findIndex((c) => /^U\.?M\.?$/i.test(String(c || '').trim()));
    if (idx >= 0) return idx;
  }
  return null;
}

function parseNumar(text) {
  const curatat = String(text || '').replace(/[^\d.,-]/g, '').replace(/,/g, '');
  const n = parseFloat(curatat);
  return Number.isFinite(n) ? n : null;
}

/** Separa "cod denumire..." dintr-o singura celula (C6/C7/C8/C9) -- primul
 * grup de caractere fara spatiu e codul, restul e denumirea. */
function separaCodDenumire(text) {
  const curat = String(text || '').trim();
  const m = /^(\S+)\s+(.+)$/.exec(curat);
  if (!m) return { cod: curat || null, denumire: '' };
  return { cod: m[1], denumire: m[2].trim() };
}

const CUVINTE_TERMINALE = /^total\b|^valoare\b|^recapitulatie\b/i;

/**
 * Extrage randurile de resursa dintr-un fisier C6/C7/C8/C9 -- cod, denumire,
 * unitate, cantitate, pret unitar, furnizor (daca exista). Nu incearca sa
 * inteleaga F1/F2cp/F3 -- alt scop (structura, nu pret), vezi comentariul
 * de sus.
 * @returns {Array<{cod, denumire, unitate, cantitate, pretUnitar, furnizor}>}
 */
function extrageResurse(cale, tip) {
  const wb = XLSX.readFile(cale);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
  const numerotare = gasesteNumerotareaColoanelor(rows);
  if (!numerotare) return [];

  const schema = SCHEMA_RESURSE[tip];
  const idxDenumire = numerotare.harta[schema.denumire];
  const idxCantitate = schema.cantitate ? numerotare.harta[schema.cantitate] : null;
  const idxPret = numerotare.harta[schema.pretUnitar];
  const idxFurnizor = schema.furnizor ? numerotare.harta[schema.furnizor] : null;
  const idxUM = tip === 'C6' ? gasesteColoanaUM(rows, numerotare.indexRand) : null;
  if (idxDenumire === undefined || idxPret === undefined) return [];

  const rezultat = [];
  for (let i = numerotare.indexRand + 1; i < rows.length; i += 1) {
    const r = rows[i];
    const primaCelula = String(r[0] || '').trim();
    const denumireBruta = String(r[idxDenumire] || '').trim();
    if (!primaCelula && !denumireBruta) break; // rand complet gol -- capatul tabelului
    if (!/^\d+$/.test(primaCelula)) continue; // eslint-disable-line no-continue -- eticheta de sectiune/total, nu resursa
    if (CUVINTE_TERMINALE.test(denumireBruta)) continue; // eslint-disable-line no-continue

    const { cod, denumire } = separaCodDenumire(denumireBruta);
    const pretUnitar = parseNumar(r[idxPret]);
    if (!cod || pretUnitar === null || pretUnitar <= 0) continue; // eslint-disable-line no-continue

    rezultat.push({
      cod,
      denumire,
      unitate: idxUM !== null ? String(r[idxUM] || '').trim() || null : null,
      cantitate: idxCantitate !== null ? parseNumar(r[idxCantitate]) : null,
      pretUnitar,
      furnizor: idxFurnizor !== null ? (String(r[idxFurnizor] || '').trim() || null) : null,
    });
  }
  return rezultat;
}

const RX_FORMULAR_C = /^formular\s*(c[6-9])\b/i;

/** Separa "cod - denumire" (varianta cu liniuta -- gasita pe workbook-uri
 * CONSOLIDATE, vezi extrageResurseConsolidate) -- diferita de separaCodDenumire
 * (spatiu simplu, fara liniuta), folosita pe fisierele standalone. Acelasi
 * tipar gasit azi la F3 pe aceleasi 3 proiecte (istoricArticole.js). */
function separaCodDenumireCuLiniuta(text) {
  const curat = String(text || '').trim();
  // Denumirea poate continua pe mai multe randuri (descrieri lungi, cu \n
  // incorporat in celula) -- [\s\S]+ (nu .+) ca sa poata traversa newline-uri;
  // gasit real 15.09.2026: fara asta, orice cod cu descriere pe mai multe
  // randuri esua silentios pe fallback (tot textul brut ca "cod", denumire
  // goala) -- cod-ul insusi ramane pe UN singur rand (.+? nu traverseaza \n,
  // corect -- desparte la prima " - " de pe primul rand, unde chiar sta).
  const m = /^(.+?)\s-\s([\s\S]+)$/.exec(curat);
  if (!m) return { cod: curat || null, denumire: '' };
  return { cod: m[1].trim(), denumire: m[2].trim() };
}

/**
 * Extrage resursele C6/C7/C8/C9 dintr-o foaie a unui workbook CONSOLIDAT --
 * layout FIX, fara rand de numerotare dinamica (spre deosebire de fisierele
 * standalone, vezi extrageResurse) -- dar indexul BRUT al coloanei coincide
 * chiar cu numarul oficial din SCHEMA_RESURSE (verificat pe date reale,
 * 15.09.2026, cu formula cantitate x pret = total pe C6/C7/C8, respectiv
 * tone x km x tarif = total pe C9) -- reutilizam SCHEMA_RESURSE neschimbat,
 * doar indexam direct dupa numarul oficial, fara harta dedusa dintr-un rand.
 */
function extrageResurseDinFoaieConsolidate(rows, tip) {
  const schema = SCHEMA_RESURSE[tip];
  const idxDenumire = Number(schema.denumire);
  const idxCantitate = schema.cantitate !== null ? Number(schema.cantitate) : null;
  const idxPret = Number(schema.pretUnitar);
  const idxFurnizor = schema.furnizor !== null ? Number(schema.furnizor) : null;
  // U.M. e coloana proprie DOAR la C6 (index 2, confirmat real) -- la fel ca
  // in formatul standalone (gasesteColoanaUM), C7/C8/C9 n-au U.M. explicit.
  const idxUM = tip === 'C6' ? 2 : null;

  const rezultat = [];
  for (const r of rows) {
    const primaCelula = String(r[0] || '').trim();
    if (!/^\d+$/.test(primaCelula)) continue; // eslint-disable-line no-continue -- titlu formular/footer ("TOTAL Materiale" etc.), nu resursa
    const denumireBruta = String(r[idxDenumire] || '').trim();
    if (!denumireBruta) continue; // eslint-disable-line no-continue

    const { cod, denumire } = separaCodDenumireCuLiniuta(denumireBruta);
    const pretUnitar = parseNumar(r[idxPret]);
    if (!cod || pretUnitar === null || pretUnitar <= 0) continue; // eslint-disable-line no-continue

    rezultat.push({
      cod,
      denumire,
      unitate: idxUM !== null ? (String(r[idxUM] || '').trim() || null) : null,
      cantitate: idxCantitate !== null ? parseNumar(r[idxCantitate]) : null,
      pretUnitar,
      furnizor: idxFurnizor !== null ? (String(r[idxFurnizor] || '').trim() || null) : null,
      tip,
    });
  }
  return rezultat;
}

/**
 * Resursele C6/C7/C8/C9 dintr-un fisier .xls/.xlsx CONSOLIDAT -- un singur
 * workbook cu toate formularele (F1/F2/F3/F4/C6-C9) ca foi separate, gasit
 * real 15.09.2026 pe aceleasi 3 proiecte ca la F3 (COLEGIUL GHEORGHE
 * VRANCEANU BACAU, TRANSPORT PUBLIC ROMAN, TRANSPORT PUBLIC ONESTI).
 *
 * Foile C6-C9 NU se identifica dupa numele fisierului (tipFormular esueaza,
 * de-aia ajunge aici) si NICI dupa numele foii (Excel trunchiaza la 31
 * caractere -- vezi motivatia completa in istoricArticole.js
 * extrageArticoleF3DinFoiConsolidate) -- semnal robust: celula A1 incepe
 * mereu cu "Formular C6"/"C7"/"C8"/"C9".
 * @param {string} cale -- fisier local (deja descarcat/pe disc).
 * @returns {Array<{cod, denumire, unitate, cantitate, pretUnitar, furnizor, tip}>}
 */
function extrageResurseConsolidate(cale) {
  const wb = XLSX.readFile(cale);
  let rezultat = [];
  for (const nume of wb.SheetNames) {
    const foaie = wb.Sheets[nume];
    const a1 = foaie.A1 ? String(foaie.A1.v || '').trim() : '';
    const m = RX_FORMULAR_C.exec(a1);
    if (!m) continue; // eslint-disable-line no-continue -- nu e o foaie C6-C9 (F1/F2/F3/F4, sau alta foaie irelevanta)
    const tip = m[1].toUpperCase();
    const rows = XLSX.utils.sheet_to_json(foaie, { header: 1, defval: '', raw: false });
    rezultat = rezultat.concat(extrageResurseDinFoaieConsolidate(rows, tip));
  }
  return rezultat;
}

// Un cod poate exista in nomenclator de doua ori cu descrieri GENUIN diferite
// (nu doar variatii de scriere) -- gasit real (12.09.2026): coduri "200000XX"
// desemneaza cand o MESERIE (colectia norme_munca sau alta), cand un UTILAJ,
// in editii diferite. Alegerea corecta depinde de TIPUL formularului sursa:
// un cod dintr-un C7 (manopera) trebuie sa fie o meserie; un cod din C6/C8/C9
// (materiale/utilaj/transport) NU trebuie sa fie o meserie. Recunoastem o
// descriere de meserie dupa forma ei tipica -- incepe cu un titlu de ocupatie
// sau contine calificativul de incadrare ("categoria a ...-a", "grila de
// incadrare") -- mai robust decat sa presupunem ca toate meseriile stau in
// colectia "norme_munca" (nu stau -- unele apar si in "intersoft").
const TIPARE_OCUPATIE = /categoria\s+a\s+[a-z0-9]+[\s-]*a\b|grila\s+de\s+incadrare|^(muncitor|inginer|tehnician|sef|maistru|instalator|sudor|electrician|mecanic|operator|sofer|macaragiu|zidar|dulgher|fierar|vopsitor|zugrav|tencuitor|lacatus|strungar|frezor|forjor|tinichigiu|betonist|fochist|parchetar|faiantar|tapiter|silvicultor|tiparitor|fotoreproducator|conducator)\b/i;

/**
 * Dintre mai multi candidati (acelasi cod, descrieri diferite), alege pe cel
 * potrivit pentru tipul de formular sursa -- C7 vrea o meserie, C6/C8/C9 vor
 * orice ALTCEVA decat o meserie. Intoarce null daca ramane ambiguu si dupa
 * filtrare (nu ghicim mai departe -- mai bine semnalat clar).
 */
function aleCandidatContextual(candidati, tip) {
  const ocupatii = candidati.filter((c) => TIPARE_OCUPATIE.test(c.descriere));
  const neOcupatii = candidati.filter((c) => !TIPARE_OCUPATIE.test(c.descriere));
  const preferate = tip === 'C7' ? ocupatii : neOcupatii;
  return preferate.length === 1 ? preferate[0] : null;
}

/**
 * Importa toate resursele de pret (C6/C7/C8/C9) dintr-un folder, recursiv, in
 * istoric_preturi. NU atinge preturi_curente/nomenclator_articole -- doar
 * observatii noi, aditive. Documentul-sursa e calea relativa la dirRadacina,
 * ca originea sa ramana verificabila.
 * @param {string} dirRadacina
 * @returns {{fisiereProcesate, randuriGasite, potriviteExact, rezolvatePrinContext, potriviteAmbiguu, nepotrivite}}
 */
function importaPreturiIstorice(dirRadacina) {
  const toate = listeazaFisiere(dirRadacina);
  const stare = {
    fisiereProcesate: 0,
    randuriGasite: 0,
    potriviteExact: 0,
    rezolvatePrinContext: 0,
    potriviteAmbiguu: 0,
    nepotrivite: 0,
    avertismente: [],
  };

  function proceseazaResurse(resurse, caleRelativa) {
    stare.randuriGasite += resurse.length;
    for (const r of resurse) {
      const candidati = db.colectiiPentruCodNomenclator(r.cod);
      let colectie;
      if (!candidati.length) {
        colectie = 'istoric_nematchuit';
        stare.nepotrivite += 1;
      } else if (candidati.length === 1) {
        colectie = candidati[0].colectie;
        stare.potriviteExact += 1;
      } else {
        const alesPrinContext = aleCandidatContextual(candidati, r.tip);
        if (alesPrinContext) {
          colectie = alesPrinContext.colectie;
          stare.rezolvatePrinContext += 1;
        } else {
          colectie = 'istoric_ambiguu';
          stare.potriviteAmbiguu += 1;
          stare.avertismente.push(`cod "${r.cod}" (${caleRelativa}): ${candidati.length} descrieri diferite in nomenclator pentru acelasi cod, nerezolvat nici dupa contextul formularului -- marcat "istoric_ambiguu", de verificat manual.`);
        }
      }

      db.adaugaIstoricPret({
        colectie,
        cod: r.cod,
        pret: r.pretUnitar,
        tvaInclus: false,
        tipSursa: 'CONTRACTED_PRICE',
        furnizor: r.furnizor,
        documentSursa: caleRelativa,
        statusValidare: 'nevalidat',
        introdusDe: 'istoricDevize (import automat)',
      });
    }
  }

  // Fisierele standalone (tip cunoscut dupa numele fisierului) -- cazul
  // obisnuit, neschimbat.
  const fisiereStandalone = toate.filter((f) => CLASE_CU_RESURSE.has(f.tip));
  for (const f of fisiereStandalone) {
    const caleRelativa = path.relative(dirRadacina, f.cale);
    let resurse;
    try {
      resurse = extrageResurse(f.cale, f.tip).map((r) => ({ ...r, tip: f.tip }));
    } catch (e) {
      stare.avertismente.push(`${caleRelativa}: citire esuata (${e.message}).`);
      continue; // eslint-disable-line no-continue
    }
    stare.fisiereProcesate += 1;
    proceseazaResurse(resurse, caleRelativa);
  }

  // Fisiere consolidate (C6-C9 ca foi ale unui singur workbook, gasit real
  // 15.09.2026 -- vezi extrageResurseConsolidate). Incercate DOAR pt
  // subfolderele de proiect care n-au avut NICIUN fisier standalone -- ca sa
  // nu deschidem inutil sutele de fisiere F1/F2/F3/desene irelevante din
  // proiectele care deja merg prin calea normala (AIUD/DEVA au 1000+ fisiere
  // fara legatura). Grupare pe primul segment de cale (folderul de proiect),
  // nu pe intreg apelul -- robust si la o rulare viitoare pe intreaga arhiva
  // deodata, nu doar pe un singur folder de proiect cum rulam azi.
  const foldereCuStandalone = new Set(
    fisiereStandalone.map((f) => path.relative(dirRadacina, f.cale).split(path.sep)[0]),
  );
  const fisiereNeclasificate = toate.filter((f) => !f.tip);
  for (const f of fisiereNeclasificate) {
    const caleRelativa = path.relative(dirRadacina, f.cale);
    const folderProiect = caleRelativa.split(path.sep)[0];
    if (foldereCuStandalone.has(folderProiect)) continue; // eslint-disable-line no-continue -- proiect deja acoperit de calea standalone

    let resurse;
    try {
      resurse = extrageResurseConsolidate(f.cale);
    } catch (e) {
      stare.avertismente.push(`${caleRelativa}: citire esuata (${e.message}).`);
      continue; // eslint-disable-line no-continue
    }
    if (!resurse.length) continue; // eslint-disable-line no-continue -- fisier irelevant (fara nicio foaie C6-C9), normal, nu-i eroare

    stare.fisiereProcesate += 1;
    proceseazaResurse(resurse, caleRelativa);
  }

  return stare;
}

module.exports = {
  tipFormular,
  listeazaFisiere,
  citesteAntet,
  extrageResurse,
  extrageResurseConsolidate,
  importaPreturiIstorice,
  aleCandidatContextual,
  // Exportate si pentru istoricArticole.js (parsare F3 -- alta forma de
  // date, dar aceeasi ancora robusta pe numerotarea oficiala a coloanelor).
  gasesteNumerotareaColoanelor,
  parseNumar,
};
