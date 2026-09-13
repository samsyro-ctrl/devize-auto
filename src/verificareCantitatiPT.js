// src/verificareCantitatiPT.js
// Orchestreaza Robot A (cantitatiPT.js) + Robot B (cantitatiDesenatePT.js) +
// Robot C (reconciliereCantitatiPT.js) + Robot D (comparaCantitatiDeviz.js),
// pe documentele Proiectului Tehnic ale unei licitatii deja legate de un
// proiect (proiecte.cod_licitatie) -- prima integrare reala a celor 3
// roboti calibrati pe 11.09.2026, ramasi izolati pana acum (vezi memoria
// [[devize-verificare-cantitati-insuficiente-task-viitor]]).
//
// Piesele SCRISE ale PT (memoriu tehnic, breviar de calcul) NU au o clasa
// separata azi -- cad sub 'caiet_sarcini' (regexul din dosarLicitatie.js
// include explicit "memoriu tehnic"). Piesele DESENATE cad sub 'desene'.
// Nicio schimbare de taxonomie necesara.
//
// Functiile de aici sunt DELIBERAT pure/fara interactiune (fara readline) --
// confirmarea de cost inainte de Robotul B ramane treaba apelantului (cli.js,
// comandaVerificaCantitatiPT), ca modulul sa ramana testabil izolat.
'use strict';

const db = require('./db');
const extract = require('./extract');
const cantitatiPT = require('./cantitatiPT');
const cantitatiDesenatePT = require('./cantitatiDesenatePT');
const reconciliereCantitatiPT = require('./reconciliereCantitatiPT');
const comparaCantitatiDeviz = require('./comparaCantitatiDeviz');

/**
 * Documentele proiectului, grupate pe ce ii trebuie Robotului A (text) si
 * Robotului B (desene) -- refoloseste gasesteDocumenteLicitatie din cli.js
 * (rutare local/server + fix-ul CLASE_RELEVANTE), fara sa o duplice.
 * @param {string} codLicitatie
 * @param {string[]} avertismente
 * @returns {Promise<{documenteText: Array, documenteDesenate: Array}>}
 */
async function gasesteDocumentePT(codLicitatie, avertismente) {
  // Cerut aici (nu la nivel de modul) -- cli.js nu trebuie incarcat decat
  // cand chiar se apeleaza asta, ca sa nu creeze o dependinta circulara la
  // require (cli.js insusi va cere acest fisier pentru comanda noua).
  const { gasesteDocumenteLicitatie } = require('./cli'); // eslint-disable-line global-require
  const peClasa = await gasesteDocumenteLicitatie(codLicitatie, avertismente);
  const documenteText = peClasa.caiet_sarcini || [];
  const documenteDesenate = (peClasa.desene || []).filter((d) => /\.pdf$/i.test(d.nume));
  return { documenteText, documenteDesenate };
}

/** Concateneaza textul documentelor (piese scrise PT) -- tipar identic cu
 * asambleazaTextScop din cli.js (scopProiect.js). */
async function asambleazaTextPT(documenteText, avertismente) {
  const bucati = [];
  for (const d of documenteText) {
    // eslint-disable-next-line no-await-in-loop
    const text = await extract.textDinFisier({ nume: d.nume, cale: d.cale }, avertismente);
    if (text && text.trim()) bucati.push(`--- ${d.nume} ---\n${text}`);
  }
  return bucati.join('\n\n');
}

/** Robot A -- text gol = lista goala, nu eroare (documentat deja in cantitatiPT.js). */
async function ruleazaRobotA(documenteText, avertismente) {
  const text = await asambleazaTextPT(documenteText, avertismente);
  if (!text.trim()) {
    avertismente.push('Nicio piesa scrisa PT cititabila (clasa "caiet_sarcini") -- Robotul A nu are ce procesa.');
    return [];
  }
  return cantitatiPT.extrageCantitatiPT(text, avertismente);
}

/**
 * Estimeaza costul rularii Robotului B pe TOATE paginile documentelor
 * desenate -- ruleaza o SINGURA pagina reala (prima gasita) si extrapoleaza
 * din costul ei REAL (usage.cost, OpenRouter, vezi ai.js), niciodata dintr-o
 * cifra inventata -- fiecare document poate avea densitate de continut
 * diferita, dar un esantion real e mai de incredere decat o presupunere.
 * @param {Array<{nume, cale}>} documenteDesenate
 * @param {string[]} avertismente
 * @returns {Promise<{esantion: {document, pagina, costUsd, cantitati: Array}|null, paginiTotale: number, costEstimatTotal: number|null}>}
 */
