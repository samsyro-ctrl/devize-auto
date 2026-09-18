-- Schema Postgres LIVE pentru devize-auto -- STRICT nomenclator (date de
-- referinta, partajate intre firme, fara firma_id/RLS -- la fel ca in
-- SQLite). Restul (proiecte/linii/rezolutii) ramane exclusiv in devize.db;
-- aceasta baza serveste DOAR retrieval-ul pt reranking AI (g1), niciodata
-- sistemul de adevar pt date tranzactionale.
--
-- Portata din migration-test/schema-devize.sql (buildandfix-core, Server),
-- redusa la tabelele strict necesare retrieval-ului.

BEGIN;

CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE OR REPLACE FUNCTION f_unaccent(text) RETURNS text AS $$
  SELECT unaccent('unaccent', $1)
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE;

CREATE TABLE IF NOT EXISTS nomenclator_articole (
  colectie   TEXT NOT NULL,
  cod        TEXT NOT NULL,
  unitate    TEXT,
  descriere  TEXT,
  pret       REAL,
  tip        INTEGER,
  descriere_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', f_unaccent(coalesce(descriere, '')))) STORED,
  PRIMARY KEY (colectie, cod)
);
CREATE INDEX IF NOT EXISTS idx_nomenclator_articole_tsv ON nomenclator_articole USING GIN (descriere_tsv);

CREATE TABLE IF NOT EXISTS nomenclator_descompuneri (
  colectie     TEXT NOT NULL,
  cod_parinte  TEXT NOT NULL,
  cod_copil    TEXT NOT NULL,
  cantitate    DOUBLE PRECISION NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nomenclator_desc_parinte ON nomenclator_descompuneri (colectie, cod_parinte);

COMMIT;
