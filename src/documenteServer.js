// src/documenteServer.js
// Gaseste si clasifica documentele unei licitatii direct din mirror-ul
// SharePoint sincronizat pe server, PRIN Core API (buildandfix-core,
// src/documente.js + rutele /api/documente/:cod din server.js -- construite
// de sesiunea "Server", 11.09.2026). Completeaza dosarLicitatie.js: acela
// citeste doar dosare DEJA descarcate manual in licitatie-analiza/dosare/<id>
// (bun pentru licitatii analizate GO/NO-GO) -- multe licitatii "IN LUCRU
// pentru depunere" (ex. SCN1179408) nu au deloc dosar acolo, dar au
// documentele PT reale in arborele SharePoint. Aceeasi forma de rezultat ca
// dosarLicitatie.documenteDinDosar (peClasa: {clasa: [{nume, cale, clasa}]}),
// ca appelantii (comandaImportaLicitatie/comandaPredefineste) sa nu stie de
// unde vin documentele.
//
// Spre deosebire de dosarLicitatie (citire locala, gratuita), aici fiecare
// fisier descarcat costa o cerere HTTP -- de-aia descarcam bytes DOAR pentru
// clasele chiar folosite mai departe (liste_cantitati/caiet_sarcini/
// fisa_date/clarificari), nu tot dosarul (planuri CAD, formulare etc. pot fi
// zeci de MB, fara sa fie nevoie de ele aici).
//
// Fara decodare .p7s -- ramane limitare cunoscuta (semnalata explicit prin
// avertisment daca apar), la fel ca in dosarLicitatie.js (acolo problema nu
// apare pentru ca licitatie-analiza desface deja plicurile inainte).
'use strict';

const fs = require('fs');
const path = require('path');

const { clasifica, ESTE_LIZIBIL, ESTE_P7S } = require('./dosarLicitatie');

const BAZA = process.env.CORE_API_URL || 'http://127.0.0.1:8092';
const TOKEN = process.env.CORE_API_TOKEN || null;
const TIMEOUT_MS = 15000;
const TIMEOUT_DESCARCARE_MS = 60000; // fisiere PT pot fi mari (zeci de MB)

// Doar clasele chiar consumate de comandaImportaLicitatie/comandaPredefineste
// (vezi cli.js) merita costul unei descarcari.
const CLASE_DE_DESCARCAT = new Set(['liste_cantitati', 'caiet_sarcini', 'fisa_date', 'clarificari']);

function normalizeazaCod(cod) {
  return String(cod).trim().toUpperCase();
}

async function cerereJson(cale, timeoutMs) {
  if (!TOKEN) throw new Error('CORE_API_TOKEN nu e setat -- integrarea cu Core API (documente) nu e configurata pe acest server.');
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const raspuns = await fetch(`${BAZA}${cale}`, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    if (raspuns.status === 404) {
      const corp = await raspuns.json().catch(() => ({}));
      const eroare = new Error(corp.eroare || 'documentul nu a fost gasit pe server');
      eroare.status = 404;
      throw eroare;
    }
    if (!raspuns.ok) {
      const corp = await raspuns.json().catch(() => ({}));
      throw new Error(corp.eroare || `Core API a raspuns cu eroare (${raspuns.status}).`);
    }
    return raspuns;
  } catch (err) {
    if (err.status === 404) throw err;
    if (err.name === 'AbortError') throw new Error('Core API (documente) nu a raspuns la timp -- incearca din nou.');
    if (err instanceof TypeError) throw new Error('Nu am putut ajunge la Core API -- verifica daca buildandfix-core ruleaza.');
    throw err;
  } finally {
    clearTimeout(t);
  }
}

/** Lista de fisiere (metadate, fara continut) pentru codul SCN/CN dat. */
async function listaFisiere(cod) {
  const raspuns = await cerereJson(`/api/documente/${encodeURIComponent(normalizeazaCod(cod))}`, TIMEOUT_MS);
  const corp = await raspuns.json();
  return corp; // { statusLicitatie, folder, numarFisiere, fisiere: [{cale, nume, marime, tip}] }
}

