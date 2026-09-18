// scripts/sincronizeaza-nomenclator-postgres.js
// g1 (reranking AI matching, 18.09.2026, cerut de Cristian direct): copiaza
// nomenclator_articole + nomenclator_descompuneri din devize.db (SQLite,
// sistemul de adevar) in baza Postgres LIVE "devize" (doar date de
// referinta, partajate intre firme, FARA firma_id -- la fel ca in SQLite).
// Retrieval-ul de reranking (src/rerankingPostgres.js) citeste DOAR de-aici;
// SQLite ramane singura sursa care se scrie -- acest script e cale unica de
// scriere in Postgres, intotdeauna dinspre SQLite, niciodata invers.
//
// Idempotent (UPSERT) -- sigur de rulat oricand nomenclatorul se schimba
// (import de colectie noua/actualizata), nu doar o singura data. NU atinge
// devize.db (citire read-only).
//
// Rulare: node scripts/sincronizeaza-nomenclator-postgres.js
// Are nevoie de variabilele standard `pg` (PGHOST/PGUSER/PGPASSWORD/
// PGDATABASE/PGPORT) in mediu -- vezi .env pe server.
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { Client } = require('pg');

const OUTPUT_DIR = path.join(__dirname, '..', 'output');
const CALE_DEVIZE = path.join(OUTPUT_DIR, 'devize.db');
const MARIME_LOT = 2000;

async function upsertLot(pg, tabel, coloane, conflictCols, randuri) {
  if (!randuri.length) return;
  const valori = [];
  const paranteze = randuri
    .map((rand, ri) => {
      const baza = ri * coloane.length;
      for (const c of coloane) valori.push(rand[c]);
      return `(${coloane.map((_, ci) => `$${baza + ci + 1}`).join(',')})`;
    })
    .join(',');
  const updateSet = coloane.filter((c) => !conflictCols.includes(c)).map((c) => `${c} = EXCLUDED.${c}`).join(',');
  await pg.query(
    `INSERT INTO ${tabel} (${coloane.join(',')}) VALUES ${paranteze}
     ON CONFLICT (${conflictCols.join(',')}) DO UPDATE SET ${updateSet}`,
    valori
  );
}

async function main() {
  if (!fs.existsSync(CALE_DEVIZE)) { console.error(`Nu gasesc ${CALE_DEVIZE}.`); process.exit(1); }

  const sqlite = new DatabaseSync(CALE_DEVIZE, { readOnly: true });
  const pg = new Client();
  await pg.connect();

  try {
    const articole = sqlite.prepare('SELECT colectie, cod, unitate, descriere, pret, tip FROM nomenclator_articole').all();
    console.log(`nomenclator_articole: ${articole.length} randuri in SQLite -- sincronizez...`);
    for (let i = 0; i < articole.length; i += MARIME_LOT) {
      const lot = articole.slice(i, i + MARIME_LOT);
      // eslint-disable-next-line no-await-in-loop
      await upsertLot(pg, 'nomenclator_articole', ['colectie', 'cod', 'unitate', 'descriere', 'pret', 'tip'], ['colectie', 'cod'], lot);
    }
    console.log(`nomenclator_articole: ${articole.length} randuri sincronizate.`);

    const descompuneri = sqlite.prepare('SELECT colectie, cod_parinte, cod_copil, cantitate FROM nomenclator_descompuneri').all();
    console.log(`nomenclator_descompuneri: ${descompuneri.length} randuri in SQLite -- resincronizez complet (fara cheie unica naturala)...`);
    // Fara PK natural pe (colectie,cod_parinte,cod_copil) in SQLite (poate
    // repeta cod_copil la cantitati diferite in teorie) -- mai sigur sa
    // sterg+reinserez complet decat sa incerc un UPSERT pe o cheie
    // presupusa unica care ar putea sa nu fie.
    await pg.query('TRUNCATE nomenclator_descompuneri');
    for (let i = 0; i < descompuneri.length; i += MARIME_LOT) {
      const lot = descompuneri.slice(i, i + MARIME_LOT);
      const valori = [];
      const paranteze = lot
        .map((rand, ri) => {
          const baza = ri * 4;
          valori.push(rand.colectie, rand.cod_parinte, rand.cod_copil, rand.cantitate);
          return `($${baza + 1},$${baza + 2},$${baza + 3},$${baza + 4})`;
        })
        .join(',');
      // eslint-disable-next-line no-await-in-loop
      await pg.query(`INSERT INTO nomenclator_descompuneri (colectie, cod_parinte, cod_copil, cantitate) VALUES ${paranteze}`, valori);
    }
    console.log(`nomenclator_descompuneri: ${descompuneri.length} randuri sincronizate.`);

    console.log('\nSincronizare completa.');
  } finally {
    sqlite.close();
    await pg.end();
  }
}

main().catch((err) => {
  console.error('EROARE:', err.stack);
  process.exitCode = 1;
});
