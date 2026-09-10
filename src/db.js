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

/** Deschide (si creeaza la prima rulare) baza. "numeFisier" -- separat pentru
 * instanta publica (public.db, vezi public-server.js) fata de cea interna
 * (devize.db, panou.js) -- doua fisiere diferite, izolare garantata la nivel
 * de disc, nu doar printr-o coloana de filtrare usor de uitat intr-o
 * interogare viitoare. */
function deschide(outputDir, numeFisier = 'devize.db') {
  if (db) return db;
  const { DatabaseSync } = require('node:sqlite');
  const f = path.join(ensureDir(outputDir), numeFisier);
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
    -- "cod_dat" -- doar la fluxul "incarca-deviz": codul de nomenclator care
    -- apare deja scris in devizul impus (daca apare). NULL la antemasuratoare
    -- libera (fluxul "incarca"), unde nu exista niciun cod dat, doar denumire.
    CREATE TABLE IF NOT EXISTS antemasuratoare_linii (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      proiect_id  INTEGER NOT NULL REFERENCES proiecte(id),
      ordine      INTEGER NOT NULL,
      capitol     TEXT,
      denumire    TEXT NOT NULL,
      cantitate   REAL NOT NULL,
      unitate     TEXT NOT NULL,
      cod_dat     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_linii_proiect ON antemasuratoare_linii(proiect_id);
    -- Rezultatul matching-ului unei linii cu nomenclatorul. "stare": auto
    -- (incredere suficienta, dar tot afisata la revizuire) / confirmat (omul
    -- a validat sau a ales alt articol) / de_revizuit (sub prag) /
    -- fara_potrivire (nimic relevant gasit). "candidati_json" tine top 5,
    -- ca ecranul de revizuire sa poata arata alternative fara o cautare noua.
    -- "nota" -- mesaj scurt de context pentru revizuire, folosit mai ales la
    -- "incarca-deviz": ex. "codul dat XYZ nu exista in nomenclator" sau
    -- "codul XYZ exista in mai multe colectii" -- ca omul sa stie DE CE
    -- linia asta cere atentie, nu doar CA cere.
    CREATE TABLE IF NOT EXISTS rezolutii_matching (
      linie_id       INTEGER PRIMARY KEY REFERENCES antemasuratoare_linii(id),
      colectie       TEXT, cod TEXT, scor REAL,
      stare          TEXT NOT NULL DEFAULT 'de_revizuit',
      candidati_json TEXT,
      nota           TEXT,
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

    -- ─── Firme (doar in public.db, vezi public-server.js) ───────────────────
    -- Un cont = o firma, creat manual de noi (CLI, scripts/creeaza-firma.js),
    -- nu prin inregistrare libera -- vezi planul. Parola nu se pastreaza
    -- niciodata in clar, doar amprenta (scrypt+sare, vezi src/firmePublic.js).
    CREATE TABLE IF NOT EXISTS firme (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      nume              TEXT NOT NULL,
      utilizator        TEXT,
      email             TEXT NOT NULL UNIQUE,
      hash_parola       TEXT NOT NULL,
      sare              TEXT NOT NULL,
      parola_temporara  INTEGER NOT NULL DEFAULT 1,
      creat_la          TEXT NOT NULL,
      ultima_intrare    TEXT,
      dezactivat        INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sesiuni_publice (
      token       TEXT PRIMARY KEY,
      firma_id    INTEGER NOT NULL REFERENCES firme(id),
      creat_la    TEXT NOT NULL,
      expira_la   TEXT NOT NULL
    );
    -- Cache de preturi, ca "preturi_curente", dar scopat pe firma -- separat
    -- de "preturi_curente" (folosit STRICT de instrumentul intern), pentru ca
    -- doua firme diferite NU trebuie sa vada preturile una alteia, si nici
    -- cache-ul intern (alimentat din "proprii"/recrutare-bot) nu trebuie sa
    -- iasa public. Un tabel nou, nu o coloana pe cel vechi -- schimbarea
    -- cheii primare a lui "preturi_curente" ar fi riscat sa strice upsert-ul
    -- deja folosit de panou.js/cli.js (NULL != NULL intr-o cheie unica).
    CREATE TABLE IF NOT EXISTS preturi_curente_firma (
      firma_id      INTEGER NOT NULL REFERENCES firme(id),
      colectie      TEXT NOT NULL,
      cod           TEXT NOT NULL,
      pret          REAL NOT NULL,
      actualizat_la TEXT NOT NULL,
      PRIMARY KEY (firma_id, colectie, cod)
    );
    -- Provenienta completa de preturi (DEVIZE_ARCHITECTURE.md §9.2/§9.3,
    -- adaugata aditiv -- NU inlocuieste "preturi_curente"/"preturi_curente_firma",
    -- care raman cache-ul rapid de "cel mai bun pret curent" folosit direct de
    -- deviz.js). Un rand per OBSERVATIE de pret (nu upsert pe colectie+cod --
    -- de-aia "id" e cheia, nu (colectie,cod)), ca istoricul sa nu se piarda la
    -- fiecare actualizare. "preturi_curente" poate fi derivat de-aici (cea mai
    -- recenta/de incredere observatie per articol), dar asta ramane un pas
    -- separat, viitor -- vezi Faza C.
    CREATE TABLE IF NOT EXISTS istoric_preturi (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      colectie        TEXT NOT NULL,
      cod             TEXT NOT NULL,
      pret            REAL NOT NULL,
      moneda          TEXT NOT NULL DEFAULT 'RON',
      tva_inclus      INTEGER NOT NULL DEFAULT 0,
      tip_sursa       TEXT NOT NULL,
      furnizor        TEXT,
      document_sursa  TEXT,
      proiect_id      INTEGER REFERENCES proiecte(id),
      firma_id        INTEGER REFERENCES firme(id),
      localitate      TEXT,
      valabil_pana    TEXT,
      status_validare TEXT NOT NULL DEFAULT 'nevalidat',
      introdus_de     TEXT,
      creat_la        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_istoric_preturi_articol ON istoric_preturi(colectie, cod);

    -- Rezultatul verificarii de completitudine (src/completitudine.js) -- o
    -- linie per activitate ceruta de documentatia licitatiei, cu verdictul
    -- daca devizul o acopera. Rerulata = sterge-si-reinsereaza (nu adauga la
    -- infinit -- vezi salveazaVerificariCompletitudine), ca raportul sa
    -- reflecte mereu ultima verificare, nu un amestec de rulari vechi si noi.
    CREATE TABLE IF NOT EXISTS verificari_completitudine (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      proiect_id        INTEGER NOT NULL REFERENCES proiecte(id),
      activitate        TEXT NOT NULL,
      stare             TEXT NOT NULL,
      detaliu           TEXT,
      linii_asociate_json TEXT,
      creat_la          TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_verificari_completitudine_proiect ON verificari_completitudine(proiect_id);
  `);
  // "CREATE TABLE IF NOT EXISTS" nu atinge un tabel deja existent -- pe o
  // baza creata inainte de aceasta coloana, ea n-ar aparea niciodata fara
  // asta. Adaugata o singura data, sigur (verifica intai daca lipseste).
  adaugaColoana('antemasuratoare_linii', 'cod_dat', 'TEXT');
  // "firma_id" -- NULL pe devize.db (instrumentul intern, fara conturi), mereu
  // completat pe public.db. Coloana e comuna (schema partajata intre cele
  // doua fisiere), dar interogarile scopate pe firma (mai jos) nu ruleaza
  // niciodata pe devize.db -- panou.js (intern) nu le foloseste deloc.
  adaugaColoana('proiecte', 'firma_id', 'INTEGER');
  adaugaColoana('rezolutii_matching', 'nota', 'TEXT');
  // SQLite nu permite UNIQUE pe o coloana adaugata prin ALTER -- unicitatea
  // pentru "utilizator" (pe o baza deja existenta) se verifica in cod, in
  // firmePublic.creeaza(), la fel ca pentru orice alta baza noua oricum.
  adaugaColoana('firme', 'utilizator', 'TEXT');
  // Scopul proiectului (produs + nivel_livrare + activitati), extras din
  // documentatia licitatiei -- vezi src/scopProiect.js si comanda
  // "importa-licitatie". NULL pentru proiectele incarcate manual (flux
  // vechi, fara nicio legatura cu licitatie-analiza).
  adaugaColoana('proiecte', 'scop_json', 'TEXT');

  // Pentru linii generate de "predefineste" (vezi src/generareDeviz.js), nu
  // incarcate dintr-un document real: cantitatea nu apare explicit in
  // documentatie, deci ramane necunoscuta -- NU o inventam. "cantitate" ramane
  // 0 (coloana e NOT NULL), dar "cantitate_necunoscuta"=1 e semnul autoritar --
  // construiesteDeviz() (deviz.js) refuza sa genereze devizul cat timp mai
  // exista linii asa, ca un total gresit (subevaluat) sa nu iasa tacut.
  // "cantitate_sursa" -- citatul/locul din documentatie de unde vine cifra,
  // cand a fost gasita (populat si pentru liniile CU cantitate cunoscuta).
  adaugaColoana('antemasuratoare_linii', 'cantitate_necunoscuta', 'INTEGER DEFAULT 0');
  adaugaColoana('antemasuratoare_linii', 'cantitate_sursa', 'TEXT');

  // Suprascrieri de model per task (vezi src/ai.js, cheama()) -- acelasi
  // tipar ca in recrutare-bot. "rol" e una din cele 3 chei fixe (ROLURI_MODEL,
  // mai jos), acelasi nume ca variabila din .env pe care o suprascrie. Fara
  // rand aici = foloseste implicitul din .env, neschimbat. Citita per apel,
  // nu la pornirea procesului -- o schimbare din pagina de Setari se aplica
  // la urmatorul apel, fara restart.
  db.exec(`
    CREATE TABLE IF NOT EXISTS setari_model (
      rol           TEXT PRIMARY KEY,
      model_slug    TEXT NOT NULL,
      actualizat_la TEXT NOT NULL
    );
  `);
  return db;
}

function adaugaColoana(tabel, coloana, definitie) {
  const are = db.prepare(`PRAGMA table_info(${tabel})`).all().some((c) => c.name === coloana);
  if (!are) db.exec(`ALTER TABLE ${tabel} ADD COLUMN ${coloana} ${definitie}`);
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

/** Un cod EXACT, cautat in toate colectiile deodata -- pentru "incarca-deviz",
 * unde devizul impus poate veni deja cu codul de nomenclator scris, fara sa
 * spuna din ce colectie (acelasi cod poate exista in mai multe colectii, cu
 * sensuri diferite -- de-aia se intorc TOATE potrivirile, nu doar prima). */
const cautaDupaCodExact = (cod) =>
  (db ? db.prepare('SELECT colectie, cod, unitate, descriere, pret, tip FROM nomenclator_articole WHERE cod = ?').all(cod) : []);

// ─── Proiecte ─────────────────────────────────────────────────────────────

function creeazaProiect(nume, fisierSursa) {
  const r = db.prepare('INSERT INTO proiecte (nume, creat_la, fisier_sursa) VALUES (?,?,?)').run(nume, acum(), fisierSursa || null);
  return Number(r.lastInsertRowid);
}

const proiectDupaId = (id) => db.prepare('SELECT * FROM proiecte WHERE id = ?').get(id);
const toateProiectele = () => db.prepare('SELECT * FROM proiecte ORDER BY id DESC').all();
const actualizeazaStareProiect = (id, stare) => db.prepare('UPDATE proiecte SET stare = ? WHERE id = ?').run(stare, id);

/** Scopul proiectului (produs/nivel_livrare/activitati, vezi scopProiect.js),
 * salvat ca JSON -- un singur camp, nu un tabel nou, fiindca se citeste mereu
 * intreg, niciodata interogat pe bucati. */
function actualizeazaScopProiect(id, scop) {
  db.prepare('UPDATE proiecte SET scop_json = ? WHERE id = ?').run(JSON.stringify(scop), id);
}

// ─── Linii de antemasuratoare ────────────────────────────────────────────────

/** @param {Array<{ordine, capitol, denumire, cantitate, unitate, cod_dat?, cantitateNecunoscuta?, cantitateSursa?}>} linii */
function insereazaLiniiAntemasuratoare(proiectId, linii) {
  if (!linii?.length) return;
  const ins = db.prepare(`INSERT INTO antemasuratoare_linii
    (proiect_id, ordine, capitol, denumire, cantitate, unitate, cod_dat, cantitate_necunoscuta, cantitate_sursa)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  db.exec('BEGIN');
  try {
    for (const l of linii) {
      ins.run(proiectId, l.ordine, l.capitol || 'Nespecificat', l.denumire, l.cantitate, l.unitate,
        l.cod_dat || null, l.cantitateNecunoscuta ? 1 : 0, l.cantitateSursa || null);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const liniiPeProiect = (proiectId) => db.prepare('SELECT * FROM antemasuratoare_linii WHERE proiect_id = ? ORDER BY ordine').all(proiectId);

// ─── Rezolutii de matching ───────────────────────────────────────────────────

/** @param {{stare, colectie, cod, scor, candidati_json, nota?}} rezolutie */
function salveazaRezolutie(linieId, rezolutie) {
  db.prepare(`INSERT INTO rezolutii_matching (linie_id, colectie, cod, scor, stare, candidati_json, nota, rezolvat_la)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(linie_id) DO UPDATE SET
      colectie = excluded.colectie, cod = excluded.cod, scor = excluded.scor, stare = excluded.stare,
      candidati_json = excluded.candidati_json, nota = excluded.nota, rezolvat_la = excluded.rezolvat_la`)
    .run(linieId, rezolutie.colectie || null, rezolutie.cod || null, rezolutie.scor ?? null,
      rezolutie.stare, rezolutie.candidati_json || '[]', rezolutie.nota || null, acum());
}

// Intoarce {denumire} liniei confirmate -- apelantii (rutele de rezolutie)
// au nevoie de ea ca sa scrie in BFLA (cheia experientei e denumirea), fara
// sa mai faca o interogare separata doar pentru atat.
function confirmaRezolutie(linieId, colectie, cod) {
  db.prepare(`UPDATE rezolutii_matching SET colectie = ?, cod = ?, stare = 'confirmat', rezolvat_la = ? WHERE linie_id = ?`)
    .run(colectie, cod, acum(), linieId);
  return db.prepare('SELECT denumire FROM antemasuratoare_linii WHERE id = ?').get(linieId);
}

/** Liniile unui proiect, cu rezolutia lor de matching alaturata (LEFT JOIN --
 * o linie fara nicio rezolutie inca tot trebuie sa apara, cu stare NULL). */
const liniiCuRezolutiiPeProiect = (proiectId) => db.prepare(`
  SELECT l.*, r.colectie, r.cod, r.scor, r.stare, r.candidati_json, r.nota
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

// ─── Istoric de preturi (provenienta completa, DEVIZE_ARCHITECTURE.md §9) ────

const TIPURI_SURSA_PRET = ['MARKET_ESTIMATE', 'SUPPLIER_QUOTE', 'CONTRACTOR_QUOTE', 'NEGOTIATED_PRICE', 'CONTRACTED_PRICE', 'ACTUAL_COST'];

/** Inregistreaza o OBSERVATIE de pret, cu proveniata completa -- nu suprascrie
 * nimic (spre deosebire de salveazaPretCurent). Aditiv la "preturi_curente",
 * care ramane neschimbat si continua sa fie sursa folosita de deviz.js. */
function adaugaIstoricPret({
  colectie, cod, pret, moneda, tvaInclus, tipSursa, furnizor, documentSursa,
  proiectId, firmaId, localitate, valabilPana, statusValidare, introdusDe,
}) {
  if (!colectie || !cod) throw new Error('colectie si cod sunt obligatorii');
  if (!Number.isFinite(pret)) throw new Error('pretul trebuie sa fie un numar');
  if (!TIPURI_SURSA_PRET.includes(tipSursa)) {
    throw new Error(`tip_sursa necunoscut: "${tipSursa}" (asteptat unul din: ${TIPURI_SURSA_PRET.join(', ')})`);
  }
  db.prepare(`INSERT INTO istoric_preturi
      (colectie, cod, pret, moneda, tva_inclus, tip_sursa, furnizor, document_sursa,
       proiect_id, firma_id, localitate, valabil_pana, status_validare, introdus_de, creat_la)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      colectie, cod, pret, moneda || 'RON', tvaInclus ? 1 : 0, tipSursa,
      furnizor || null, documentSursa || null, proiectId || null, firmaId || null,
      localitate || null, valabilPana || null, statusValidare || 'nevalidat', introdusDe || null, acum(),
    );
}

/** Istoricul de preturi observate pentru un articol, cel mai recent primul. */
const istoricPreturiPentruArticol = (colectie, cod, limita = 50) => db.prepare(
  'SELECT * FROM istoric_preturi WHERE colectie = ? AND cod = ? ORDER BY creat_la DESC LIMIT ?',
).all(colectie, cod, limita);

/** Ca adaugaIstoricPret, dar nu arunca niciodata -- de folosit chiar langa
 * salveazaPretCurent/salveazaPretCurentFirma, ca o eroare la LOGUL de
 * proveniata (bug, camp lipsa) sa nu strice niciodata SALVAREA reala a
 * pretului, care s-a facut deja. Doar un warning in consola. */
function adaugaIstoricPretSigur(campuri) {
  try {
    adaugaIstoricPret(campuri);
  } catch (e) {
    console.warn(`[istoric_preturi] nu am putut inregistra provenienta (pretul curent tot s-a salvat): ${e.message}`);
  }
}

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

// ─── Preturi + resurse, scopate pe firma (public.db) ────────────────────────
// Aceleasi doua functii de mai sus (salveazaPretCurent, resurseAgregatePeProiect)
// NU se ating -- ele raman legate de cache-ul GLOBAL, intern. Astea cauta/scriu
// in "preturi_curente_firma", niciodata in "preturi_curente".

function salveazaPretCurentFirma(firmaId, colectie, cod, pret) {
  db.prepare(`INSERT INTO preturi_curente_firma (firma_id, colectie, cod, pret, actualizat_la) VALUES (?,?,?,?,?)
    ON CONFLICT(firma_id, colectie, cod) DO UPDATE SET pret = excluded.pret, actualizat_la = excluded.actualizat_la`)
    .run(firmaId, colectie, cod, pret, acum());
}
const pretCurentFirma = (firmaId, colectie, cod) =>
  db.prepare('SELECT pret FROM preturi_curente_firma WHERE firma_id = ? AND colectie = ? AND cod = ?').get(firmaId, colectie, cod)?.pret ?? null;

const resurseAgregatePeProiectFirma = (proiectId, firmaId) => db.prepare(`
  SELECT r.*, COALESCE(p.pret, 0) pret_curent
  FROM resurse_agregate r LEFT JOIN preturi_curente_firma p ON p.firma_id = ? AND p.colectie = r.colectie AND p.cod = r.cod
  WHERE r.proiect_id = ? ORDER BY r.tip, r.descriere
`).all(firmaId, proiectId);

// ─── Proiecte scopate pe firma (public.db, vezi public-server.js) ───────────
// Functiile de mai sus (creeazaProiect, proiectDupaId, toateProiectele) NU se
// ating -- panou.js (instrumentul intern) continua sa le foloseasca exact ca
// azi. Astea de-aici sunt in plus, folosite STRICT de public-server.js, ca
// niciun proiect al unei firme sa nu poata fi cerut/vazut fara sa treaca prin
// firma_id-ul din sesiune -- niciodata doar dupa un id de proiect brut,
// nesigur, venit din URL.
function creeazaProiectPentruFirma(nume, fisierSursa, firmaId) {
  const r = db.prepare('INSERT INTO proiecte (nume, creat_la, fisier_sursa, firma_id) VALUES (?,?,?,?)')
    .run(nume, acum(), fisierSursa || null, firmaId);
  return Number(r.lastInsertRowid);
}
const proiectePeFirma = (firmaId) => db.prepare('SELECT * FROM proiecte WHERE firma_id = ? ORDER BY id DESC').all(firmaId);
const proiectDupaIdSiFirma = (id, firmaId) => db.prepare('SELECT * FROM proiecte WHERE id = ? AND firma_id = ?').get(id, firmaId);

// ─── Verificare completitudine (src/completitudine.js) ──────────────────────

/** Sterge-si-reinsereaza -- o rerulare a verificarii inlocuieste raportul
 * vechi, nu-l aduna la el (vezi comentariul de la CREATE TABLE). */
function salveazaVerificariCompletitudine(proiectId, verificari) {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM verificari_completitudine WHERE proiect_id = ?').run(proiectId);
    const ins = db.prepare(`INSERT INTO verificari_completitudine
      (proiect_id, activitate, stare, detaliu, linii_asociate_json, creat_la) VALUES (?,?,?,?,?,?)`);
    const acumStamp = acum();
    for (const v of verificari) {
      ins.run(proiectId, v.activitate, v.stare, v.detaliu || null, JSON.stringify(v.linii_asociate || []), acumStamp);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
const verificariCompletitudinePeProiect = (proiectId) =>
  db.prepare('SELECT * FROM verificari_completitudine WHERE proiect_id = ? ORDER BY id').all(proiectId);

// ─── Firme ────────────────────────────────────────────────────────────────

function creeazaFirma({ nume, utilizator, email, sare, hash }) {
  const r = db.prepare('INSERT INTO firme (nume, utilizator, email, hash_parola, sare, creat_la) VALUES (?,?,?,?,?,?)')
    .run(nume, utilizator || null, email, hash, sare, acum());
  return Number(r.lastInsertRowid);
}
const firmaDupaEmail = (email) => db.prepare('SELECT * FROM firme WHERE email = ?').get(email);
const firmaDupaId = (id) => db.prepare('SELECT * FROM firme WHERE id = ?').get(id);
// Randuri COMPLETE (inclusiv hash_parola/sare) -- STRICT pentru potrivirea de
// login din firmePublic.autentifica() (fuzzy pe "utilizator" SAU "nume",
// acelasi tipar ca licitatie-analiza/utilizatori.js), niciodata expusa direct
// pe vreo ruta publica.
const toateFirmeleComplet = () => db.prepare('SELECT * FROM firme').all();
// Varianta SIGURA (fara hash_parola/sare), pentru afisare/listare.
const toateFirmele = () => db.prepare('SELECT id, nume, utilizator, email, parola_temporara, creat_la, ultima_intrare, dezactivat FROM firme ORDER BY id').all();
function actualizeazaParolaFirma(firmaId, sare, hash, parolaTemporara) {
  db.prepare('UPDATE firme SET sare = ?, hash_parola = ?, parola_temporara = ? WHERE id = ?')
    .run(sare, hash, parolaTemporara ? 1 : 0, firmaId);
}
const actualizeazaUltimaIntrareFirma = (firmaId) => db.prepare('UPDATE firme SET ultima_intrare = ? WHERE id = ?').run(acum(), firmaId);
const actualizeazaUtilizatorFirma = (firmaId, utilizator) => db.prepare('UPDATE firme SET utilizator = ? WHERE id = ?').run(utilizator, firmaId);

// ─── Sesiuni publice ──────────────────────────────────────────────────────
// In sqlite (nu in memorie/fisier JSON ca la licitatie-analiza) -- devize-auto
// tine deja tot restul in sqlite, nu are sens un al doilea mecanism de
// persistenta doar pentru sesiuni.

function insereazaSesiunePublica(token, firmaId, expiraLa) {
  db.prepare('INSERT INTO sesiuni_publice (token, firma_id, creat_la, expira_la) VALUES (?,?,?,?)')
    .run(token, firmaId, acum(), expiraLa);
}
function sesiunePublica(token) {
  const s = db.prepare('SELECT * FROM sesiuni_publice WHERE token = ?').get(token);
  if (!s) return null;
  if (new Date(s.expira_la).getTime() < Date.now()) { stergeSesiunePublica(token); return null; }
  return s;
}
const stergeSesiunePublica = (token) => db.prepare('DELETE FROM sesiuni_publice WHERE token = ?').run(token);

// ─── Suprascrieri de model per task ───────────────────────────────────────
// Cele 3 roluri fixe -- acelasi nume ca variabila din .env pe care o
// suprascriu (vezi src/ai.js si MODEL din antemasuratoare.js/scopProiect.js/
// completitudine.js). Un set FIX, nu text liber, ca pagina de Setari sa nu
// ghiceasca ce rol trimite.
const ROLURI_MODEL = ['MODEL_EXTRAGERE', 'MODEL_SCOP', 'MODEL_COMPLETITUDINE', 'MODEL_DESCOMPUNERE', 'MODEL_CANTITATI'];

/** Toate suprascrierile active, ca {rol: model_slug}. Poate fi gol. */
function setariModel() {
  if (!db) return {};
  const randuri = db.prepare('SELECT rol, model_slug FROM setari_model').all();
  const rezultat = {};
  for (const r of randuri) rezultat[r.rol] = r.model_slug;
  return rezultat;
}

/**
 * Seteaza (sau sterge, cu '') suprascrierea de model pentru un rol. Validare
 * stricta pe rol (vezi ROLURI_MODEL) -- un rol necunoscut arunca, nu se
 * salveaza tacit o cheie pe care nimeni n-ar mai gasi-o. modelSlug gol
 * revine la implicitul din .env (sterge randul), nu e o eroare.
 */
function seteazaModelRol(rol, modelSlug) {
  if (!db) return;
  if (!ROLURI_MODEL.includes(rol)) throw new Error(`Rol de model necunoscut: "${rol}"`);
  const curat = String(modelSlug || '').trim();
  if (!curat) { db.prepare('DELETE FROM setari_model WHERE rol = ?').run(rol); return; }
  db.prepare(`
    INSERT INTO setari_model (rol, model_slug, actualizat_la) VALUES (?, ?, ?)
    ON CONFLICT(rol) DO UPDATE SET model_slug = excluded.model_slug, actualizat_la = excluded.actualizat_la
  `).run(rol, curat, acum());
}

module.exports = {
  deschide,
  stergeNomenclator, insereazaArticoleNomenclator, insereazaDescompuneriNomenclator,
  reconstruiesteNomenclatorFts, statisticiNomenclator, cautaNomenclator, cautaArticol, cautaDupaCodExact, copiiDescompunere,
  creeazaProiect, proiectDupaId, toateProiectele, actualizeazaStareProiect, actualizeazaScopProiect,
  insereazaLiniiAntemasuratoare, liniiPeProiect, liniiCuRezolutiiPeProiect,
  salveazaRezolutie, confirmaRezolutie,
  salveazaPretCurent, pretCurent,
  adaugaIstoricPret, adaugaIstoricPretSigur, istoricPreturiPentruArticol, TIPURI_SURSA_PRET,
  stergeResurseAgregate, adaugaResursaAgregata, resurseAgregatePeProiect,
  salveazaVerificariCompletitudine, verificariCompletitudinePeProiect,
  creeazaProiectPentruFirma, proiectePeFirma, proiectDupaIdSiFirma,
  salveazaPretCurentFirma, pretCurentFirma, resurseAgregatePeProiectFirma,
  creeazaFirma, firmaDupaEmail, firmaDupaId, toateFirmele, toateFirmeleComplet,
  actualizeazaParolaFirma, actualizeazaUltimaIntrareFirma, actualizeazaUtilizatorFirma,
  insereazaSesiunePublica, sesiunePublica, stergeSesiunePublica,
  setariModel, seteazaModelRol, ROLURI_MODEL,
};
