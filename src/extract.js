// src/extract.js
// Din fisierul incarcat (antemasuratoare) -> text pe care il poate citi modelul.
// Portat din licitatie-analiza/src/extract.js (functia textDinFisier) -- acolo
// gestioneaza si arhive/.p7s/.rar (documentatie de licitatie, semnata, in .zip),
// aici nu e nevoie: o antemasuratoare vine ca un singur fisier Excel/PDF/Word,
// nearhivat, nesemnat electronic.
'use strict';

const fs = require('fs');
const path = require('path');

const TEXT_EXT = new Set(['.txt', '.csv']);

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
      return wb.SheetNames
        .map((n) => `--- foaie: ${n} ---\n${XLSX.utils.sheet_to_csv(wb.Sheets[n])}`)
        .join('\n\n');
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
