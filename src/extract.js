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

// Sub cate caractere consideram ca un PDF NU are strat de text util --
// probabil o scanare (fara OCR aplicat la sursa). Calibrat pe documente PT
// reale: scanari confirmate au intors intre 0 si 282 caractere (doar
// spatii/artefacte de layout), in timp ce documente cu text real, chiar
// scurte, trec cu mult peste (un caiet de sarcini real a dat 147.000+
// caractere). Vezi transcriereVizuala.js pentru decizia de a NU folosi OCR
// clasic aici.
const PRAG_TEXT_INSUFICIENT = 500;

// Cap de siguranta pe numarul de pagini transcrise automat -- transcrierea
// vizuala e un apel AI PER PAGINA; fara cap, un document scanat de sute de
// pagini (vazute real: 96, 141, 377 pagini) ar declansa sute de apeluri la
// un simplu upload, cu cost si timp mari, fara ca utilizatorul sa fi cerut
// explicit asta. De marit daca se dovedeste prea mic in practica.
const PRAG_PAGINI_TRANSCRIERE = 60;

// Semn ca extragerea nativa a "lipit" doua celule de tabel invecinate fara
// niciun spatiu intre ele -- caz DIFERIT de text insuficient: documentul
// poate avea sute de mii de caractere, dar cu coloane pierdute. Gasit real,
// pe un deviz de productie (SCN1179408, "Devize fara pret Autobaza.pdf"):
// pdf-parse intorcea "0,000,00" acolo unde pagina are de fapt DOUA coloane
// distincte (Valoare neeligibila + TVA), ambele "0,00" -- verificat direct,
// randare vizuala a paginii arata clar cele doua coloane separate.
//
// STRICT pe virgula (nu si punct) pentru ambele grupuri zecimale -- un punct
// in pozitia asta e aproape sigur separator de mii intr-un numar romanesc
// normal (ex. "6.063.114,68 lei"), NU doua sume lipite. Gasire reala: prima
// versiune a tiparului (cu [.,] in loc de ,) dadea fals-pozitiv pe caietul
// de sarcini SCN1177636 -- text perfect valid, doar cu sume mari, cu
// separator de mii. Cerand VIRGULA in ambele jumatati, un numar romanesc
// normal (o singura virgula, oricate puncte de grupare) nu mai poate
// potrivi niciodata -- doar doua sume distincte, fiecare cu propria
// virgula zecimala, lipite fara spatiu intre ele.
const TIPAR_CIFRE_LIPITE = /\d,\d{2}\d,\d{2}/g;
const PRAG_CIFRE_LIPITE = 5;

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
 * Un PDF cu text nativ NEFOLOSITOR -- fie insuficient (probabil scanat, fara
 * OCR la sursa), fie cu coloane lipite (vezi TIPAR_CIFRE_LIPITE). In ambele
 * cazuri, modelul cu vedere citeste mult mai fidel decat ce poate scoate
 * pdf-parse (confirmat pe documente PT reale SI pe un deviz tabelar real,
 * vezi transcriereVizuala.js si comentariul de la TIPAR_CIFRE_LIPITE).
 * Incearca transcrierea vizuala, pagina cu pagina; daca esueaza (fara cheie
 * OpenRouter, eroare de retea etc.), ramane la textul nativ (posibil gol) --
 * nu blocheaza niciodata restul extragerii.
 * @param {string} motiv "text insuficient" sau "coloane lipite" -- pentru avertismentul afisat
 */
async function textDinPdfScanat(f, textNativ, avertismente, motiv) {
  if (!process.env.OPENROUTER_API_KEY) {
    if (textNativ.trim().length === 0) {
      avertismente.push(`${f.nume}: PDF fara text nativ (probabil scanat) si OPENROUTER_API_KEY nu e setat -- nu pot incerca transcrierea vizuala.`);
    }
    return textNativ;
  }
  try {
    const { transcrieDocument } = require('./transcriereVizuala');
    const avertismenteTranscriere = [];
    const { text: textTranscris, numPagini } = await transcrieDocument(
      f.cale,
      avertismenteTranscriere,
      { paginaEnd: PRAG_PAGINI_TRANSCRIERE },
    );
    for (const a of avertismenteTranscriere) avertismente.push(`${f.nume}: ${a}`);
    if (numPagini > PRAG_PAGINI_TRANSCRIERE) {
      avertismente.push(`${f.nume}: document scanat cu ${numPagini} pagini -- transcrise doar primele ${PRAG_PAGINI_TRANSCRIERE} (cap de cost/timp).`);
    }
    if (!textTranscris.trim().length) return textNativ;
    avertismente.push(`${f.nume}: text nativ nefolositor (${motiv}) -- folosit text transcris cu modelul cu vedere.`);
    return textTranscris;
  } catch (err) {
    avertismente.push(`${f.nume}: transcriere vizuala esuata (${err.message}) -- ramane textul nativ (${textNativ.trim().length} caractere).`);
    return textNativ;
  }
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
      const textNativ = data.text || '';
      if (textNativ.trim().length < PRAG_TEXT_INSUFICIENT) {
        return await textDinPdfScanat(f, textNativ, avertismente, 'text insuficient, posibil scanat');
      }
      const cifreLipite = textNativ.match(TIPAR_CIFRE_LIPITE) || [];
      if (cifreLipite.length >= PRAG_CIFRE_LIPITE) {
        return await textDinPdfScanat(f, textNativ, avertismente, `${cifreLipite.length} perechi de cifre lipite fara separator -- probabil coloane de tabel pierdute la extragere`);
      }
      return textNativ;
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
