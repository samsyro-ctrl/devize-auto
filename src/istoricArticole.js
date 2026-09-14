// src/istoricArticole.js
// Articole (linii F3, cu PRET TOTAL real) din devize vechi castigatoare
// (Aiud, Deva, Panciu, Vaslui, Zam) -- completeaza istoricDevize.js (acolo:
// RESURSE atomice din C6-C9). Aici: ARTICOLE complete de deviz, fiecare cu
// capitolul lui, ca sa poata servi ca PRECEDENT/REFERINTA de pret pentru o
// linie noua de antemasuratoare -- nu doar validarea unei resurse atomice,
// ci "acest tip de lucrare a costat X intr-un proiect castigat anterior".
//
// Sursa: API-ul /api/devize-castigate de pe Core API (vezi devizeCastigate.js),
// nu /root/scratch direct -- ca sursa sa ramana aceeasi indiferent unde ruleaza
// devize-auto (decizie explicita, sesiunea "Server"+"Open router management",
// 12.09.2026).
//
// Structura F3 (confirmata pe fisier real, ZAM): un rand de numerotare oficiala
// ("0","1","","","","","2","3","4","5 = 3 x 4",...) apare de MAI MULTE ORI in
// aceeasi foaie (o sectiune noua per "STADIUL FIZIC"/pagina) -- procesam
// TOATE, nu doar prima. Randul de articol are Nr (posibil cu punct, ex "1.9"),
// cod (coloana oficiala "1"), denumire (imediat la dreapta codului -- formularul
// nu numeroteaza separat cod/denumire, doar "1" = "Capitolul de lucrari" ca
// bloc unic), UM/cantitate/pret/total pe coloanele oficiale "2"/"3"/"4"/"5".
// Randurile de sub-descompunere (material:/manopera:/utilaj:/transport:) au
// codul (coloana "1") gol -- excluse automat, fara caz special.
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const db = require('./db');
const devizeCastigate = require('./devizeCastigate');
const { gasesteNumerotareaColoanelor, parseNumar } = require('./istoricDevize');
const { curataCodDat } = require('./matching');

const RX_F3 = /-\s*F3\s*-/i;

function parseNumarSauNull(text) {
  const n = parseNumar(text);
  return n;
}

/** Toate randurile de numerotare oficiala dintr-o foaie (F3 poate avea mai
 * multe sectiuni/pagini in ACEEASI foaie, fiecare cu propriul rand "0"). */
function toateNumerotarile(rows) {
  const rezultat = [];
  rows.forEach((r, i) => {
    if (String(r[0] || '').trim() !== '0') return;
    const harta = {};
    r.forEach((celula, idx) => {
      const m = /^(\d+)/.exec(String(celula || '').trim());
      if (m) harta[m[1]] = idx;
    });
    rezultat.push({ harta, indexRand: i });
  });
  return rezultat;
}

const CUVINTE_FOOTER = /^procent$|^cheltuieli\s+directe|^total\b|^recapitulatie/i;

/**
 * Extrage articolele (linii F3, cu pret TOTAL) dintr-un fisier .xlsx.
 * @param {string} cale -- fisier local (deja descarcat).
 * @returns {Array<{cod, denumire, capitol, unitate, cantitate, pretUnitar, total}>}
 */
