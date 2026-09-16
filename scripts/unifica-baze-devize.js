// scripts/unifica-baze-devize.js
// Migrare UNICA (16.09.2026, cerut de Cristian direct -- vezi planul
// goofy-dazzling-bee.md): unifica devize.db (intern, pipeline/CLI/
// Orchestrator) cu public.db (devize.buildandfix.ai) intr-un singur fisier
// -- devize.db supravietuieste (are deja toate proiectele + referintele
// istorice; public.db n-avea decat 1 firma, 0 proiecte). Muta in devize.db
// tot ce era UNIC in public.db (firma, sesiuni active, preturi_curente_
// firma), apoi leaga toate proiectele interne existente de firma_id, si
// seedeaza preturi_curente_firma dintr-un instantaneu al cache-ului global
// (altfel Cristian ar vedea liniile in webapp, dar toate fara pret).
//
// SIGUR de rulat de mai multe ori (idempotent -- INSERT OR IGNORE, UPDATE
// ... WHERE firma_id IS NULL). NU sterge niciodata public.db -- doar il
// citeste. Face backup la devize.db INAINTE de orice scriere.
//
// Rulare (mod implicit = doar RAPORT, nimic scris):
//   node scripts/unifica-baze-devize.js
//   node scripts/unifica-baze-devize.js --scrie
//
// AI DE RULAT DOAR CU AMBELE SERVICII (devize-auto, devize-auto-panou)
// OPRITE -- altfel scrii intr-un fisier pe care un proces il tine deschis
// concurrent (busy_timeout ajuta la coliziuni scurte, nu la o migrare care
// tine tranzactia deschisa mai mult).
'use strict';

const fs = require('fs');
const path = require('path');

const SCRIE = process.argv.includes('--scrie');
const OUTPUT_DIR = path.join(__dirname, '..', 'output');
const CALE_DEVIZE = path.join(OUTPUT_DIR, 'devize.db');
const CALE_PUBLIC = path.join(OUTPUT_DIR, 'public.db');

