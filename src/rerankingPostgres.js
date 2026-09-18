// src/rerankingPostgres.js
// g1 (18.09.2026, Cristian confirmat direct): retrieval Postgres pt
// reranking AI -- portat 1:1 din migration-test/gaseste-candidati-postgres.js
// (buildandfix-core, sesiunea Server), varianta v4, validata empiric
// (recall@20 = 88.06% pe SCN1179715, bate bm25/SQLite original la
// "niciodata gasit": 7.91% vs 8.80%). Cauta in TOT nomenclatorul (via
// Postgres tsvector+GIN), nu doar in candidatii cache-uiti de bm25 la
// matching -- de-aia poate gasi potriviri pe care bm25-ul din matching.js
// nu le-a vazut niciodata, nu doar re-ordona ce exista deja.
//
// Citeste DOAR din baza Postgres "devize" (sincronizata din SQLite prin
// scripts/sincronizeaza-nomenclator-postgres.js) -- nu scrie niciodata
// acolo si nu atinge devize.db.
'use strict';

const { Pool } = require('pg');

let pool = null;
function conexiune() {
  if (!pool) pool = new Pool();
  return pool;
}

function fold(s) {
  return String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[șş]/gi, 's')
    .replace(/[țţ]/gi, 't')
    .toLowerCase()
    .trim();
}

function tokeniRegex(text) {
  return fold(text).match(/[a-z0-9]+/g) || [];
}

async function extrageLexeme(pg, text) {
  const r = await pg.query(
    `SELECT array_agg(DISTINCT lexeme) AS lexeme_arr
     FROM unnest(to_tsvector('simple', f_unaccent($1))) AS u(lexeme, positions, weights)`,
    [text]
  );
  return r.rows[0].lexeme_arr || [];
}

/** Setul de (colectie+cod_parinte) cu descompunere reala -- un articol fara
 * descompunere n-are reteta de resurse de agregat, nu e rezultat valid. */
async function incarcaAreDescompunere(pg) {
  const r = await pg.query('SELECT DISTINCT colectie, cod_parinte FROM nomenclator_descompuneri');
  return new Set(r.rows.map((row) => `${row.colectie}${row.cod_parinte}`));
}

/**
 * Candidati de potrivire pt o descriere de linie, din nomenclator_articole
 * (Postgres). Ordonati descrescator dupa ts_rank.
 * @param {import('pg').Pool | import('pg').Client} pg
 * @param {string} denumire descrierea liniei de antemasuratoare cautate
 * @param {Set<string>} areDescompunere din incarcaAreDescompunere()
 * @param {{limit?: number, limitBrut?: number}} [optiuni]
 * @returns {Promise<Array<{colectie: string, cod: string}>>}
 */
async function gasesteCandidati(pg, denumire, areDescompunere, { limit = 20, limitBrut } = {}) {
  const regexTokeni = tokeniRegex(denumire);
  const lexeme = await extrageLexeme(pg, denumire);
  const uniune = Array.from(new Set([...regexTokeni, ...lexeme]));
  if (!uniune.length) return [];

  const query = uniune.join(' | ');
  const limitaBruta = limitBrut ?? limit * 20;

  let bruti;
  try {
    const r = await pg.query(
      `SELECT colectie, cod, tip
       FROM nomenclator_articole
       WHERE descriere_tsv @@ to_tsquery('simple', $1)
       ORDER BY ts_rank(descriere_tsv, to_tsquery('simple', $1), 1) DESC LIMIT $2`,
      [query, limitaBruta]
    );
    bruti = r.rows;
  } catch {
    return []; // tsquery invalid (rar) -- fara candidati, nu crash pe un import intreg
  }

  const candidati = [];
  for (const a of bruti) {
    if (a.cod.endsWith('#')) continue; // exclude coduri tehnice

    // Coduri "..__1" sunt WRAPPERE SINTETICE legacy in jurul unei resurse-
    // frunza brute (ex. TRA01A05P__1 decompune STRICT in TRA01A05P insusi,
    // cantitate 1, + o urma 0.00001 dintr-un cod nelegat) -- pret NULL pe
    // 10.790/10.807 din ele in tot nomenclatorul, aproape toate. Gasit real
    // (18.09.2026, prima rulare pe SCN1179715 -- 551/3077 linii afectate,
    // toate "corectii" sterile catre acelasi rezultat final de pret, prin
    // doi pasi in loc de unul). Excluse necondiitonat, indiferent de tip.
    if (a.cod.includes('__')) continue;

    if (a.tip != null) {
      // Resursa-frunza (transport/manopera/utilaj/material) potrivita
      // DIRECT pe o linie -- caz valid, tratat explicit de
      // src/descompunere.js (fix 14.09.2026, gasit real pe SCN1178517):
      // articolul e propria lui "reteta", 1 unitate din el insusi, FARA sa
      // aiba nevoie de nicio descompunere sau wrapper sintetic. Filtrul
      // vechi (mostenit din gaseste-candidati-postgres.js) excludea complet
      // aceste resurse din candidati -- corect doar daca wrapperele __N de
      // mai sus ar fi ramas disponibile ca alternativa (nu mai sunt),
      // altfel liniile care se potrivesc real pe o resursa bruta (ex. toate
      // liniile de transport TRA*) ar iesi fara niciun candidat.
      candidati.push({ colectie: a.colectie, cod: a.cod });
      if (candidati.length >= limit) break;
      continue; // eslint-disable-line no-continue
    }
    if (!areDescompunere.has(`${a.colectie}${a.cod}`)) continue; // articol compus fara reteta -- nefolosibil
    candidati.push({ colectie: a.colectie, cod: a.cod });
    if (candidati.length >= limit) break;
  }
  return candidati;
}

/** Detaliile complete (descriere/unitate) pt o lista de candidati scurti --
 * pastreaza ordinea originala (relevanta ts_rank), nu ordinea SQL. */
async function detaliiPtCandidati(pg, candidati) {
  if (!candidati.length) return [];
  const colectii = candidati.map((c) => c.colectie);
  const coduri = candidati.map((c) => c.cod);
  const r = await pg.query(
    `SELECT colectie, cod, descriere, unitate FROM nomenclator_articole
     WHERE (colectie, cod) IN (SELECT * FROM unnest($1::text[], $2::text[]) AS t(colectie, cod))`,
    [colectii, coduri]
  );
  return candidati
    .map((c) => r.rows.find((d) => d.colectie === c.colectie && d.cod === c.cod))
    .filter(Boolean);
}

module.exports = { conexiune, incarcaAreDescompunere, gasesteCandidati, detaliiPtCandidati };
