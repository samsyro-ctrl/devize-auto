// src/ocrIeftin.js
// Transcrie un PDF scanat, PAGINA CU PAGINA, cu OCR ieftin (plugin
// file-parser/mistral-ocr de pe OpenRouter) -- inlocuieste modelul cu vedere
// (transcriereVizuala.js) ca prima trecere, pastrand vederea DOAR pentru
// paginile unde OCR-ul chiar nu se descurca (stampile, scris de mana,
// calitate proasta). Motivul schimbarii (12.09.2026): plafonul vechi de 60
// de pagini (vezi extract.js, PRAG_PAGINI_TRANSCRIERE) trunchia silentios
// documente reale mult mai mari -- un caz real, SCN1179715, are 339 de
// pagini scanate intr-un singur document ("lista de cantitati"); cu modelul
// de vedere pe toate, ar fi fost prea lent/scump la scara (sute-mii de
// pagini asteptate in productie, posibil din mai multe licitatii deodata).
//
// De ce PER PAGINA, nu tot documentul intr-o cerere: un document de mii de
// pagini ar lovi doua plafoane TEHNICE (nu doar cost) -- marimea cererii
// (PDF brut base64 pentru mii de pagini) si marimea raspunsului (text
// trunchiat la limita de tokeni de iesire). Per pagina, fiecare cerere ramane
// mica, deci scaleaza tehnic la orice numar de pagini.
//
// Validat REAL (12.09.2026) pe documentul SCN1179715 intreg (339 pagini):
// 339/339 reusite, 0 esuate, 186.8s la concurenta 8, cost total $0.68 (~$0.002
// /pagina, exact taxa fixa a pluginului -- modelul-purtator ales cel mai
// ieftin posibil, costul lui e neglijabil, raspunsul lui insusi e ignorat).
// Text OCR per pagina: minim 442, mediana 2894 caractere -- nicio pagina sub
// pragul de escaladare pe acest document (nicio stampila/scris de mana), dar
// mecanismul de escaladare ramane necesar pentru documente care AU asa ceva
// (cazul care a motivat initial modelul de vedere, SCN1179096).
'use strict';

const fs = require('fs');
const { PDFDocument } = require('pdf-lib');
const { cheama } = require('./ai');
const { deschidePdf, randeazaPaginaPng } = require('./cantitatiDesenatePT');
const { transcrieDinImagine } = require('./transcriereVizuala');

// OCR-ul e mult mai ieftin si mai rapid decat modelul de vedere (~3s/pagina
// vs ~20-40s/pagina) -- suporta mai multa concurenta fara sa loveasca la fel
// de repede rate-limit-ul OpenRouter.
const CONCURENTA_IMPLICITA = 8;

const PRAG_INCERCARI = 3;
const INTARZIERE_BAZA_MS = 1200;
const FELURI_REINCERCABILE = new Set(['retea', 'aglomerat', 'timeout']);

// Doar purtator -- costul real vine din taxa fixa a pluginului file-parser
// (mistral-ocr), NU din modelul insusi (confirmat: $0.002/pagina, din care
// <0.001% e modelul-purtator) -- alegem cel mai ieftin model disponibil,
// raspunsul lui e ignorat, folosim doar "annotations" (textul OCR brut).
const MODEL_PURTATOR = process.env.MODEL_OCR_PURTATOR || 'deepseek/deepseek-v4-flash-0731';

// Sub cate caractere de text OCR o pagina trece la modelul de vedere --
// proportional cu PRAG_TEXT_INSUFICIENT (500) de la nivel de document intreg
// din extract.js, dar aplicat AICI per pagina individuala.
const PRAG_TEXT_INSUFICIENT_PAGINA = 500;

// Plafonul vechi (PRAG_PAGINI_TRANSCRIERE=60 din extract.js) nu dispare, se
// MUTA -- nu mai limiteaza OCR-ul (ieftin, scaleaza la orice numar de
// pagini), ci doar cate pagini pot fi escaladate la modelul de vedere
// (scump) intr-un singur document. Aparare impotriva unui document
// patologic (ex. scanare foarte proasta pe zeci-sute de pagini) care ar
// recrea altfel exact problema de cost/timp rezolvata aici.
const PRAG_PAGINI_VEDERE = 60;

