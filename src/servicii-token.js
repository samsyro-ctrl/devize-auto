// src/servicii-token.js
// Registrul uneltelor Build&Fix autorizate sa cheme devize-auto (panou.js)
// pe token de serviciu -- NU pe sesiunea umana (aici nu exista niciuna,
// panou.js e strict intern). Acelasi tipar ca
// licitatie-analiza/src/servicii-token.js si buildandfix-core/src/servicii.js,
// deliberat: un apelant extern (azi doar Core API, pentru "plan-executie")
// trimite "Authorization: Bearer <token>", tokenul e legat de un nume si un
// domeniu (acelasi vocabular ca BFLA/Core API: 'licitatii' | 'devize' |
// 'cautare' | 'orchestrator').
'use strict';

// Format .env: SERVICE_TOKENS=token1:nume1:domeniu1,token2:nume2:domeniu2
function incarca(text) {
  const registru = new Map(); // token -> { nume, domeniu }
  if (!text) return registru;
  for (const intrare of text.split(',')) {
    const parte = intrare.trim();
    if (!parte) continue;
    const [token, nume, domeniu] = parte.split(':').map((s) => s?.trim());
    if (!token || !nume || !domeniu) {
      console.warn(`SERVICE_TOKENS: intrare ignorata (asteptat token:nume:domeniu): "${parte}"`);
      continue;
    }
    registru.set(token, { nume, domeniu });
  }
  return registru;
}

const REGISTRU = incarca(process.env.SERVICE_TOKENS);

function identificaServiciu(antetAuthorization) {
  const m = /^Bearer (.+)$/.exec(antetAuthorization || '');
  if (!m) return null;
  return REGISTRU.get(m[1]) || null;
}

module.exports = { identificaServiciu, REGISTRU };
