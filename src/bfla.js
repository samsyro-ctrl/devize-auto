// src/bfla.js
// Client subtire catre BFLA, PRIN Core API (nu direct -- vezi
// buildandfix-platform/ARCHITECTURE.md Faza 1). Nu cunoastem niciodata
// tokenul intern al BFLA, doar tokenul nostru de serviciu (CORE_API_TOKEN).
// Tipar identic cu licitatie-analiza/src/bfla.js -- acelasi client, alt
// domeniu (decis server-side, de tokenul de serviciu al lui devize-auto).
//
// REGULA DE AUR: nimic de-aici nu trebuie sa poata bloca sau strica
// generarea unui deviz daca buildandfix-core sau BFLA sunt jos. Fiecare
// functie prinde orice eroare, are un timeout scurt, si intoarce o valoare
// "goala" sigura (null / []) in loc sa arunce.
'use strict';

const BAZA = process.env.CORE_API_URL || 'http://127.0.0.1:8092';
const TOKEN = process.env.CORE_API_TOKEN || null;
const TIMEOUT_MS = 3000;

async function cerere(cale, opt = {}) {
  if (!TOKEN) return null;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const raspuns = await fetch(`${BAZA}${cale}`, {
      ...opt,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
        ...(opt.headers || {}),
      },
    });
    const corp = await raspuns.json().catch(() => null);
    if (!raspuns.ok) {
      console.warn(`[bfla] ${opt.method || 'GET'} ${cale} -> HTTP ${raspuns.status}: ${corp?.eroare || ''}`);
      return null;
    }
    return corp;
  } catch (err) {
    console.warn(`[bfla] ${opt.method || 'GET'} ${cale} a esuat (ignorat, nu blocam devizul): ${err.message}`);
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Scrie o experienta validata (fire-and-forget din perspectiva apelantului --
 * niciodata nu arunca). Domeniul e mereu 'devize', decis de tokenul nostru
 * de serviciu pe Core API, nu trimis de-aici.
 */
function scrie({
  tip, cheie, continut, sursaRaw, validatDe, entitate, stare,
}) {
  return cerere('/api/experiente', {
    method: 'POST',
    body: JSON.stringify({
      tip, cheie, continut, sursaRaw, validatDe, entitate, stare,
    }),
  });
}

/**
 * Cauta experiente existente. Intoarce [] (nu null) daca nu gaseste/esueaza --
 * apelantul poate itera direct.
 * @param {string} [domeniu] implicit 'devize' (al nostru) -- citirea intre
 *   domenii e libera pe Core API (vezi buildandfix-core/src/server.js,
 *   GET /api/experiente), de-aia poate fi suprascris explicit cand vrem
 *   cunostinte dintr-un alt domeniu (ex. 'cautare', pentru furnizor_castigator).
 */
async function cauta({
  tip, cheie, entitate, limita, domeniu,
}) {
  const params = new URLSearchParams({ domeniu: domeniu || 'devize' });
  if (tip) params.set('tip', tip);
  if (cheie) params.set('cheie', cheie);
  if (entitate) params.set('entitate', entitate);
  if (limita) params.set('limita', String(limita));
  const raspuns = await cerere(`/api/experiente?${params.toString()}`);
  return raspuns?.rezultate || [];
}

module.exports = { scrie, cauta, ACTIV: Boolean(TOKEN) };
