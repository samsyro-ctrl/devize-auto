// src/devizeCastigate.js
// Client pentru API-ul de devize VECHI CASTIGATOARE (Aiud, Deva, Panciu,
// Vaslui, Zam), expus prin Core API de sesiunea "Server" (12.09.2026) --
// GET /api/devize-castigate, /api/devize-castigate/:proiect,
// /api/devize-castigate/:proiect/fisier. Domeniul "devize" e deja autorizat
// pe token-ul de serviciu existent, nimic nou de configurat.
//
// Acelasi tipar ca documenteServer.js (Bearer, timeout, 404/403 tratate
// distinct) -- NU citeste direct /root/scratch (cale locala, valabila doar
// pe acest server) -- prin API, ca sursa sa ramana aceeasi indiferent unde
// ruleaza devize-auto.
'use strict';

const fs = require('fs');
const path = require('path');

const BAZA = process.env.CORE_API_URL || 'http://127.0.0.1:8092';
const TOKEN = process.env.CORE_API_TOKEN || null;
const TIMEOUT_MS = 15000;
const TIMEOUT_DESCARCARE_MS = 30000;

async function cerereJson(cale, timeoutMs) {
  if (!TOKEN) throw new Error('CORE_API_TOKEN nu e setat -- integrarea cu Core API (devize-castigate) nu e configurata pe acest server.');
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const raspuns = await fetch(`${BAZA}${cale}`, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    if (raspuns.status === 404) {
      const corp = await raspuns.json().catch(() => ({}));
      const eroare = new Error(corp.eroare || 'proiectul nu a fost gasit pe server');
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
    if (err.name === 'AbortError') throw new Error('Core API (devize-castigate) nu a raspuns la timp -- incearca din nou.');
    if (err instanceof TypeError) throw new Error('Nu am putut ajunge la Core API -- verifica daca buildandfix-core ruleaza.');
    throw err;
  } finally {
    clearTimeout(t);
  }
}

/** Numele celor 5 proiecte disponibile (Aiud, Deva, Panciu, Vaslui, Zam). */
async function listaProiecte() {
  const raspuns = await cerereJson('/api/devize-castigate', TIMEOUT_MS);
  const corp = await raspuns.json();
  return corp.proiecte; // string[]
}

/** Toate fisierele (.xlsx) unui proiect, recursiv -- metadate, fara continut. */
async function listaFisiere(proiect) {
  const raspuns = await cerereJson(`/api/devize-castigate/${encodeURIComponent(proiect)}`, TIMEOUT_MS);
  return raspuns.json(); // { proiect, numarFisiere, fisiere: [{cale, nume, marime, tip}] }
}

/** Descarca bytes-ii unui fisier (cale relativa din listaFisiere) si-i scrie local. */
async function descarcaFisier(proiect, caleRelativa, caleLocala) {
  const url = new URL(`/api/devize-castigate/${encodeURIComponent(proiect)}/fisier`, BAZA);
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
      throw new Error(corp.eroare || `Descarcarea "${caleRelativa}" (${proiect}) a esuat (${raspuns.status}).`);
    }
    fs.mkdirSync(path.dirname(caleLocala), { recursive: true });
    const buf = Buffer.from(await raspuns.arrayBuffer());
    fs.writeFileSync(caleLocala, buf);
    return buf.length;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Descarcarea "${caleRelativa}" (${proiect}) nu a raspuns la timp -- incearca din nou.`);
    if (err instanceof TypeError) throw new Error('Nu am putut ajunge la Core API -- verifica daca buildandfix-core ruleaza.');
    throw err;
  } finally {
    clearTimeout(t);
  }
}

module.exports = {
  listaProiecte, listaFisiere, descarcaFisier, ACTIV: Boolean(TOKEN),
};
