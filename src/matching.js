// src/matching.js
// Potrivirea unei linii de antemasuratoare (denumire libera) cu un articol
// COMPUS din nomenclator (unul care are reteta -- un articol-frunza tip
// 1/2/3, fara descompunere, e o resursa, nu o lucrare, si nu poate fi
// rezultatul unui match de antemasuratoare).
'use strict';

const db = require('./db');
const { fold, parseUnitateScalata } = require('./util');

const PRAG_SCOR_MATCHING = Number(process.env.PRAG_SCOR_MATCHING);
const PRAG_GAP_MATCHING = Number(process.env.PRAG_GAP_MATCHING);

/**
 * Pregateste textul pentru sintaxa MATCH a FTS5. Denumirile reale contin des
 * "/", "(", ")", virgule (ex. "Beton C20/25, turnat in cofraje") -- caractere
 * speciale in FTS5, care pot arunca eroare SQL brusca daca ajung netratate
 * intr-un MATCH. Fiecare token intre ghilimele duble -> literal, nu sintaxa.
 * @returns {string[]} variante de interogare, de incercat in ordine (AND,
 *   apoi OR daca AND nu gaseste nimic, apoi doar tokenul cel mai lung).
 */
function pregatesteInterogareFts(text) {
  const tokene = fold(text).match(/[a-z0-9]+/g) || [];
  if (!tokene.length) return [];
  const cuGhilimele = tokene.map((t) => `"${t}"`);
  const and = cuGhilimele.join(' ');
  const or = cuGhilimele.join(' OR ');
  const celMaiLung = tokene.reduce((a, b) => (b.length > a.length ? b : a));
  return [and, or, `"${celMaiLung}"`];
}

/** Cauta in nomenclator, incercand variantele de interogare in ordine, pana
 * gaseste ceva. */
function cautaCuRetry(denumire, limita) {
  for (const interogare of pregatesteInterogareFts(denumire)) {
    let rezultate;
    try {
      rezultate = db.cautaNomenclator(interogare, limita);
    } catch {
      continue; // interogare invalida (rar, dupa sanitizare) -- incearca urmatoarea varianta
    }
    if (rezultate.length) return rezultate;
  }
  return [];
}

/** true daca articolul e compus (are cel putin o descompunere). */
const areDescompunere = (colectie, cod) => db.copiiDescompunere(colectie, cod).length > 0;

/** Normalizeaza o unitate pentru comparatie -- ignora scala ("100 mc" ~ "mc"),
 * fiindca scala se aplica separat, la descompunere (vezi util.parseUnitateScalata),
 * nu la decizia "e aceeasi unitate de masura". */
const normalizeazaUnitate = (u) => parseUnitateScalata(u).baza;

/**
 * Candidatii de potrivire pentru o denumire, DOAR articole compuse (au reteta).
 * @returns {Array<{colectie, cod, unitate, descriere, pret, tip, scor}>}
 */
function gasesteCandidati(denumire, limita = 10) {
  const bruti = cautaCuRetry(denumire, limita * 2); // cauta mai multi, ca dupa filtrare tot sa ramana destui
  const compusi = [];
  for (const a of bruti) {
    if (a.tip != null) continue; // articol-frunza (resursa), nu lucrare
    // Codurile terminate in "#" sunt noduri de grupare (Capitol/Indicator din
    // BC3), nu articole reale -- confirmat empiric: 263.070 muchii cu parinte
    // terminat in "#", TOATE cu cantitate 0 (fata de doar 140/1.171.374 la
    // codurile normale). Un match pe un asemenea nod ar produce un "deviz"
    // cu resurse la cantitate zero, silentios gresit -- prins live la primul
    // test, cand "Zidarie de caramida" s-a potrivit cu "colectia_1999/RPCG#"
    // (index de capitol), nu cu un articol real de zidarie.
    if (a.cod.endsWith('#')) continue;
    if (!areDescompunere(a.colectie, a.cod)) continue;
    compusi.push(a);
    if (compusi.length >= limita) break;
  }
  return compusi;
}

/**
 * Alege (sau nu) o potrivire automata pentru o linie de antemasuratoare.
 * @param {{denumire, unitate}} linie
 * @returns {{stare, colectie, cod, scor, candidati_json}}
 */
function alegeMatch(linie) {
  const candidati = gasesteCandidati(linie.denumire);
  if (!candidati.length) {
    return { stare: 'fara_potrivire', candidati_json: '[]' };
  }

  const [c1, c2] = candidati;
  const candidatiJson = JSON.stringify(candidati.slice(0, 5));

  if (!Number.isFinite(PRAG_SCOR_MATCHING) || !Number.isFinite(PRAG_GAP_MATCHING)) {
    // Pragurile n-au fost calibrate inca (vezi scripts/calibreaza-prag-matching.js)
    // -- fara ele, nu avem cum sa decidem "suficient de sigur", deci totul merge
    // la revizuire umana, niciodata auto.
    return { stare: 'de_revizuit', colectie: c1.colectie, cod: c1.cod, scor: c1.scor, candidati_json: candidatiJson };
  }

  const unitateCompatibila = c1.unitate && normalizeazaUnitate(c1.unitate) === normalizeazaUnitate(linie.unitate);
  const scorSuficient = c1.scor <= PRAG_SCOR_MATCHING; // bm25 mai negativ = mai bun
  const gapSuficient = !c2 || (c2.scor - c1.scor) >= PRAG_GAP_MATCHING;

  const stare = (scorSuficient && gapSuficient && unitateCompatibila) ? 'auto' : 'de_revizuit';
  return { stare, colectie: c1.colectie, cod: c1.cod, scor: c1.scor, candidati_json: candidatiJson };
}

module.exports = { pregatesteInterogareFts, gasesteCandidati, alegeMatch, normalizeazaUnitate };