/** Asteapta `ms` milisecunde. */
function asteapta(ms) {
  return new Promise((rezolva) => { setTimeout(rezolva, ms); });
}

/** Acelasi tipar de rulare cu concurenta limitata ca in transcriereVizuala.js
 * (pastreaza ordinea rezultatelor, indiferent de ordinea de finalizare). */
async function ruleazaCuConcurenta(taskuri, concurenta) {
  const rezultate = new Array(taskuri.length);
  let urmatorulIndex = 0;
  async function worker() {
    while (urmatorulIndex < taskuri.length) {
      const i = urmatorulIndex;
      urmatorulIndex += 1;
      rezultate[i] = await taskuri[i]();
    }
  }
  const numarWorkeri = Math.max(1, Math.min(concurenta, taskuri.length));
  await Promise.all(Array.from({ length: numarWorkeri }, worker));
  return rezultate;
}

/** O pagina dintr-un PDF deja incarcat (pdf-lib), ca PDF de-o-singura-pagina
 * (Buffer) -- trimisa separat pluginului OCR, ca fiecare cerere sa ramana
 * mica indiferent de marimea documentului sursa. */
async function extragePaginaCaPdf(docSursa, nrPagina) {
  const docNou = await PDFDocument.create();
  const [pagina] = await docNou.copyPages(docSursa, [nrPagina - 1]);
  docNou.addPage(pagina);
  return Buffer.from(await docNou.save());
}

/**
 * OCR pe o singura pagina (deja extrasa ca PDF de-o-pagina). Reincercare
 * doar pe erori tranzitorii (retea/aglomerat/timeout), la fel ca
 * transcriereVizuala.js -- o eroare de continut nu s-ar repara reincercand.
 * @returns {Promise<string>} textul OCR brut (gol daca a esuat definitiv)
 */
async function ocrPagina(bufferPaginaPdf, eticheta, avertismente) {
  const base64 = bufferPaginaPdf.toString('base64');
  for (let incercare = 1; incercare <= PRAG_INCERCARI; incercare += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const resp = await cheama({
        model: MODEL_PURTATOR,
        max_tokens: 10,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'ok' },
            { type: 'file', filename: 'pagina.pdf', source: { data: base64 } },
          ],
        }],
        plugins: [{ id: 'file-parser', pdf: { engine: 'mistral-ocr' } }],
      }, 'ocrIeftin');
      const bloc = (resp.annotations || [])[0]?.file?.content;
      if (!bloc) return '';
      // Pluginul file-parser impacheteaza continutul intr-un tag
      // "<file name=...>...</file>" -- nu e continut real al paginii,
      // scos aici, o singura data, ca sa nu ajunga zgomot in textul folosit
      // mai departe de antemasuratoare.js etc. (confirmat real, 12.09.2026).
      return bloc.map((c) => c.text).join('').replace(/<\/?file(?:\s+name="[^"]*")?>/gi, '').trim();
    } catch (e) {
      const reincercabil = FELURI_REINCERCABILE.has(e.felAI) && incercare < PRAG_INCERCARI;
      if (!reincercabil) {
        avertismente.push(`${eticheta}: OCR esuat (${e.mesajOmenesc || e.message}).`);
        return '';
      }
      const intarziere = INTARZIERE_BAZA_MS * 2 ** (incercare - 1);
      // eslint-disable-next-line no-await-in-loop
      await asteapta(intarziere);
    }
  }
  return '';
}

/**
 * Transcrie tot textul unui PDF scanat -- OCR ieftin pe fiecare pagina, apoi
 * escaladare la modelul de vedere DOAR pentru paginile cu text OCR sub
 * PRAG_TEXT_INSUFICIENT_PAGINA (stampile, scris de mana, calitate proasta).
 * Aceeasi forma de rezultat ca transcriereVizuala.transcrieDocument, ca
 * apelantul (extract.js) sa nu observe diferenta.
 * @param {string} calePdf
 * @param {string[]} [avertismente]
 * @param {{paginaStart?: number, paginaEnd?: number, scale?: number, concurenta?: number}} [optiuni]
 * @returns {Promise<{text: string, numPagini: number}>}
 */
