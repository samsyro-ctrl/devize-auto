// src/dosarLicitatie.js
// Gaseste si clasifica documentele unei licitatii urmarite in licitatie-analiza
// (dosare/<id>/), ca sa poata fi folosite aici, in devize-auto, fara sa
// duplicam munca de descarcare/dezarhivare/desfacere .p7s deja facuta acolo.
//
// Taxonomia (CLASE) e copiata aproape neschimbat din
// licitatie-analiza/src/extract.js (liniile 227-254) -- deja testata in
// productie pe documentatii SICAP reale, nu are sens sa fie reinventata.
// Simplificata fata de original: fara "prioritate"/"trimite" (concepte legate
// de decizia GO/NO-GO a analizei lor, nu de nevoia noastra -- doar clasa).
'use strict';

const fs = require('fs');
const path = require('path');

const CLASE = [
  { cheie: 'fisa_date',       rx: /fisa[ _-]?date|fisadate|instructiuni[ _-]?ofertant|instructiuni/i },
  { cheie: 'caiet_sarcini',   rx: /caiet[ _-]?de[ _-]?sarcini|caiet|memoriu[ _-]?tehnic|tema[ _-]?de[ _-]?proiectare/i },
  // Exclus explicit "angajament" -- "Contract_angajament..." e un acord de
  // conectare la utilitati, nu modelul de contract al licitatiei (acelasi
  // motiv ca in licitatie-analiza).
  { cheie: 'contract',        rx: /contract(?!.*angajament)/i },
  { cheie: 'clarificari',     rx: /clarificar|raspuns|erata|amendament/i },
  { cheie: 'liste_cantitati', rx: /list[ae][ _-]?(de[ _-]?)?cantitat|deviz|antemasurator|c[0-9]{1,2}\b|centralizator/i },
  { cheie: 'studiu_prealabil', rx: /(?:^|[\s_-])SF(?:[\s_-]|$)|\bDALI\b|studiu[ _-]?de[ _-]?fezabilitate|documentatie[ _-]?de[ _-]?avizare/i },
  { cheie: 'urbanism',        rx: /certificat[ _-]?de[ _-]?urbanism|(?:^|[\s_-])cu[_-]?\d{2,}|aviz|acord|autorizatie|angajament|AAFC/i },
  { cheie: 'desene',          rx: /plansa|planse|piese[ _-]?desenate|_arhitectura|_rezistenta|_sistematizare|_instalatii|pth|dtac|d\.?t\.?a\.?c|plan[ _-]?(de[ _-]?)?(situatie|amplasare)|profil[ _-]?longitudinal|sectiun\w*[ _-]?transversal|detalii|lucrari[ _-]?de[ _-]?consolidare|siguranta[ _-]?circulatiei|scurgerea[ _-]?apelor|instalatii[ _-]?electrice/i },
  { cheie: 'formulare',       rx: /formular|duae|model[ _-]?de[ _-]?scrisoare|anexa[ _-]?nr/i },
];

/** Adauga .clasa fiecarui document ("altele" daca nimic nu se potriveste). */
function clasifica(documente) {
  for (const d of documente) {
    const c = CLASE.find((x) => x.rx.test(d.nume));
    d.clasa = c ? c.cheie : 'altele';
  }
  return documente;
}

const ESTE_LIZIBIL = /\.(pdf|docx?|xlsx?|xlsm|txt|xml)$/i;
// Documentele semnate vin ca "<nume>.pdf.p7s" -- plicul PKCS#7 nu se poate citi
// direct, dar licitatie-analiza il desface deja in extras/_desemnate/<nume>.pdf
// (fara .p7s). Sarim orice .p7s/.p7m intalnit -- varianta lizibila exista deja
// altundeva in acelasi dosar, prin desfacerea facuta de ei.
const ESTE_P7S = /\.p7[sm]$/i;

/** Toate fisierele lizibile dintr-un folder, recursiv (dosarele SICAP au
 * subfoldere neregulate -- fisiere simple langa foldere de arhive .rar, langa
 * folderul "_desemnate" cu variantele desfacute din .p7s). Adancime limitata,
 * ca o arhiva neasteptat de adanca sa nu blocheze citirea. */
function listeazaRecursiv(dir, adancime = 0) {
  if (adancime > 4 || !fs.existsSync(dir)) return [];
  const rezultat = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const cale = path.join(dir, e.name);
    if (e.isDirectory()) {
      rezultat.push(...listeazaRecursiv(cale, adancime + 1));
    } else if (e.isFile() && ESTE_LIZIBIL.test(e.name) && !ESTE_P7S.test(e.name)) {
      rezultat.push({ nume: e.name, cale });
    }
  }
  return rezultat;
}

/**
 * Documentele unei licitatii urmarite in licitatie-analiza, grupate pe clasa.
 * @param {string} caleDosar -- de obicei `<LICITATIE_ANALIZA_DIR>/dosare/<idLicitatie>`.
 * @returns {Object<string, Array<{nume, cale, clasa}>>} ex. { caiet_sarcini: [...], fisa_date: [...], ... }
 * @throws {Error} daca dosarul nu exista deloc.
 */
function documenteDinDosar(caleDosar) {
  if (!fs.existsSync(caleDosar)) {
    throw new Error(`Nu gasesc dosarul licitatiei: ${caleDosar} (verifica LICITATIE_ANALIZA_DIR si id-ul).`);
  }
  const caleExtras = path.join(caleDosar, 'extras');
  const radacina = fs.existsSync(caleExtras) ? caleExtras : caleDosar;
  const fisiere = listeazaRecursiv(radacina);

  // Acelasi document poate exista de doua ori -- o data desfacut, in
  // "_desemnate/", o data ne-p7s dar cu alt nume in alta parte (rar). Cand
  // numele de fisier coincide, preferam varianta din "_desemnate" -- e cea pe
  // care licitatie-analiza a ales-o explicit ca "finala".
  const peNume = new Map();
  for (const f of fisiere) {
    const existent = peNume.get(f.nume);
    if (!existent || f.cale.includes(`${path.sep}_desemnate${path.sep}`)) peNume.set(f.nume, f);
  }

  const documente = clasifica([...peNume.values()]);
  const peClasa = {};
  for (const d of documente) {
    if (!peClasa[d.clasa]) peClasa[d.clasa] = [];
    peClasa[d.clasa].push(d);
  }
  return peClasa;
}

module.exports = { documenteDinDosar, clasifica, CLASE };
