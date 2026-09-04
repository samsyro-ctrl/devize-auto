// src/ai.js
// Un singur loc prin care trec toate cererile catre Claude.
// Versiune simplificata a recrutare-bot/src/ai.js -- aici nu exista alertare
// pe email (instrument local, single-user), doar mesaj clar in consola.
'use strict';

/** Felul erorii, ca sa stim ce sa afisam. */
function felEroare(e) {
  const t = String((e && e.message) || e || '');
  if (/credit balance is too low|billing|payment|insufficient.*(funds|credit)/i.test(t)) return 'credit';
  if (/authentication_error|invalid x-api-key|API key/i.test(t)) return 'cheie';
  if (/rate_limit|429|overloaded_error|529/i.test(t)) return 'aglomerat';
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|socket hang up/i.test(t)) return 'retea';
  return 'altceva';
}

const MESAJE = {
  credit: 'S-au terminat creditele Anthropic sau e o problema de facturare. Verifica console.anthropic.com.',
  cheie: 'Problema cu ANTHROPIC_API_KEY -- verifica .env.',
  aglomerat: 'Serviciul de AI e aglomerat chiar acum. Mai incearca peste un minut.',
  retea: 'Nu am putut ajunge la serviciul de AI. Mai incearca peste un minut.',
  altceva: 'Ceva n-a mers la apelul catre Claude. Mai incearca o data.',
};

const mesajOmenesc = (e) => MESAJE[felEroare(e)] || MESAJE.altceva;

/**
 * Cheama Claude. Imparte erorile pe feluri, ca sa stii repede daca problema
 * e a ta (documentul/cererea) sau a serviciului (credit/cheie/retea).
 * @param {object} client   clientul Anthropic
 * @param {object} cerere   ce se trimite la messages.create
 * @param {string} unde     de unde vine apelul, pentru jurnal
 */
async function cheama(client, cerere, unde = 'necunoscut') {
  try {
    return await client.messages.create(cerere);
  } catch (e) {
    console.error(`⚠️  Apel Claude esuat (${unde}): ${mesajOmenesc(e)}`);
    e.felAI = felEroare(e);
    e.mesajOmenesc = mesajOmenesc(e);
    throw e;
  }
}

module.exports = { cheama, felEroare, mesajOmenesc };