async function transcrieDocumentHibrid(calePdf, avertismente = [], optiuni = {}) {
  if (!process.env.OPENROUTER_API_KEY) throw new Error('Lipseste OPENROUTER_API_KEY.');

  const bytesSursa = fs.readFileSync(calePdf);
  const docSursa = await PDFDocument.load(bytesSursa);
  const numPagini = docSursa.getPageCount();
  const start = optiuni.paginaStart || 1;
  const capat = Math.min(optiuni.paginaEnd || numPagini, numPagini);

  // Deschis o singura data (pdfjs, pentru randare PNG) -- folosit DOAR daca
  // vreo pagina chiar are nevoie de escaladare la vedere; documente fara
  // nicio pagina problematica (cazul comun) nu-l ating deloc dupa deschidere.
  const docPentruRandare = await deschidePdf(calePdf);

  const numerePagini = [];
  for (let p = start; p <= capat; p += 1) numerePagini.push(p);

  let escaladatePagini = 0;

  const taskuri = numerePagini.map((p) => async () => {
    const eticheta = `pagina ${p}`;
    let bufferPagina;
    try {
      bufferPagina = await extragePaginaCaPdf(docSursa, p);
    } catch (e) {
      avertismente.push(`${eticheta}: extragere pentru OCR esuata (${e.message}).`);
      return null;
    }

    const textOcr = await ocrPagina(bufferPagina, eticheta, avertismente);
    if (textOcr.trim().length >= PRAG_TEXT_INSUFICIENT_PAGINA) {
      return textOcr.trim() ? `--- pagina ${p} ---\n${textOcr}` : null;
    }

    if (escaladatePagini >= PRAG_PAGINI_VEDERE) {
      // Plafon de escaladare atins -- ramane pe textul OCR (posibil slab),
      // semnalat explicit mai jos, in loc sa recream costul/timpul mare pe
      // care tocmai il rezolvam.
      return textOcr.trim() ? `--- pagina ${p} ---\n${textOcr}` : null;
    }

    // OCR insuficient -- escaladare la modelul de vedere (transcriereVizuala.js,
    // NESCHIMBAT), doar pe aceasta pagina.
    let png;
    try {
      png = await randeazaPaginaPng(docPentruRandare, p, optiuni.scale);
    } catch (e) {
      avertismente.push(`${eticheta}: randare pentru vedere esuata (${e.message}) -- pastrat textul OCR (${textOcr.trim().length} caractere).`);
      return textOcr.trim() ? `--- pagina ${p} ---\n${textOcr}` : null;
    }
    const textVedere = await transcrieDinImagine(png, eticheta, avertismente);
    if (textVedere.trim().length > textOcr.trim().length) {
      escaladatePagini += 1;
      return textVedere.trim() ? `--- pagina ${p} ---\n${textVedere}` : null;
    }
    return textOcr.trim() ? `--- pagina ${p} ---\n${textOcr}` : null;
  });

  const rezultatePeOrdine = await ruleazaCuConcurenta(taskuri, optiuni.concurenta || CONCURENTA_IMPLICITA);
  if (escaladatePagini) {
    avertismente.push(`${escaladatePagini} din ${numerePagini.length} pagini escaladate la modelul cu vedere (text OCR insuficient -- probabil stampile/scris de mana).`);
  }
  if (escaladatePagini >= PRAG_PAGINI_VEDERE) {
    avertismente.push(`Plafonul de escaladare la vedere (${PRAG_PAGINI_VEDERE} pagini) a fost atins -- posibil ca alte pagini cu OCR slab sa fi ramas netranscrise corect, verifica manual daca rezultatul pare incomplet.`);
  }

  const bucati = rezultatePeOrdine.filter(Boolean);
  return { text: bucati.join('\n\n'), numPagini };
}

module.exports = { transcrieDocumentHibrid, ocrPagina, extragePaginaCaPdf };
