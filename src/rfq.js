// src/rfq.js
// Trimite necesarul de resurse al unui proiect (resurse_agregate) spre un
// RFQ real in recrutare-bot, PRIN buildandfix-core (vezi
// buildandfix-core/src/recrutareBot.js -- proxy subtire, tokenul lui
// recrutare-bot nu iese niciodata din Core API).
//
// Spre deosebire de src/bfla.js, aici NU esuam tacut. BFLA e o imbunatatire
// invizibila de fundal (mai bine cu ea, la fel de bine fara) -- un RFQ e o
// actiune explicita, ceruta de om, cu efect real (poate porni o cautare care
// trimite emailuri catre firme). Daca nu merge, omul trebuie sa afle clar,
// nu sa creada ca s-a trimis cand de fapt n-a plecat nimic.
'use strict';

const BAZA = process.env.CORE_API_URL || 'http://127.0.0.1:8092';
const TOKEN = process.env.CORE_API_TOKEN || null;
const TIMEOUT_MS = 10000;

/** Descrie in text liber necesarul de resurse -- /api/cauta din recrutare-bot
 * asteapta o propozitie, nu o lista structurata. */
function descrieNecesar(proiect, resurse) {
  const linii = resurse.map((r) => {
    const cant = Number(r.cantitate_totala).toLocaleString('ro-RO', { maximumFractionDigits: 2 });
    return `${cant} ${r.unitate || ''} ${r.descriere}`.replace(/\s+/g, ' ').trim();
  });
  return `Necesar de resurse pentru proiectul "${proiect.nume}" (deviz Build&Fix): ${linii.join('; ')}.`;
}

/**
 * Porneste un RFQ real pentru un proiect. NU e fail-open -- arunca eroarea
 * mai departe (mesaj clar, in romana), ca ruta care o cheama sa o poata
 * arata omului, nu sa o inghita tacut.
 * @param {{nume:string}} proiect
 * @param {Array<{descriere,unitate,cantitate_totala}>} resurse
 * @returns {Promise<{mesaj:string}>}
 */
async function trimiteRfq(proiect, resurse) {
  if (!TOKEN) throw new Error('CORE_API_TOKEN nu e setat -- integrarea cu Core API (RFQ) nu e configurata pe acest server.');
  if (!resurse || !resurse.length) throw new Error('Proiectul nu are resurse agregate -- genereaza mai intai devizul (Revizuire -> Generează).');

  const descriere = descrieNecesar(proiect, resurse);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const raspuns = await fetch(`${BAZA}/api/rfq`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ descriere }),
    });
    const corp = await raspuns.json().catch(() => ({}));
    if (!raspuns.ok) throw new Error(corp.eroare || corp.mesaj || `Core API a raspuns cu eroare (${raspuns.status}).`);
    return corp;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Core API (RFQ) nu a raspuns la timp -- incearca din nou.');
    if (err instanceof TypeError) throw new Error('Nu am putut ajunge la Core API -- verifica daca buildandfix-core ruleaza.');
    throw err;
  } finally {
    clearTimeout(t);
  }
}

module.exports = { trimiteRfq, descrieNecesar, ACTIV: Boolean(TOKEN) };
