// src/rerankingAI.js
// g1 -- reranking AI de matching, cu retrieval din TOT nomenclatorul via
// Postgres (rerankingPostgres.js, v4, recall@20=88.06%), nu doar din
// candidatii cache-uiti de bm25 la matching.js. Cerut de Cristian direct
// (18.09.2026), validat empiric de sesiunea Server pe date reale
// (SCN1179715): 150 linii testate, 111/150 identic cu bm25 (74%), 5
// "incredere ridicata" diferite -- citite manual, 3 corectii reale ale unor
// erori bm25, 2 limitari de retrieval, ZERO "AI gresit fara justificare".
//
// STRICT sugestie -- la fel ca src/sugestieMatching.js, NU schimba
// stare/colectie/cod niciodata, un om confirma sau respinge. Diferenta fata
// de sugestieMatching.js: acolo alege doar dintre candidatii deja gasiti de
// bm25 (index in candidati_json); aici cauta in tot nomenclatorul, poate
// gasi un candidat pe care bm25 nu l-a vazut niciodata -- de-aia scrie
// colectie+cod direct (sugestie_rerank_*), nu un index.
//
// Ruleaza pe liniile 'auto' SI 'de_revizuit' (nu doar 'de_revizuit' ca la
// sugestieMatching.js) -- miza reala aici e sa prinda si erori pe liniile
// 'auto', nevazute de niciun om azi (asta a gasit si testul de 150 linii:
// #791/#793/#794, corectii reale pe linii "auto").
//
// Model implicit: openai/gpt-5-mini (decizie 18.09.2026, testata pe 150
// linii reale, vezi migration-test/prototip-reranking-ai.js din
// buildandfix-core pt istoricul complet) -- schimbabil prin
// MODEL_RERANKING_AI (.env sau pagina Setari, ca toate celelalte roluri).
// Apel SYNC (prin src/ai.js, ca restul aplicatiei), NU OpenRouter Batch API
// -- Batch ar reduce costul ~2x, dar ar cere un flux nou (submit+poll,
// niciun alt rol AI din aplicatie nu-l foloseste azi); ramane o optimizare
// ulterioara, separata, nu blocheaza acest v1.
'use strict';

const db = require('./db');
const { cheama } = require('./ai');
const { conexiune, incarcaAreDescompunere, gasesteCandidati, detaliiPtCandidati } = require('./rerankingPostgres');

const N_CANDIDATI = parseInt(process.env.N_CANDIDATI_RERANKING || '20', 10);

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['alegere', 'incredere', 'motiv'],
  properties: {
    alegere: { type: ['integer', 'null'], description: 'Numarul candidatului (1-based) ales, sau null daca niciunul nu se potriveste.' },
    incredere: { type: 'string', enum: ['ridicata', 'scazuta'] },
    motiv: { type: 'string', description: '1 propozitie scurta -- mentioneaza daca alegerea s-a bazat pe cod_dat sau pe un detaliu tehnic exact.' },
  },
};

// Prompt identic (reguli de prioritate incluse) cu migration-test/prototip-
// reranking-ai.js dupa fix-ul din 18.09.2026 -- cod_dat + reguli explicite,
// gasite necesare direct pe #773/#757 (vezi comentariul din acel fisier).
function construiestePrompt(denumire, unitate, codDat, candidati) {
  const lista = candidati.map((c, i) => `${i + 1}. [${c.cod}] ${c.descriere} (UM: ${c.unitate || '?'})`).join('\n');
  const liniaCodDat = codDat ? `\nCod dat de ofertantul original (daca exista un candidat cu acest cod EXACT sau foarte apropiat, e semnal puternic): "${codDat}"` : '';
  return `Esti un expert in devize de constructii din Romania. Ai o linie de antemasuratoare si o lista de articole candidate din nomenclator. Alege articolul care descrie EXACT aceeasi lucrare (materiale, dimensiuni, clasa etc.) ca linia cautata, sau spune ca niciunul nu se potriveste real.

Linie cautata: "${denumire}" (UM: ${unitate || 'necunoscuta'})${liniaCodDat}

Candidati:
${lista}

Reguli de prioritate cand mai multi candidati par potriviti:
1. Daca un candidat are codul IDENTIC (sau aproape identic) cu codul dat de ofertant de mai sus, prefera-l -- e semnalul cel mai puternic posibil, chiar daca alt candidat pare "suficient de bun" semantic.
2. Daca linia cautata mentioneaza un detaliu tehnic exact (clasa, dozaj, diametru, dimensiune), prefera candidatul a carui descriere mentioneaza EXPLICIT acelasi detaliu, fata de unul care doar pare similar dar nu-l mentioneaza.

Raspunde DOAR cu JSON, fara alt text.`;
}

