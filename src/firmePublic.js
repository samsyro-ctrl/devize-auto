// src/firmePublic.js
// Conturile firmelor externe care intra pe devize.buildandfix.ai. Portat din
// licitatie-analiza/src/utilizatori.js -- acelasi tipar de criptografie deja
// testat (scrypt+sare, comparatie timing-safe, parola temporara la creare,
// throttling la autentificari esuate), dar persistenta trece prin sqlite
// (src/db.js -- tabelele firme/sesiuni_publice), nu prin fisiere JSON, ca sa
// ramana consecvent cu restul acestui instrument.
//
// Fara inregistrare libera: singura cale de a crea o firma e
// scripts/creeaza-firma.js (CLI, ruleaza tu, nu firma). Vezi planul --
// decizie deliberata pentru prima versiune (zero risc de spam/conturi false).
'use strict';

const crypto = require('crypto');
const db = require('./db');

const DURATA_SESIUNE_MS = 12 * 60 * 60 * 1000; // 12 ore, acelasi interval ca la licitatie-analiza
const N = 16384; // cost scrypt

// ─── Parole ──────────────────────────────────────────────────────────────────

function amprenta(parola, sare) {
  return crypto.scryptSync(String(parola), sare, 64, { N }).toString('hex');
}

function faceAmprenta(parola) {
  const sare = crypto.randomBytes(16).toString('hex');
  return { sare, hash: amprenta(parola, sare) };
}

/** Comparatie in timp constant -- fara ea, timpul de raspuns ar putea trada
 * cat de "aproape" e o parola gresita de cea corecta. */
