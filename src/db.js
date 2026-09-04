// src/db.js
// Baza locala (SQLite, node:sqlite), fara nicio dependinta externa.
//
// Doua straturi:
//   1. nomenclator_* -- portate identic din recrutare-bot/src/db.js (schema si
//      functiile de import/cautare sunt aceleasi; vezi comentariile de-acolo
//      pentru motivatia deciziilor -- de ce colectie+cod ca cheie compusa, de
//      ce FTS standalone, de ce descompunerea poate sari intre colectii).
//   2. proiecte/antemasuratoare_linii/rezolutii_matching/preturi_curente/
//      resurse_agregate -- noi, specifice acestui instrument.
'use strict';

const path = require('path');
const { ensureDir } = require('./util');

let db = null;

/** Deschide (si creeaza la prima rulare) baza. */
function deschide(outputDir) {
  if (db) return db;
  const { DatabaseSync } = require('node:sqlite');
  const f = path.join(ensureDir(outputDir), 'devize.db');
  db = new DatabaseSync(f);
  db.exec(`
    -- ─── Nomenclator (portat din recrutare-bot) ──────────────────────────────
    CREATE TABLE IF NOT EXISTS nomenclator_articole (
      colectie  TEXT NOT NULL,
      cod       TEXT NOT NULL,
      unitate   TEXT, descriere TEXT, pret REAL, tip INTEGER,
      PRIMARY KEY (colectie, cod)
    );
    CREATE TABLE IF NOT EXISTS nomenclator_descompuneri (
      colectie    TEXT NOT NULL,
      cod_parinte TEXT NOT NULL,
      cod_copil   TEXT NOT NULL,
      cantitate   REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_nomenclator_desc_parinte ON nomenclator_descompuneri(colectie, cod_parinte);
    CREATE VIRTUAL TABLE IF NOT EXISTS nomenclator_fts USING fts5(
      descriere, cod UNINDEXED, colectie UNINDEXED
    );

    -- ─── Proiecte proprii ────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS proiecte (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      nume                     TEXT NOT NULL,
      creat_la                 TEXT NOT NULL,
      fisier_sursa             TEXT,
      adaos_indirecte_procent  REAL DEFAULT 10,
      adaos_profit_procent     REAL DEFAULT 5,
      tva_procent              REAL DEFAULT 19,
      stare                    TEXT DEFAULT 'extras'
    );
    -- O linie = o pozitie din antemasuratoarea incarcata (denumire+cantitate+UM),
    -- asa cum a extras-o modelul din documentul original. "ordine" pastreaza
    -- ordinea din document, ca devizul final sa urmeze acelasi fir.
    CREATE TABLE IF NOT EXISTS antemasuratoare_linii (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      proiect_id  INTEGER NOT NULL REFERENCES proiecte(id),
      ordine      INTEGER NOT NULL,
      capitol     TEXT,
      denumire    TEXT NOT NULL,
      cantitate   REAL NOT NULL,
      unitate     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_linii_proiect ON antemasuratoare_linii(proiect_id);
    -- Rezultatul matching-ului unei linii cu nomenclatorul. "stare": auto
    -- (incredere suficienta, dar tot afisata la revizuire) / confirmat (omul
    -- a validat sau a ales alt articol) / de_revizuit (sub prag) /
    -- fara_potrivire (nimic relevant gasit). "candidati_json" tine top 5,
    -- ca ecranul de revizuire sa poata arata alternative fara o cautare noua.
    CREATE TABLE IF NOT EXISTS rezolutii_matching (
      linie_id       INTEGER PRIMARY KEY REFERENCES antemasuratoare_linii(id),
      colectie       TEXT, cod TEXT, scor REAL,
      stare          TEXT NOT NULL DEFAULT 'de_revizuit',
      candidati_json TEXT,
      rezolvat_la    TEXT
    );
    -- Cache GLOBAL de preturi curente, partajat intre proiecte -- pretul
    -- introdus o data pentru "ciment M400" se reutilizeaza la devizele
    -- viitoare. Ramane editabil per proiect (suprascrie la reimport).
    CREATE TABLE IF NOT EXISTS preturi_curente (
      colectie      TEXT NOT NULL,
      cod           TEXT NOT NULL,
      pret          REAL NOT NULL,
      actualizat_la TEXT NOT NULL,
      PRIMARY KEY (colectie, cod)
    );
    -- Resursele (materiale/manopera/utilaj) obtinute prin descompunerea
    -- tuturor liniilor confirmate ale unui proiect, agregate pe cod (aceeasi
    -- resursa poate aparea in reteta mai multor linii -- se aduna cantitatile).
    CREATE TABLE IF NOT EXISTS resurse_agregate (
      proiect_id       INTEGER NOT NULL REFERENCES proiecte(id),
      colectie         TEXT NOT NULL,
      cod              TEXT NOT NULL,
      tip              INTEGER NOT NULL,
      unitate          TEXT,
      descriere        TEXT,
      cantitate_totala REAL NOT NULL,
      PRIMARY KEY (proiect_id, colectie, cod)
    );
  `);
  return db;
}