function extrageArticoleF3(cale) {
  const wb = XLSX.readFile(cale);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
  const numerotari = toateNumerotarile(rows);
  if (!numerotari.length) return [];

  const rezultat = [];
  let capitolCurent = null;

  for (let s = 0; s < numerotari.length; s += 1) {
    const { harta, indexRand } = numerotari[s];
    const idxCod = harta['1'];
    const idxDenumire = idxCod !== undefined ? idxCod + 1 : undefined;
    const idxUM = harta['2'];
    const idxCantitate = harta['3'];
    const idxPret = harta['4'];
    const idxTotal = harta['5'];
    if (idxCod === undefined || idxPret === undefined) continue; // eslint-disable-line no-continue -- numerotare neasteptata, sarim sectiunea

    const capatSectiune = s + 1 < numerotari.length ? numerotari[s + 1].indexRand : rows.length;
    for (let i = indexRand + 1; i < capatSectiune; i += 1) {
      const r = rows[i];
      const primaCelula = String(r[0] || '').trim();
      const codBrut = String(r[idxCod] || '').trim();
      const denumireBruta = String(r[idxDenumire] || '').trim();

      if (CUVINTE_FOOTER.test(primaCelula) || CUVINTE_FOOTER.test(denumireBruta)) break; // recapitulatie/total -- gata cu sectiunea asta

      if (!codBrut) continue; // eslint-disable-line no-continue -- sub-descompunere (material:/manopera:/...) sau rand gol, nimic de folosit

      const pretUnitar = parseNumarSauNull(r[idxPret]);
      if (pretUnitar === null || pretUnitar <= 0) {
        // Are text in pozitia de cod, dar FARA pret real -- e un rand de
        // CAPITOL (titlu de sectiune), nu un articol. Formularul nu are o
        // coloana separata pentru capitol la acest nivel -- titlul ocupa
        // exact pozitia unde ar sta codul unui articol real (confirmat pe
        // fisier real: "1 | Sistem de protectie incendiu | (fara pret)",
        // urmat de articole reale gen "1.1 | EF01B1* | Centrala..."). Un
        // articol real are mereu denumire in coloana urmatoare -- un rand de
        // capitol, nu (o singura celula ocupata, restul goale). Codul BRUT,
        // neschimbat -- un titlu de capitol nu e un cod de nomenclator, nu
        // trebuie curatat (risc real: un titlu terminat in cifra mica, ex.
        // "Etapa 2", ar fi mutilat de curataCodDat, gandita pt coduri).
        if (!denumireBruta) capitolCurent = codBrut;
        continue; // eslint-disable-line no-continue
      }

      // Curatat de adnotarile estimatorului (note de subsol "[1]", "-asim",
      // "#", "%", sufix de an/varianta) -- DOAR aici, unde codul chiar e
      // folosit ca un cod de articol (nu ca titlu de capitol, mai sus).
      // Acelasi tipar real gasit azi in cod_dat (matching.js), confirmat aici
      // cu exemple identice ("EF01B1*" mentionat mai sus, "TSD19B1[1]"/
      // "RPSC24A#" vazute pe CHITILA). Fara curatare, codul brut nu s-ar
      // potrivi NICIODATA exact cu codul curat dintr-o linie de deviz noua
      // (db.articoleIstoricePentruCod face cautare EXACTA) -- 1.572/37.710
      // (~4,2%) din randurile deja importate aveau acest zgomot. Sigur de
      // facut necondiționat aici (spre deosebire de cod_dat, unde curatarea
      // e doar fallback): tabelul asta e strict informativ (referinta de
      // pret, niciodata folosit pt auto-confirmare) -- codul brut ramane
      // oricand recuperabil din fisierul F3 original.
      const cod = curataCodDat(codBrut);

      rezultat.push({
        cod,
        denumire: denumireBruta,
        capitol: capitolCurent,
        unitate: idxUM !== undefined ? (String(r[idxUM] || '').trim() || null) : null,
        cantitate: idxCantitate !== undefined ? parseNumarSauNull(r[idxCantitate]) : null,
        pretUnitar,
        total: idxTotal !== undefined ? parseNumarSauNull(r[idxTotal]) : null,
      });
    }
  }
  return rezultat;
}

/**
 * Importa articolele F3 din toate proiectele disponibile prin Core API
 * (/api/devize-castigate), in istoric_articole_castigate. Sterge-si-
 * reinsereaza (nu se aduna la infinit intre rulari).
 * @returns {Promise<{proiecteProcesate, fisiereProcesate, articoleGasite, avertismente}>}
 */
async function importaArticoleIstorice() {
  const proiecte = await devizeCastigate.listaProiecte();
  const dirTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'istoric-articole-'));
  const stare = {
    proiecteProcesate: 0, fisiereProcesate: 0, articoleGasite: 0, avertismente: [],
  };

  db.stergeArticoleIstorice();

  for (const proiect of proiecte) {
    // eslint-disable-next-line no-await-in-loop
    const listare = await devizeCastigate.listaFisiere(proiect);
    const fisiereF3 = listare.fisiere.filter((f) => RX_F3.test(f.nume));
    stare.proiecteProcesate += 1;

    for (const f of fisiereF3) {
      const caleLocala = path.join(dirTemp, proiect.replace(/[^A-Za-z0-9]/g, '_'), f.nume.replace(/[^A-Za-z0-9.\-]/g, '_'));
      try {
        // eslint-disable-next-line no-await-in-loop
        await devizeCastigate.descarcaFisier(proiect, f.cale, caleLocala);
        const articole = extrageArticoleF3(caleLocala);
        stare.fisiereProcesate += 1;
        stare.articoleGasite += articole.length;
        for (const a of articole) {
          db.adaugaArticolIstoric({
            proiect,
            cod: a.cod,
            denumire: a.denumire,
            capitol: a.capitol,
            unitate: a.unitate,
            cantitate: a.cantitate,
            pretUnitar: a.pretUnitar,
            total: a.total,
            documentSursa: f.cale,
          });
        }
      } catch (e) {
        stare.avertismente.push(`${proiect}/${f.nume}: ${e.message}`);
      } finally {
        try { fs.unlinkSync(caleLocala); } catch { /* deja sters sau nu a fost creat -- nu conteaza */ }
      }
    }
  }

  return stare;
}

/**
 * Cauta cel mai relevant precedent istoric pentru o linie noua -- intai dupa
 * cod (daca linia are deja unul, de la matching.js), altfel prin cautare de
 * text (denumire+capitol) in articolele istorice. NU alege automat -- intoarce
 * candidatii, apelantul decide cati arata/foloseste.
 * @param {{denumire: string, capitol?: string, cod?: string}} linie
 * @param {number} [limita]
 * @returns {Array<object>} randuri din istoric_articole_castigate, cele mai relevante intai
 */
function gasesteReferintaIstorica(linie, limita = 5) {
  if (linie.cod) {
    const dupaCod = db.articoleIstoricePentruCod(linie.cod, limita);
    if (dupaCod.length) return dupaCod;
  }
  const text = [linie.denumire, linie.capitol].filter(Boolean).join(' ');
  return db.cautaArticoleIstoricePrinText(text, limita);
}

module.exports = { extrageArticoleF3, importaArticoleIstorice, gasesteReferintaIstorica };
