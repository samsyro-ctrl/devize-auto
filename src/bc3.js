// src/bc3.js
// Parser pentru fisiere .bc3 (FIEBDC-3/2007) -- formatul standard al
// indicatoarelor de norme de deviz din constructii. Citeste linie cu linie,
// fara sa incarce tot fisierul in memorie (unele colectii trec de 30 MB).
//
// Copiat identic din recrutare-bot/src/bc3.js.
//
// Doua tipuri de linii ne intereseaza:
//   ~C|cod|unitate|descriere|pret||tip|   -- un articol/concept (pret+tip
//     lipsesc la capitole/indicatori, care sunt doar noduri de grupare)
//   ~D|cod_parinte|listacopii|            -- descompunerea articolului parinte:
//     fiecare copil apare ca "cod\tip_factor\cantitate\", repetat, terminat
//     cu un backslash final. "tip_factor" e aproape mereu gol (factor simplu).
'use strict';

const fs = require('fs');
const readline = require('readline');

/**
 * Parcurge un fisier .bc3, apeland onArticol/onDescompunere pentru fiecare
 * rand relevant gasit. Nu intoarce nimic acumulat -- apelantul decide ce
 * face cu fiecare rand (ex: insereaza direct in baza, ca sa nu tinem in
 * memorie milioane de descompuneri deodata).
 */
async function parcurgeBC3(cale, { onArticol, onDescompunere } = {}) {
  const flux = fs.createReadStream(cale, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: flux, crlfDelay: Infinity });

  for await (const linieBruta of rl) {
    const linie = linieBruta.replace(/\r$/, '');
    if (linie.startsWith('~C|')) {
      const c = linie.split('|');
      const cod = (c[1] || '').trim();
      if (!cod) continue;
      const pretText = (c[4] || '').trim();
      const tipText = (c[6] || '').trim();
      const pret = pretText ? Number(pretText.replace(',', '.')) : null;
      const tip = tipText ? Number(tipText) : null;
      onArticol && onArticol({
        cod,
        unitate: (c[2] || '').trim(),
        descriere: (c[3] || '').trim(),
        pret: Number.isFinite(pret) ? pret : null,
        tip: Number.isFinite(tip) ? tip : null,
      });
    } else if (linie.startsWith('~D|')) {
      const c = linie.split('|');
      const parinte = (c[1] || '').trim();
      const lista = c[2] || '';
      if (!parinte || !lista) continue;
      // "cod\tip_factor\cantitate\cod\tip_factor\cantitate\...\" -- grupuri
      // de 3 subcampuri separate de un singur backslash; ultimul token dupa
      // split e mereu gol (backslash-ul final), il aruncam.
      const tokene = lista.split('\\');
      for (let i = 0; i + 2 < tokene.length; i += 3) {
        const copil = tokene[i].trim();
        const cantitate = Number(tokene[i + 2]);
        if (copil && Number.isFinite(cantitate)) {
          onDescompunere && onDescompunere({ parinte, copil, cantitate });
        }
      }
    }
  }
}

module.exports = { parcurgeBC3 };