function potrivesc(a, b) {
  const ba = Buffer.from(String(a), 'hex');
  const bb = Buffer.from(String(b), 'hex');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Parola temporara, usor de citit/dictat la telefon: 3 grupuri de 4. */
function parolaTemporara() {
  const alfabet = 'abcdefghjkmnpqrstuvwxyz23456789'; // fara l/1/o/0, se confunda
  const grup = () => Array.from({ length: 4 }, () =>
    alfabet[crypto.randomInt(alfabet.length)]).join('');
  return `${grup()}-${grup()}-${grup()}`;
}

// ─── Conturi ─────────────────────────────────────────────────────────────────

/** Fara diacritice, spatii normalizate, lowercase -- ca "Cristian" si
 * "cristian" (sau "Crистian" cu diacritice romanesti) sa insemne acelasi
 * lucru la login. Acelasi tipar ca licitatie-analiza/utilizatori.js. */
function curata(s) {
  return String(s || '').trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');
}

/**
 * Creeaza un cont de firma si intoarce parola temporara -- SINGURA data cand
 * e vizibila. O trimiti firmei pe alt canal (WhatsApp/email); la prima
 * autentificare, pagina publica o obliga sa-si aleaga alta.
 * @param {{nume, utilizator, email}} date -- "utilizator" e ce se scrie la
 *   login (ex. "cristian"), "nume" ramane numele complet/firma afisat in
 *   antet, "email" doar contact -- nu se mai foloseste la autentificare.
 */
function creeaza({ nume, utilizator, email }) {
  const emailCurat = String(email || '').trim().toLowerCase();
  if (!emailCurat || !emailCurat.includes('@')) throw new Error('Email invalid');
  if (db.firmaDupaEmail(emailCurat)) throw new Error(`Exista deja un cont pentru "${emailCurat}"`);

  const utilizatorCurat = curata(utilizator) || null;
  if (utilizatorCurat && db.toateFirmeleComplet().some((f) => curata(f.utilizator) === utilizatorCurat)) {
    throw new Error(`Exista deja un cont cu utilizatorul "${utilizator}"`);
  }

  const parola = parolaTemporara();
  const { sare, hash } = faceAmprenta(parola);
  const id = db.creeazaFirma({ nume: String(nume || '').trim() || emailCurat, utilizator: utilizatorCurat, email: emailCurat, sare, hash });
  return { id, utilizator: utilizatorCurat, email: emailCurat, parolaTemporara: parola };
}

function schimbaParola(firmaId, parolaVeche, parolaNoua) {
  if (String(parolaNoua || '').length < 8) throw new Error('Parola noua trebuie sa aiba minim 8 caractere');
  const f = db.firmaDupaId(firmaId);
  if (!f) throw new Error('Cont inexistent');
  if (!potrivesc(amprenta(parolaVeche, f.sare), f.hash_parola)) throw new Error('Parola actuala e gresita');
  const { sare, hash } = faceAmprenta(parolaNoua);
  db.actualizeazaParolaFirma(firmaId, sare, hash, false);
}

// ─── Protectie brute-force la login ────────────────────────────────────────
// Acelasi tipar ca la licitatie-analiza: nu blocam CONTUL (ar fi, la randul
// ei, o usa de DoS pentru oricine stie doar un email), doar incetinim in
// memorie, per email incercat.
const incercariEsuate = new Map();
const FEREASTRA_BLOCARE_MS = 15 * 60 * 1000;
const PRAG_BLOCARE = 5;

function esteBlocat(cheie) {
  const acum = Date.now();
  const recente = (incercariEsuate.get(cheie) || []).filter((t) => acum - t < FEREASTRA_BLOCARE_MS);
  incercariEsuate.set(cheie, recente);
  return recente.length >= PRAG_BLOCARE;
}
function inregistreazaEsec(cheie) {
  const lista = incercariEsuate.get(cheie) || [];
  lista.push(Date.now());
  incercariEsuate.set(cheie, lista);
}

/**
 * @param {string} utilizator -- "utilizator" (login scurt) SAU numele
 *   complet -- omul scrie ce stie despre el, nu are de unde sti exact ce
 *   forma vrem (acelasi tipar ca licitatie-analiza/utilizatori.js).
 * @returns {{token,...}|{blocat:true}|null} null = utilizator/parola gresite
 */
function autentifica(utilizator, parola) {
  const cheie = curata(utilizator);
  if (esteBlocat(cheie)) return { blocat: true };

  const toate = db.toateFirmeleComplet();
  const potriviti = toate.filter((x) => curata(x.utilizator) === cheie || curata(x.nume) === cheie);
  // Daca doua firme au acelasi nume, numele nu mai identifica pe nimeni --
  // cerem atunci utilizatorul exact, nu ghicim pe care dintre ele o vrea.
  const f = potriviti.length === 1 ? potriviti[0]
    : toate.find((x) => curata(x.utilizator) === cheie) || null;

  // Chiar daca nu exista contul, calculam o amprenta -- altfel raspunsul ar
  // veni mai repede pentru firme inexistente si s-ar putea afla care conturi exista.
  const sare = f ? f.sare : 'sare-inexistenta';
  const calc = amprenta(parola, sare);
  if (!f || f.dezactivat || !potrivesc(calc, f.hash_parola)) { inregistreazaEsec(cheie); return null; }

  incercariEsuate.delete(cheie);
  const token = crypto.randomBytes(32).toString('hex');
  db.insereazaSesiunePublica(token, f.id, new Date(Date.now() + DURATA_SESIUNE_MS).toISOString());
  db.actualizeazaUltimaIntrareFirma(f.id);

  return { token, firmaId: f.id, nume: f.nume, email: f.email, parolaTemporara: !!f.parola_temporara };
}

function sesiune(token) {
  if (!token) return null;
  const s = db.sesiunePublica(token);
  if (!s) return null;
  const f = db.firmaDupaId(s.firma_id);
  if (!f || f.dezactivat) return null;
  return { firmaId: f.id, nume: f.nume, email: f.email, parolaTemporara: !!f.parola_temporara };
}

const iesi = (token) => db.stergeSesiunePublica(token);

/** Sesiunea din cookie-ul cererii, sau null. */
function dinCerere(req) {
  const brut = req.headers.cookie || '';
  const m = brut.match(/(?:^|;\s*)sesiune_firma=([a-f0-9]+)/);
  return m ? sesiune(m[1]) : null;
}

module.exports = {
  DURATA_SESIUNE_MS,
  creeaza, schimbaParola, autentifica, sesiune, iesi, dinCerere,
  listeaza: db.toateFirmele,
};