const acum = () => new Date().toISOString();

// ─── Nomenclator (portat din recrutare-bot) ──────────────────────────────────

function stergeNomenclator(colectie) {
  if (!db) return;
  db.prepare('DELETE FROM nomenclator_articole WHERE colectie = ?').run(colectie);
  db.prepare('DELETE FROM nomenclator_descompuneri WHERE colectie = ?').run(colectie);
}

function insereazaArticoleNomenclator(colectie, articole) {
  if (!db || !articole?.length) return;
  const ins = db.prepare(`INSERT INTO nomenclator_articole (colectie, cod, unitate, descriere, pret, tip)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(colectie, cod) DO UPDATE SET
      unitate = excluded.unitate, descriere = excluded.descriere, pret = excluded.pret, tip = excluded.tip`);
  db.exec('BEGIN');
  try {
    for (const a of articole) ins.run(colectie, a.cod, a.unitate || '', a.descriere || '', a.pret, a.tip);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function insereazaDescompuneriNomenclator(colectie, descompuneri) {
  if (!db || !descompuneri?.length) return;
  const ins = db.prepare('INSERT INTO nomenclator_descompuneri (colectie, cod_parinte, cod_copil, cantitate) VALUES (?,?,?,?)');
  db.exec('BEGIN');
  try {
    for (const d of descompuneri) ins.run(colectie, d.parinte, d.copil, d.cantitate);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function reconstruiesteNomenclatorFts() {
  if (!db) return;
  db.exec('DELETE FROM nomenclator_fts');
  db.exec(`INSERT INTO nomenclator_fts (descriere, cod, colectie)
    SELECT descriere, cod, colectie FROM nomenclator_articole WHERE descriere IS NOT NULL AND descriere != ''`);
}

function statisticiNomenclator() {
  if (!db) return [];
  return db.prepare(`SELECT colectie, COUNT(*) articole,
      SUM(CASE WHEN pret IS NOT NULL THEN 1 ELSE 0 END) cu_pret
    FROM nomenclator_articole GROUP BY colectie ORDER BY colectie`).all();
}

/** Cauta articole dupa denumire (text liber), ordonate dupa relevanta FTS5
 * (bm25 -- mai negativ inseamna mai relevant). "scor" e expus explicit,
 * fiindca matching.js decide auto-vs-revizuit pe baza lui, nu doar pe ordine. */
function cautaNomenclator(text, limita = 20) {
  if (!db || !text) return [];
  return db.prepare(`
    SELECT a.colectie, a.cod, a.unitate, a.descriere, a.pret, a.tip, bm25(nomenclator_fts) AS scor
    FROM nomenclator_fts f
    JOIN nomenclator_articole a ON a.colectie = f.colectie AND a.cod = f.cod
    WHERE nomenclator_fts MATCH ?
    ORDER BY scor LIMIT ?
  `).all(text, limita);
}

/** Un singur articol, dupa cheia compusa -- folosit de descompunere.js pentru
 * rezolvarea (posibil incrucisata intre colectii) a fiecarui copil. */
const cautaArticol = (colectie, cod) =>
  (db ? db.prepare('SELECT colectie, cod, unitate, descriere, pret, tip FROM nomenclator_articole WHERE colectie = ? AND cod = ?').get(colectie, cod) : undefined);

/** Copiii direcți ai unui articol compus, cu cantitatea consumata per unitate din parinte. */
const copiiDescompunere = (colectie, cod) =>
  (db ? db.prepare('SELECT cod_copil, cantitate FROM nomenclator_descompuneri WHERE colectie = ? AND cod_parinte = ?').all(colectie, cod) : []);

// ─── Proiecte ─────────────────────────────────────────────────────────────

function creeazaProiect(nume, fisierSursa) {
  const r = db.prepare('INSERT INTO proiecte (nume, creat_la, fisier_sursa) VALUES (?,?,?)').run(nume, acum(), fisierSursa || null);
  return Number(r.lastInsertRowid);
}

const proiectDupaId = (id) => db.prepare('SELECT * FROM proiecte WHERE id = ?').get(id);
const toateProiectele = () => db.prepare('SELECT * FROM proiecte ORDER BY id DESC').all();
const actualizeazaStareProiect = (id, stare) => db.prepare('UPDATE proiecte SET stare = ? WHERE id = ?').run(stare, id);

// ─── Linii de antemasuratoare ────────────────────────────────────────────────

/** @param {Array<{ordine, capitol, denumire, cantitate, unitate}>} linii */
function insereazaLiniiAntemasuratoare(proiectId, linii) {
  if (!linii?.length) return;
  const ins = db.prepare('INSERT INTO antemasuratoare_linii (proiect_id, ordine, capitol, denumire, cantitate, unitate) VALUES (?,?,?,?,?,?)');
  db.exec('BEGIN');
  try {
    for (const l of linii) ins.run(proiectId, l.ordine, l.capitol || 'Nespecificat', l.denumire, l.cantitate, l.unitate);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const liniiPeProiect = (proiectId) => db.prepare('SELECT * FROM antemasuratoare_linii WHERE proiect_id = ? ORDER BY ordine').all(proiectId);

// ─── Rezolutii de matching ───────────────────────────────────────────────────

/** @param {{stare, colectie, cod, scor, candidati_json}} rezolutie */
function salveazaRezolutie(linieId, rezolutie) {
  db.prepare(`INSERT INTO rezolutii_matching (linie_id, colectie, cod, scor, stare, candidati_json, rezolvat_la)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(linie_id) DO UPDATE SET
      colectie = excluded.colectie, cod = excluded.cod, scor = excluded.scor,
      stare = excluded.stare, candidati_json = excluded.candidati_json, rezolvat_la = excluded.rezolvat_la`)
    .run(linieId, rezolutie.colectie || null, rezolutie.cod || null, rezolutie.scor ?? null,
      rezolutie.stare, rezolutie.candidati_json || '[]', acum());
}

function confirmaRezolutie(linieId, colectie, cod) {
  db.prepare(`UPDATE rezolutii_matching SET colectie = ?, cod = ?, stare = 'confirmat', rezolvat_la = ? WHERE linie_id = ?`)
    .run(colectie, cod, acum(), linieId);
}

/** Liniile unui proiect, cu rezolutia lor de matching alaturata (LEFT JOIN --
 * o linie fara nicio rezolutie inca tot trebuie sa apara, cu stare NULL). */
const liniiCuRezolutiiPeProiect = (proiectId) => db.prepare(`
  SELECT l.*, r.colectie, r.cod, r.scor, r.stare, r.candidati_json
  FROM antemasuratoare_linii l LEFT JOIN rezolutii_matching r ON r.linie_id = l.id
  WHERE l.proiect_id = ? ORDER BY l.ordine
`).all(proiectId);

// ─── Preturi curente (cache global) ──────────────────────────────────────────

function salveazaPretCurent(colectie, cod, pret) {
  db.prepare(`INSERT INTO preturi_curente (colectie, cod, pret, actualizat_la) VALUES (?,?,?,?)
    ON CONFLICT(colectie, cod) DO UPDATE SET pret = excluded.pret, actualizat_la = excluded.actualizat_la`)
    .run(colectie, cod, pret, acum());
}

const pretCurent = (colectie, cod) => db.prepare('SELECT pret FROM preturi_curente WHERE colectie = ? AND cod = ?').get(colectie, cod)?.pret ?? null;

// ─── Resurse agregate ─────────────────────────────────────────────────────────

const stergeResurseAgregate = (proiectId) => db.prepare('DELETE FROM resurse_agregate WHERE proiect_id = ?').run(proiectId);

/** Aduna cantitatea la resursa (proiect_id, colectie, cod) -- upsert cu suma,
 * nu inlocuire, fiindca aceeasi resursa poate proveni din mai multe linii. */
function adaugaResursaAgregata(proiectId, { colectie, cod, tip, unitate, descriere, cantitate }) {
  db.prepare(`INSERT INTO resurse_agregate (proiect_id, colectie, cod, tip, unitate, descriere, cantitate_totala)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(proiect_id, colectie, cod) DO UPDATE SET cantitate_totala = cantitate_totala + excluded.cantitate_totala`)
    .run(proiectId, colectie, cod, tip, unitate || '', descriere || '', cantitate);
}

const resurseAgregatePeProiect = (proiectId) => db.prepare(`
  SELECT r.*, COALESCE(p.pret, 0) pret_curent
  FROM resurse_agregate r LEFT JOIN preturi_curente p ON p.colectie = r.colectie AND p.cod = r.cod
  WHERE r.proiect_id = ? ORDER BY r.tip, r.descriere
`).all(proiectId);

module.exports = {
  deschide,
  stergeNomenclator, insereazaArticoleNomenclator, insereazaDescompuneriNomenclator,
  reconstruiesteNomenclatorFts, statisticiNomenclator, cautaNomenclator, cautaArticol, copiiDescompunere,
  creeazaProiect, proiectDupaId, toateProiectele, actualizeazaStareProiect,
  insereazaLiniiAntemasuratoare, liniiPeProiect, liniiCuRezolutiiPeProiect,
  salveazaRezolutie, confirmaRezolutie,
  salveazaPretCurent, pretCurent,
  stergeResurseAgregate, adaugaResursaAgregata, resurseAgregatePeProiect,
};