async function estimeazaCostRobotB(documenteDesenate, avertismente) {
  let paginiTotale = 0;
  let esantion = null;
  for (const d of documenteDesenate) {
    // eslint-disable-next-line no-await-in-loop
    const doc = await cantitatiDesenatePT.deschidePdf(d.cale);
    paginiTotale += doc.numPages;
    if (!esantion && doc.numPages > 0) {
      // eslint-disable-next-line no-await-in-loop
      const png = await cantitatiDesenatePT.randeazaPaginaPng(doc, 1);
      // eslint-disable-next-line no-await-in-loop
      const { cantitati, usage } = await cantitatiDesenatePT.extrageCantitatiDinImagineCuCost(png, `${d.nume}, pagina 1`, avertismente);
      // Pastram si cantitatile gasite pe pagina-esantion -- apelantul le
      // combina cu restul, ca sa nu piarda/plateasca de doua ori acea pagina.
      esantion = {
        document: d.nume, pagina: 1, costUsd: usage?.cost ?? null, cantitati: cantitati.map((c) => ({ ...c, document: d.nume, pagina: 1 })),
      };
    }
  }
  if (!paginiTotale) return { esantion: null, paginiTotale: 0, costEstimatTotal: null };
  const costEstimatTotal = esantion?.costUsd != null ? Math.round(esantion.costUsd * paginiTotale * 10000) / 10000 : null;
  if (esantion && esantion.costUsd == null) {
    avertismente.push('OpenRouter n-a intors costul real al esantionului (usage.cost lipseste) -- estimarea de cost nu e disponibila, doar numarul de pagini.');
  }
  return { esantion, paginiTotale, costEstimatTotal };
}

/**
 * Ruleaza Robotul B pe toate documentele desenate. `sarePagina1Din` (numele
 * documentului esantionat de estimeazaCostRobotB, daca a fost rulat) e
 * SARITA la acest pas, ca sa nu se plateasca de doua ori aceeasi pagina --
 * rezultatul ei (cantitatiEsantion) trebuie combinat manual de apelant daca
 * vrea sa nu piarda acele cantitati.
 * @param {Array<{nume, cale}>} documenteDesenate
 * @param {string[]} avertismente
 * @param {{sarePagina1Din?: string}} [optiuni]
 */
async function ruleazaRobotB(documenteDesenate, avertismente, optiuni = {}) {
  const toate = [];
  for (const d of documenteDesenate) {
    const start = d.nume === optiuni.sarePagina1Din ? 2 : 1;
    // eslint-disable-next-line no-await-in-loop
    const { cantitati } = await cantitatiDesenatePT.extrageCantitatiDesenatePT(d.cale, avertismente, { paginaStart: start });
    toate.push(...cantitati.map((c) => ({ ...c, document: d.nume })));
  }
  return toate;
}

/**
 * Robot C (reconciliere) + derivarea unitateTinta fara ambiguitate + Robot D
 * (comparare cu devizul curent) -- salveaza raportul (sterge-si-reinsereaza).
 * Activitatile cu unitati incompatibile intre text/desen (stare "discrepanta"
 * cu unitateText != unitateDesen) NU intra in Robotul D -- raman semnalate
 * separat, ca "de verificat manual" -- nicio alegere tacuta intre unitati
 * diferite (acelasi principiu ca reconciliereCantitatiPT.js insusi).
 * @param {number} proiectId
 * @param {Array} cantitatiText Robot A
 * @param {Array} cantitatiDesen Robot B
 * @param {string[]} avertismente
 * @returns {Promise<{reconciliate: Array, comparatii: Array, deVerificatManual: Array}>}
 */
async function reconciliazaSiCompara(proiectId, cantitatiText, cantitatiDesen, avertismente) {
  const reconciliate = await reconciliereCantitatiPT.reconciliazaCantitatiPT(cantitatiText, cantitatiDesen, avertismente);

  const activitatiTinta = [];
  const deVerificatManual = [];
  for (const r of reconciliate) {
    const unitate = r.inText && r.inDesen ? r.unitateText : (r.inText ? r.unitateText : r.unitateDesen);
    if (r.inText && r.inDesen && r.unitateText !== r.unitateDesen) {
      deVerificatManual.push({ ...r, motivManual: `Unitati incompatibile intre text (${r.unitateText}) si desen (${r.unitateDesen}) -- nicio comparatie automata de cantitate.` });
      continue; // eslint-disable-line no-continue
    }
    if (!unitate) continue; // eslint-disable-line no-continue
    activitatiTinta.push({ activitate: r.activitate, cantitateTinta: r.cantitateTinta, unitateTinta: unitate });
  }

  const linii = db.liniiPeProiect(proiectId);
  const comparatii = activitatiTinta.length ? await comparaCantitatiDeviz.comparaCantitatiCuDeviz(activitatiTinta, linii, avertismente) : [];
  db.salveazaVerificariCantitatiPT(proiectId, comparatii);

  return { reconciliate, comparatii, deVerificatManual };
}

module.exports = {
  gasesteDocumentePT, ruleazaRobotA, estimeazaCostRobotB, ruleazaRobotB, reconciliazaSiCompara,
};