async function sugereazaPentruLinie(pg, areDescompunere, linie) {
  const candidatiScurti = await gasesteCandidati(pg, linie.denumire, areDescompunere, { limit: N_CANDIDATI });
  if (!candidatiScurti.length) return { rezultat: 'fara_candidati' };

  const candidatiCompleti = await detaliiPtCandidati(pg, candidatiScurti);
  if (!candidatiCompleti.length) return { rezultat: 'fara_candidati' };

  const prompt = construiestePrompt(linie.denumire, linie.unitate, linie.cod_dat, candidatiCompleti);
  const resp = await cheama({
    model: process.env.MODEL_RERANKING_AI || 'openai/gpt-5-mini',
    rol: 'MODEL_RERANKING_AI',
    max_tokens: 500,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
  }, 'reranking-ai');

  if (resp.stop_reason === 'max_tokens') throw new Error('Raspuns trunchiat (neasteptat la max_tokens=500).');
  const block = resp.content.find((b) => b.type === 'text');
  if (!block || !block.text) throw new Error('Raspuns gol de la model.');
  const parsat = JSON.parse(block.text);

  if (parsat.alegere == null) return { rezultat: 'niciunul', incredere: parsat.incredere, motiv: parsat.motiv };

  const ales = candidatiCompleti[parsat.alegere - 1];
  if (!ales) return { rezultat: 'index_invalid' };
  return { rezultat: 'ales', colectie: ales.colectie, cod: ales.cod, incredere: parsat.incredere, motiv: parsat.motiv };
}

/**
 * Genereaza sugestii de reranking AI pentru liniile 'auto' si 'de_revizuit'
 * ale unui proiect (nu 'confirmat' -- alea au deja sigiliul unui om).
 * Cost real -- un apel AI per linie procesata. NU schimba stare/colectie/cod.
 * @param {number} proiectId
 * @param {{limit?: number}} [optiuni] limit = proceseaza doar primele N linii
 *   (util pt un test mic, cost redus, inainte de o rulare pe tot proiectul).
 * @returns {Promise<{procesate, sugerate, faraSchimbare, faraCandidati, avertismente}>}
 */
async function genereazaSugestiiRerank(proiectId, { limit } = {}) {
  if (!process.env.OPENROUTER_API_KEY) throw new Error('Lipseste OPENROUTER_API_KEY.');

  let linii = db.liniiCuRezolutiiPeProiect(proiectId)
    .filter((l) => l.stare === 'auto' || l.stare === 'de_revizuit');
  if (limit) linii = linii.slice(0, limit);

  const pg = conexiune();
  const areDescompunere = await incarcaAreDescompunere(pg);

  const stare = {
    procesate: 0, sugerate: 0, faraSchimbare: 0, faraCandidati: 0, avertismente: [],
  };

  for (const linie of linii) {
    let rezultat;
    try {
      // eslint-disable-next-line no-await-in-loop
      rezultat = await sugereazaPentruLinie(pg, areDescompunere, linie);
    } catch (e) {
      stare.avertismente.push(`Linia ${linie.id}: ${e.message}`);
      continue; // eslint-disable-line no-continue
    }

    stare.procesate += 1;
    if (rezultat.rezultat === 'fara_candidati' || rezultat.rezultat === 'index_invalid') {
      stare.faraCandidati += 1;
      continue; // eslint-disable-line no-continue
    }
    if (rezultat.rezultat === 'niciunul') {
      stare.faraSchimbare += 1;
      db.salveazaSugestieRerank(linie.id, null, null, rezultat.incredere, rezultat.motiv);
      continue; // eslint-disable-line no-continue
    }
    db.salveazaSugestieRerank(linie.id, rezultat.colectie, rezultat.cod, rezultat.incredere, rezultat.motiv);
    stare.sugerate += 1;
  }

  return stare;
}

module.exports = { genereazaSugestiiRerank };
