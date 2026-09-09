// src/extract.js
// Din fisierul incarcat (antemasuratoare) -> text pe care il poate citi modelul.
// Portat din licitatie-analiza/src/extract.js (functia textDinFisier) -- acolo
// gestioneaza si arhive/.p7s/.rar (documentatie de licitatie, semnata, in .zip),
// aici nu e nevoie: o antemasuratoare vine ca un singur fisier Excel/PDF/Word,
// nearhivat, nesemnat electronic.
'use strict';

const fs = require('fs');
const path = require('path');
const { fold } = require('./util');

const TEXT_EXT = new Set(['.txt', '.csv']);

// Un deviz standard (HG907/2016) are, pe langa formularele F2/F3 cu articole
// de lucrari reale (astea chiar trebuie extrase), si formulare DERIVATE, care
// doar REZUMA ce e deja in F2/F3 -- centralizatorul (F1) si extrasele de
// resurse C6-C9 (materiale/manopera/utilaje/transport). Gasire dintr-un caz
// real (deviz CEF fotovoltaic, 28 de foi): fara filtrul asta, C6-C9 trimit la
// extragere RESURSE individuale (ex. "Electrician categoria III, 174 ore"),
// nu lucrari -- gasesteCandidati() le respinge oricum (nu au descompunere),
// asa ca ajungeau "fara nicio potrivire" in bloc, poluand revizuirea cu zeci
// de linii care oricum aveau sa fie recalculate singure, corect, din F2/F3.
// Detectat dupa CONTINUT (antetul formularului), nu dupa numele foii -- acelasi
// format standard iese din eDevize/WinDoc/InterSoft cu nume de foi diferite.
const TIPARE_FOI_EXCLUSE = [
  /consumurile de resurse materiale/, // C6
  /consumurile cu mana de lucru/, // C7
  /consumurile de ore de functionare a utilajelor/, // C8
  /consumurile privind transporturile/, // C9
  /lista cu cantitatile de utilaje si echipamente/, // F4 -- pret de achizitie, nu articol de lucrare (montajul e deja in F2/F3)
  /centralizatorul/, // F1
];

/** true daca foaia asta e un formular DERIVAT (centralizator/extras de
 * resurse), de exclus din antemasuratoare -- vezi TIPARE_FOI_EXCLUSE. */
function esteFoieExclusa(csv) {
  const antet = fold(csv.slice(0, 300));
  return TIPARE_FOI_EXCLUSE.some((tipar) => tipar.test(antet));
}

/** true daca foaia e un formular F3 standard (HG907/2016) -- "Lista cu
 * cantitati de lucrari pe categorii de lucrari". Structura lui e FIXA:
 * pozitia de lucrare are un numar intreg simplu pe prima coloana ("1", "2",
 * "3"...), iar descompunerea EI (resursele -- material/manopera/utilaj/
 * transport, cu subtotalul lor, si sub-pozitiile individuale "1.1", "1.1.1"
 * etc.) apare dedesubt, cu numerotare zecimala sau coloana goala. Filtrul de
 * mai jos se aplica STRICT aici, dupa acest antet exact -- alte foi/formate
 * raman neatinse, judecata semantica a modelului ramane singura garda pentru
 * orice alt tip de document. */
function esteFoaieF3(csv) {
  return /lista cu cantitati de lucrari pe categorii de lucrari/.test(fold(csv.slice(0, 200)));
}

/**
 * Pastreaza DOAR randurile de pozitie de nivel 1 ("1,...", "2,...") dintr-un
 * F3 -- descompunerea fiecarei pozitii (sub-pozitiile "1.1"/"1.1.1", randurile
 * de subtotal "material:"/"manopera:"/"utilaj:"/"transport:") e deja ce va
 * calcula devize-auto SINGUR, din reteta nomenclatorului, o data ce pozitia
 * de sus e legata -- extragerea lor separat doar polua revizuirea, fie cu
 * articole-resursa fara nicio sansa de match (gasesteCandidati le respinge
 * oricum, nu au descompunere), fie -- mai insidios -- cu randuri "NNNN -
 * Lista: ..." care ARATA ca un articol de lucrare dar sunt tot o resursa
 * agregata. Gasire dintr-un caz real (deviz CEF fotovoltaic): un F3 cu doar
 * 5-10 pozitii reale genera 30-180+ randuri per foaie, marea majoritate deja
 * acoperite de descompunere.js. Regex-ul cere virgula IMEDIAT dupa cifre --
 * "1," trece, "1.1," nu (are punct inainte de virgula), la fel randurile cu
 * prima coloana goala (subtotalurile).
 */
function doarPozitiiDeNivelUnu(csv) {
  return csv.split('\n').filter((linie) => /^\d+,/.test(linie)).join('\n');
}

/**
 * Extrage textul dintr-un singur fisier. Intoarce '' daca formatul nu e citibil.
 * @param {{nume:string, cale:string}} f
 * @param {string[]} [avertismente]
 * @returns {Promise<string>}
 */
async function textDinFisier(f, avertismente = []) {
  const ext = path.extname(f.nume).toLowerCase();
  try {
    if (ext === '.pdf') {
      const pdfParse = require('pdf-parse');
      const data = await pdfParse(fs.readFileSync(f.cale));
      return data.text || '';
    }
    if (ext === '.docx') {
      const mammoth = require('mammoth');
      const res = await mammoth.extractRawText({ path: f.cale });
      return res.value || '';
    }
    if (ext === '.xlsx' || ext === '.xls' || ext === '.xlsm') {
      const XLSX = require('xlsx');
      const wb = XLSX.readFile(f.cale);
      const excluse = [];
      let foiF3 = 0;
      const text = wb.SheetNames
        .map((n) => {
          const csv = XLSX.utils.sheet_to_csv(wb.Sheets[n]);
          if (esteFoieExclusa(csv)) { excluse.push(n); return null; }
          if (esteFoaieF3(csv)) { foiF3++; return `--- foaie: ${n} ---\n${doarPozitiiDeNivelUnu(csv)}`; }
          return `--- foaie: ${n} ---\n${csv}`;
        })
        .filter(Boolean)
        .join('\n\n');
      if (excluse.length) {
        avertismente.push(`${excluse.length} foi excluse (centralizator/extras de resurse, nu articole de lucrare): ${excluse.join(', ')}.`);
      }
      if (foiF3) {
        avertismente.push(`${foiF3} foi F3 -- pastrate doar pozitiile de nivel 1 (descompunerea fiecareia o calculeaza devize-auto singur din nomenclator).`);
      }
      return text;
    }
    if (TEXT_EXT.has(ext)) {
      return fs.readFileSync(f.cale, 'utf8');
    }
    if (ext === '.doc') {
      avertismente.push(`${f.nume}: format .doc vechi, nu pot extrage text (converteste-l manual in .docx/.pdf).`);
      return '';
    }
    avertismente.push(`${f.nume}: format necunoscut (${ext || 'fara extensie'}), sarit.`);
    return '';
  } catch (err) {
    avertismente.push(`${f.nume}: extragere esuata (${err.message}).`);
    return '';
  }
}

module.exports = { textDinFisier };