function main() {
  if (!fs.existsSync(CALE_DEVIZE)) { console.error(`Nu gasesc ${CALE_DEVIZE}.`); process.exit(1); }
  if (!fs.existsSync(CALE_PUBLIC)) { console.error(`Nu gasesc ${CALE_PUBLIC}.`); process.exit(1); }

  const { DatabaseSync } = require('node:sqlite');

  console.log(`Mod: ${SCRIE ? 'SCRIU (--scrie)' : 'doar RAPORT, nimic scris -- ruleaza din nou cu --scrie ca sa chiar migreze'}.\n`);

  if (SCRIE) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const caleBackup = `${CALE_DEVIZE}.bak-${stamp}`;
    fs.copyFileSync(CALE_DEVIZE, caleBackup);
    console.log(`Backup scris: ${caleBackup}`);
  }

  // devize.db -- deschis INTAI prin modulul normal, o singura data, doar ca
  // sa ruleze migrarile de schema (adaugaColoana etc., exact ca la o
  // pornire normala de serviciu) -- apoi lucram direct pe fisier, fiindca
  // db.js nu expune conexiunea bruta (doar functii cu nume, fara prepare()
  // generic) si e un singleton -- nu poate tine si public.db deschis in
  // acelasi timp.
  require('../src/db').deschide(OUTPUT_DIR);
  const db = new DatabaseSync(CALE_DEVIZE);
  db.exec('PRAGMA busy_timeout = 5000');

  // public.db -- doar CITIT.
  const pub = new DatabaseSync(CALE_PUBLIC, { readOnly: true });

  // ─── 1. Firma (INSERT OR IGNORE -- pastreaza hash/sare EXACT cum erau) ───
  const firme = pub.prepare('SELECT * FROM firme').all();
  console.log(`\nFirme gasite in public.db: ${firme.length}`);
  firme.forEach((f) => console.log(`  id=${f.id} "${f.nume}" (${f.email})`));
  if (SCRIE) {
    const insFirma = db.prepare(`INSERT OR IGNORE INTO firme
      (id, nume, utilizator, email, hash_parola, sare, parola_temporara, creat_la, ultima_intrare, dezactivat)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    for (const f of firme) {
      insFirma.run(f.id, f.nume, f.utilizator, f.email, f.hash_parola, f.sare, f.parola_temporara, f.creat_la, f.ultima_intrare, f.dezactivat);
    }
  }

  // ─── 2. Sesiuni active (ca nimeni sa nu fie delogat de migrare) ───
  const acum = new Date().toISOString();
  const sesiuni = pub.prepare('SELECT * FROM sesiuni_publice WHERE expira_la > ?').all(acum);
  console.log(`\nSesiuni active gasite in public.db: ${sesiuni.length}`);
  if (SCRIE) {
    const insSesiune = db.prepare('INSERT OR IGNORE INTO sesiuni_publice (token, firma_id, creat_la, expira_la) VALUES (?,?,?,?)');
    for (const s of sesiuni) insSesiune.run(s.token, s.firma_id, s.creat_la, s.expira_la);
  }

  // ─── 3. preturi_curente_firma (azi 0 pe public.db, dar copiat defensiv) ───
  const preturiFirma = pub.prepare('SELECT * FROM preturi_curente_firma').all();
  console.log(`\npreturi_curente_firma gasite in public.db: ${preturiFirma.length}`);
  if (SCRIE) {
    const insPretFirma = db.prepare(`INSERT OR IGNORE INTO preturi_curente_firma (firma_id, colectie, cod, pret, actualizat_la) VALUES (?,?,?,?,?)`);
    for (const p of preturiFirma) insPretFirma.run(p.firma_id, p.colectie, p.cod, p.pret, p.actualizat_la);
  }

  // ─── 4. Proiectele interne -> firma_id (toate, inclusiv cele de test) ───
  const FIRMA_ID_INTERN = Number(process.env.FIRMA_ID_INTERN) || 2;
  const faraFirma = db.prepare('SELECT id, nume, cod_licitatie FROM proiecte WHERE firma_id IS NULL').all();
  console.log(`\nProiecte fara firma_id in devize.db: ${faraFirma.length}`);
  faraFirma.forEach((p) => console.log(`  #${p.id} "${p.nume}"${p.cod_licitatie ? ` (${p.cod_licitatie})` : ''}`));
  if (SCRIE) {
    db.prepare('UPDATE proiecte SET firma_id = ? WHERE firma_id IS NULL').run(FIRMA_ID_INTERN);
    console.log(`  -> legate de firma_id=${FIRMA_ID_INTERN}.`);
  }

  // ─── 5. Seedeaza preturi_curente_firma din snapshot-ul global (o singura
  // data -- fara asta, liniile deja pretuite intern ar aparea fara pret in
  // devize.buildandfix.ai, fiindca public-server.js citeste STRICT din
  // preturi_curente_firma, niciodata din cache-ul global). ───
  const global = db.prepare('SELECT colectie, cod, pret, actualizat_la FROM preturi_curente').all();
  console.log(`\npreturi_curente (cache global): ${global.length} randuri -- de seedat pt firma_id=${FIRMA_ID_INTERN}.`);
  if (SCRIE) {
    const seed = db.prepare(`INSERT OR IGNORE INTO preturi_curente_firma (firma_id, colectie, cod, pret, actualizat_la) VALUES (?,?,?,?,?)`);
    let seedate = 0;
    for (const p of global) { seed.run(FIRMA_ID_INTERN, p.colectie, p.cod, p.pret, p.actualizat_la); seedate += 1; }
    console.log(`  -> ${seedate} preturi seedate (INSERT OR IGNORE -- nu suprascrie un pret deja setat manual pe firma).`);
  }

  // ─── 6. setari_model -- raport de divergenta, NU suprascrie automat ───
  const setariDevize = db.prepare('SELECT * FROM setari_model').all();
  const setariPublic = pub.prepare('SELECT * FROM setari_model').all();
  const hartaDevize = new Map(setariDevize.map((s) => [s.rol, s]));
  const hartaPublic = new Map(setariPublic.map((s) => [s.rol, s]));
  console.log(`\nsetari_model -- devize.db: ${setariDevize.length} roluri, public.db: ${setariPublic.length} roluri.`);
  for (const [rol, sPublic] of hartaPublic) {
    const sDevize = hartaDevize.get(rol);
    if (!sDevize) {
      console.log(`  "${rol}": doar in public.db ("${sPublic.model_slug}") -- ${SCRIE ? 'NU copiat automat, decide manual daca vrei sa-l aplici' : '(raport)'}.`);
    } else if (sDevize.model_slug !== sPublic.model_slug) {
      console.log(`  "${rol}": DIVERGE -- devize.db="${sDevize.model_slug}" (${sDevize.actualizat_la}) vs public.db="${sPublic.model_slug}" (${sPublic.actualizat_la}) -- pastrat cel din devize.db, verifica manual daca cel din public.db era mai recent/corect.`);
    }
  }

  pub.close();
  db.close();
  console.log(`\n${SCRIE ? 'Migrare scrisa.' : 'Raport gata -- ruleaza cu --scrie ca sa chiar scrie.'}`);
}

main();
