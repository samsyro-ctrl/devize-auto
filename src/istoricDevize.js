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

/** Toate fisierele .xlsx dintr-un folder, recursiv, cu tipul lor de formular. */
function listeazaFisiere(dirRadacina) {
  const rezultat = [];
  function recurs(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const cale = path.join(dir, e.name);
      if (e.isDirectory()) recurs(cale);
      else if (/\.xlsx$/i.test(e.name)) {
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

/**
 * Importa toate resursele de pret (C6/C7/C8/C9) dintr-un folder, recursiv, in
 * istoric_preturi. NU atinge preturi_curente/nomenclator_articole -- doar
 * observatii noi, aditive. Documentul-sursa e calea relativa la dirRadacina,
 * ca originea sa ramana verificabila.
 * @param {string} dirRadacina
 * @returns {{fisiereProcesate, randuriGasite, potriviteExact, potriviteAmbiguu, nepotrivite}}
 */
function importaPreturiIstorice(dirRadacina) {
  const fisiere = listeazaFisiere(dirRadacina).filter((f) => CLASE_CU_RESURSE.has(f.tip));
  const stare = {
    fisiereProcesate: 0, randuriGasite: 0, potriviteExact: 0, potriviteAmbiguu: 0, nepotrivite: 0, avertismente: [],
  };

  for (const f of fisiere) {
    const caleRelativa = path.relative(dirRadacina, f.cale);
    let resurse;
    try {
      resurse = extrageResurse(f.cale, f.tip);
    } catch (e) {
      stare.avertismente.push(`${caleRelativa}: citire esuata (${e.message}).`);
      continue; // eslint-disable-line no-continue
    }
    stare.fisiereProcesate += 1;
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
        colectie = candidati[0].colectie;
        stare.potriviteAmbiguu += 1;
        stare.avertismente.push(`cod "${r.cod}" (${caleRelativa}): ${candidati.length} descrieri diferite in nomenclator pentru acelasi cod -- atribuit la "${colectie}", de verificat manual.`);
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

  return stare;
}

module.exports = {
  tipFormular, listeazaFisiere, citesteAntet, extrageResurse, importaPreturiIstorice,
};