/** Descarca bytes-ii unui fisier (cale relativa din listaFisiere) si-i scrie local. */
async function descarcaFisier(cod, caleRelativa, caleLocala) {
  const url = new URL(`/api/documente/${encodeURIComponent(normalizeazaCod(cod))}/fisier`, BAZA);
  url.searchParams.set('cale', caleRelativa);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_DESCARCARE_MS);
  try {
    const raspuns = await fetch(url, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    if (!raspuns.ok) {
      const corp = await raspuns.json().catch(() => ({}));
      throw new Error(corp.eroare || `Descarcarea "${caleRelativa}" a esuat (${raspuns.status}).`);
    }
    fs.mkdirSync(path.dirname(caleLocala), { recursive: true });
    const buf = Buffer.from(await raspuns.arrayBuffer());
    fs.writeFileSync(caleLocala, buf);
    return buf.length;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Descarcarea "${caleRelativa}" nu a raspuns la timp -- incearca din nou.`);
    if (err instanceof TypeError) throw new Error('Nu am putut ajunge la Core API -- verifica daca buildandfix-core ruleaza.');
    throw err;
  } finally {
    clearTimeout(t);
  }
}

/** Nume de fisier local, unic pe dosarul de descarcare (clasa + nume original). */
function numeLocal(clasa, numeOriginal) {
  return `${clasa}__${numeOriginal}`.replace(/[^A-Za-z0-9_.\-]/g, '_');
}

/**
 * Documentele unei licitatii, gasite si clasificate direct din mirror-ul
 * SharePoint (prin Core API), grupate pe clasa -- aceeasi forma ca
 * dosarLicitatie.documenteDinDosar. Descarca local (in `dirDescarcare`) DOAR
 * fisierele din clasele chiar folosite mai departe.
 * @param {string} cod -- codul SCN/CN al licitatiei (ex. "SCN1179408").
 * @param {string} dirDescarcare -- folder local unde se scriu fisierele descarcate.
 * @param {string[]} [avertismente]
 * @returns {Promise<Object<string, Array<{nume, cale, clasa}>>>}
 * @throws {Error} daca nu exista niciun dosar pe server pentru acest cod, sau
 *   Core API nu e configurat/accesibil.
 */
async function documenteDinServer(cod, dirDescarcare, avertismente = []) {
  let raspuns;
  try {
    raspuns = await listaFisiere(cod);
  } catch (err) {
    if (err.status === 404) {
      throw new Error(`Niciun dosar de documente gasit pe server pentru codul "${cod}" -- verifica daca licitatia e sincronizata din SharePoint (vezi /api/stare pe Core API) si daca ai dat codul corect.`);
    }
    throw err;
  }

  const p7sIgnorate = raspuns.fisiere.filter((f) => ESTE_P7S.test(f.nume));
  if (p7sIgnorate.length) {
    avertismente.push(`${p7sIgnorate.length} documente .p7s/.p7m ignorate (plicuri de semnatura nedesfacute) -- ${p7sIgnorate.map((f) => f.nume).join(', ')}.`);
  }

  const lizibile = raspuns.fisiere.filter((f) => ESTE_LIZIBIL.test(f.nume));
  const documente = clasifica(lizibile.map((f) => ({ nume: f.nume, caleServer: f.cale })));

  const peClasa = {};
  for (const d of documente) {
    if (!peClasa[d.clasa]) peClasa[d.clasa] = [];
    peClasa[d.clasa].push(d);
  }

  for (const clasa of CLASE_DE_DESCARCAT) {
    for (const d of peClasa[clasa] || []) {
      const caleLocala = path.join(dirDescarcare, numeLocal(clasa, d.nume));
      // eslint-disable-next-line no-await-in-loop
      await descarcaFisier(cod, d.caleServer, caleLocala);
      d.cale = caleLocala;
    }
  }

  return peClasa;
}

module.exports = { documenteDinServer, listaFisiere, descarcaFisier, ACTIV: Boolean(TOKEN) };
