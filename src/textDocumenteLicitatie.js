// src/textDocumenteLicitatie.js
// Cache de text (extras nativ SAU OCR-uit) al documentelor unei licitatii --
// expus prin Core API (vezi panou.js, /api/text-documente) ca Ofertetehnice
// sa nu mai refaca propriul OCR (ocr-agent.js, plafonat la 15 pagini/document
// implicit) pe ACELEASI fisiere fizice (caiet de sarcini/piese scrise/fisa de
// date) pe care Devize le proceseaza deja complet (ocrIeftin.js, nescalat,
// validat 339/339 pagini). Verificat direct in codul lor
// (scripts/pregateste_date.py, CATEGORII) -- piesele desenate NU intra aici,
// Ofertetehnice le randeaza singur ca imagini, nu le OCR-uieste ca text.
//
// Primul apelant care cere un document il proceseaza (extract.textDinFisier,
// care decide singur text nativ vs OCR) si il salveaza -- oricine cere dupa
// aceea (Devize insusi la import, sau Ofertetehnice prin API) primeste
// cache-ul, fara sa plateasca sau sa astepte din nou. Cache-ul e legat de
// cod_licitatie, NU de un proiect Devize (proiecte.id) -- functioneaza chiar
// daca niciun proiect n-a fost inca importat la noi.
'use strict';

const db = require('./db');
const extract = require('./extract');

const CLASE_PENTRU_TEXT = ['caiet_sarcini', 'fisa_date'];

/**
 * Textul (din cache, sau proaspat procesat+salvat) al documentelor relevante
 * ale unei licitatii pentru Ofertetehnice.
 * @param {string} codLicitatie
 * @param {string[]} avertismente
 * @returns {Promise<Array<{nume, clasa, text, dinCache}>>}
 */
async function texteDocumenteLicitatie(codLicitatie, avertismente) {
  // Cerut aici (nu la nivel de modul) -- acelasi motiv ca in
  // verificareCantitatiPT.js: evita o dependinta circulara la require.
  const { gasesteDocumenteLicitatie } = require('./cli'); // eslint-disable-line global-require
  const peClasa = await gasesteDocumenteLicitatie(codLicitatie, avertismente);

  const rezultate = [];
  for (const clasa of CLASE_PENTRU_TEXT) {
    for (const d of peClasa[clasa] || []) {
      const dejaInCache = db.textDinCacheOcr(codLicitatie, d.nume);
      if (dejaInCache != null) {
        rezultate.push({
          nume: d.nume, clasa, text: dejaInCache, dinCache: true,
        });
        continue; // eslint-disable-line no-continue
      }
      // eslint-disable-next-line no-await-in-loop
      const text = await extract.textDinFisier({ nume: d.nume, cale: d.cale }, avertismente);
      if (text && text.trim()) {
        db.salveazaTextOcrCache(codLicitatie, d.nume, text);
        rezultate.push({
          nume: d.nume, clasa, text, dinCache: false,
        });
      } else {
        avertismente.push(`${d.nume}: niciun text extras -- nu intra in cache.`);
      }
    }
  }
  return rezultate;
}

module.exports = { texteDocumenteLicitatie, CLASE_PENTRU_TEXT };
