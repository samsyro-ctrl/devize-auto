// src/planExecutie.js
// Deriva un plan de executie (WBS, resurse alocate, durate, dependinte,
// drum critic/CPM, grafic Gantt, curba S, PERT) DIN devizul deja rezolvat --
// task de la Ofertetehnice (are nevoie de asta la redactarea propunerii
// tehnice), coordonat prin sesiunile "Open router management"/"Server"
// (12.09.2026). Principiul: planul se DEDUCE din deviz (cantitati+preturi+
// resurse pe C6-C9), nu se inventeaza separat.
//
// Gasire cheie din investigatie: nu exista azi nicio sursa de norme de
// productivitate (unitati/zi) sau de reguli de succesiune intre activitati --
// DAR exista un exemplu REAL, complet, deja construit pentru un proiect real
// (SCN1178630, generat cu openpyxl -- alta sesiune, nu de mana), care arata
// exact ce structura ar trebui sa aiba rezultatul: WBS, "Ore de manopera
// (din C7)", durata in zile lucratoare, precedenta cu tip de legatura
// (FS/SS/SS+2), drum critic, acoperire deviz<->activitate. Metodologia de
// AICI e conceputa sa produca acelasi FEL de rezultat, dar generalizat,
// pornind DOAR din ce exista deja in baza (fara sa copieze cifrele din acel
// exemplu -- alt proiect, alte cantitati).
//
// ONESTITATE DELIBERATA: durata unei activitati NU poate fi calculata exact
// fara o norma reala de productivitate (ore-om/zi realiste depind de meserie,
// conditii de santier etc., necunoscute azi) -- se foloseste o FORMULA
// simpla si transparenta (ore manopera / (marime echipa x ore pe zi)),
// marcata clar ca ESTIMARE, nu ca norma validata. Dependintele intre
// activitati se deduc dupa FAZA de constructie (cuvinte-cheie in numele
// capitolului) -- o capitol care nu se potriveste cu nicio faza cunoscuta NU
// primeste nicio dependenta automata (ramane semnalat, de completat manual),
// mai degraba decat o presupunere gresita.
'use strict';

const db = require('./db');
const { descompuneLinie } = require('./descompunere');

const TIP_TRANSPORT = 0;
const TIP_MANOPERA = 1;
const TIP_UTILAJ = 2;
const TIP_MATERIALE = 3;

// ─── Estimare durata (transparenta, NU o norma validata) ─────────────────────

const ORE_PE_ZI = 8; // schimb standard, uzual in constructii romanesti
// Marimea implicita a formatiei de lucru, cand nu putem deriva alta -- o
// singura valoare pentru tot proiectul (v1); de rafinat pe viitor daca se
// dovedeste nepotrivita (echipe mai mari pe activitati cu volum mare).
const MARIME_IMPLICITA_ECHIPA = 4;

function estimeazaDurataZile(oreManopera, marimeEchipa = MARIME_IMPLICITA_ECHIPA) {
  if (!(oreManopera > 0)) return 1; // fara manopera deloc (ex. doar achizitie material) -- 1 zi implicit, semnalat separat
  return Math.max(1, Math.ceil(oreManopera / (marimeEchipa * ORE_PE_ZI)));
}

// ─── Faze de constructie (pentru dependinte) -- HEURISTICA, nu regula
// universala. Ordinea listei conteaza (faza 0 = prima). ────────────────────

// Fix real (14.09.2026, gasit rulind plan-executie pe un proiect real, CEF
// Vadu Lat/SCN1178630): capitolul "Amenajarea terenului" NU se potrivea cu
// "amenajare\s+teren" -- articolul hotarat romanesc ("Amenajare" ->
// "Amenajarea", "teren" -> "terenului") sparge potrivirea EXACT la granita
// \s+/\s* dintr-o fraza cu mai multe cuvinte (un cuvant simplu, fara granita
// dupa el, tot se potriveste ca substring -- de-aia intrarile cu un singur
// cuvant de mai jos (ex. "nivelare", "excavati") erau deja sigure). Efect
// real: 7 din 9 capitole ale acelui proiect ramaneau "fara faza detectata"
// -- planul intreg pica la "2 zile" in loc de o durata plauzibila, tacut,
// fara nicio eroare. Reparat generalizand la radacina cuvantului + \w*
// pentru FIECARE fraza de mai multe cuvinte (nu doar cea gasita stricata),
// acelasi risc structural exista si la "zidarie portanta"/"curenti slabi/
// tari"/"punere in functiune", desi neconfirmate inca pe un caz real.
const FAZE_CONSTRUCTIE = [
  { faza: 0, nume: 'organizare de santier', rx: /organiz\w*\s+de\s+santier|amenaj\w*\s+teren\w*|predare[a]?\s+amplasament/i },
  { faza: 1, nume: 'terasamente', rx: /terasament|excavati|sapatur|nivelare|decapare|demolar/i },
  { faza: 2, nume: 'fundatii/infrastructura', rx: /fundati|infrastructur/i },
  { faza: 3, nume: 'rezistenta/structura', rx: /rezistent|structur|suprastructur|beton\s*armat\w*|schelet|zidari\w*\s*portant\w*/i },
  { faza: 4, nume: 'arhitectura/inchideri', rx: /arhitectur|zidari\w*|pereti(?!\s*portant)|acoperis|invelitoare|tamplarie/i },
  { faza: 5, nume: 'instalatii', rx: /instalati|electric|sanitar|termic|ventilati|curenti\w*\s*(slabi\w*|tari\w*)|hvac/i },
  { faza: 6, nume: 'finisaje', rx: /finisaj|zugraveal|pardosel|placaj|vopsitorie/i },
  { faza: 7, nume: 'montaj echipamente/dotari', rx: /montaj|echipament|utilaj\s*tehnologic|dotar/i },
  { faza: 8, nume: 'receptie/probe', rx: /receptie|probe|punere\w*\s*in\s*functiun\w*|PIF/i },
];

function gasesteFaza(capitol) {
  if (!capitol) return null;
  const g = FAZE_CONSTRUCTIE.find((f) => f.rx.test(capitol));
  return g ? g.faza : null;
}

// ─── Pasul 1+2: agregare resurse pe capitol (WBS), din liniile CURENTE ───────
// ale proiectului -- foloseste potrivirea existenta (colectie/cod), chiar
// daca linia e inca "de_revizuit" (planul de executie e un instrument
// ORIENTATIV, separat de devizul final pretuit -- nu cere ca tot proiectul
// sa fie finalizat/confirmat, spre deosebire de deviz.construiesteDeviz).

/**
 * @param {number} proiectId
 * @param {string[]} avertismente
 * @returns {Array<{capitol, faza, oreManopera, valoare:{materiale,manopera,utilaj,transport,total}, linii}>}
 */
function agregaPeCapitol(proiectId, avertismente) {
  const linii = db.liniiCuRezolutiiPeProiect(proiectId);
  const peCapitol = new Map();
  let neconfirmate = 0;

  for (const l of linii) {
    // STRICT doar linii 'auto'/'confirmat' -- aceeasi regula ca
    // deviz.construiesteDeviz. Gasire reala (12.09.2026, proiect SCN1179715,
    // 3077 linii): o linie "de_revizuit" tot are un cod CANDIDAT de la
    // matching.js (sub prag de incredere, nu validat de om) -- folosind
    // orice candidat, indiferent de stare, un singur candidat gresit (recipe
    // cu factor de conversie nepotrivit) a umflat orele de manopera ale unui
    // capitol la o valoare absurda, dand un plan de 21.769 zile (~84 ani) in
    // loc de ceva realist. Mai bine un plan PARTIAL, dar de incredere, decat
    // unul complet dar bazat pe potriviri neconfirmate.
    if (!l.colectie || !l.cod || !['auto', 'confirmat'].includes(l.stare)) { neconfirmate += 1; continue; } // eslint-disable-line no-continue
    const cheie = l.capitol || 'Nespecificat';
    if (!peCapitol.has(cheie)) {
      peCapitol.set(cheie, {
        capitol: cheie,
        faza: gasesteFaza(cheie),
        oreManopera: 0,
        valoare: {
          materiale: 0, manopera: 0, utilaj: 0, transport: 0, total: 0,
        },
        linii: [],
      });
    }
    const grup = peCapitol.get(cheie);
    grup.linii.push({ ordine: l.ordine, denumire: l.denumire, cantitate: l.cantitate, unitate: l.unitate });

    let reteta;
    try {
      reteta = descompuneLinie(l.colectie, l.cod, l.cantitate, avertismente);
    } catch (e) {
      avertismente.push(`Linia #${l.ordine} (${l.denumire}): descompunere esuata (${e.message}).`);
      continue; // eslint-disable-line no-continue
    }
    for (const frunza of reteta.values()) {
      const pret = db.pretCurent(frunza.colectie, frunza.cod) || 0;
      const valoare = frunza.cantitateTotala * pret;
      if (frunza.tip === TIP_MANOPERA) { grup.oreManopera += frunza.cantitateTotala; grup.valoare.manopera += valoare; } else if (frunza.tip === TIP_MATERIALE) grup.valoare.materiale += valoare;
      else if (frunza.tip === TIP_UTILAJ) grup.valoare.utilaj += valoare;
      else if (frunza.tip === TIP_TRANSPORT) grup.valoare.transport += valoare;
      grup.valoare.total += valoare;
    }
  }

  if (neconfirmate) {
    avertismente.push(`${neconfirmate} linii fara potrivire sau neconfirmate ("de_revizuit"/"fara_potrivire") -- excluse din planul de executie (doar linii "auto"/"confirmat" sunt destul de sigure pentru estimarea de durata/resurse). Planul de mai jos e PARTIAL -- ruleaza "revizuieste" pentru un plan complet.`);
  }

  return [...peCapitol.values()];
}

// ─── Pasul 3+4+5: durate, dependinte (pe faza), CPM, Gantt, curba S, PERT ────

/**
 * Construieste planul de executie complet pentru un proiect.
 * @param {number} proiectId
 * @param {{marimeEchipa?: number, dataInceput?: Date}} [optiuni]
 * @returns {{activitati, durataTotalaZile, drumCritic, curbaS, avertismente}}
 */
function construiestePlanExecutie(proiectId, optiuni = {}) {
  const avertismente = [];
  const grupuri = agregaPeCapitol(proiectId, avertismente);
  if (!grupuri.length) throw new Error(`Proiectul ${proiectId} n-are nicio linie cu potrivire de nomenclator -- nimic de planificat.`);

  const faraFaza = grupuri.filter((g) => g.faza === null).length;
  if (faraFaza) {
    avertismente.push(`${faraFaza} capitole nu s-au potrivit cu nicio faza de constructie cunoscuta -- fara dependinta automata, verifica manual succesiunea (le gasesti cu faza:null).`);
  }

  const marimeEchipa = optiuni.marimeEchipa || MARIME_IMPLICITA_ECHIPA;
  const activitati = grupuri.map((g, i) => ({
    id: i + 1,
    capitol: g.capitol,
    faza: g.faza,
    fazaNume: g.faza !== null ? FAZE_CONSTRUCTIE[g.faza].nume : null,
    oreManopera: Math.round(g.oreManopera * 100) / 100,
    durataZile: estimeazaDurataZile(g.oreManopera, marimeEchipa),
    valoare: g.valoare,
    numarLinii: g.linii.length,
  }));

  // Grupare pe faza (activitatile FARA faza detectata nu intra in CPM
  // automat -- raman "neancorate", cu esd/efd null, semnalate mai sus).
  const dataFaze = new Map(); // faza -> {durataMaxima, esd, efd}
  const cuFaza = activitati.filter((a) => a.faza !== null).sort((a, b) => a.faza - b.faza);
  let esdCurent = 0;
  for (const faza of [...new Set(cuFaza.map((a) => a.faza))].sort((a, b) => a - b)) {
    const dinFaza = cuFaza.filter((a) => a.faza === faza);
    const durataMaxima = Math.max(...dinFaza.map((a) => a.durataZile));
    dataFaze.set(faza, { esd: esdCurent, efd: esdCurent + durataMaxima, durataMaxima });
    for (const a of dinFaza) {
      a.esd = esdCurent;
      a.efd = esdCurent + a.durataZile;
      // Drumul critic = activitatea (activitatile) care determina durata
      // fazei ei -- daca a ei ar dura mai putin, faza tot ar dura cat cea
      // mai lenta activitate din ea, deci ORICE activitate cu durata ==
      // durata maxima a fazei e "critica" pentru acel gate.
      a.peDrumulCritic = a.durataZile === durataMaxima;
    }
    esdCurent += durataMaxima;
  }
  for (const a of activitati) {
    if (a.faza === null) { a.esd = null; a.efd = null; a.peDrumulCritic = null; }
  }

  const durataTotalaZile = esdCurent;
  const drumCritic = activitati.filter((a) => a.peDrumulCritic).map((a) => a.capitol);

  // PERT (optimist/pesimist/realist) -- variatie simpla +/-, NU o distributie
  // statistica reala (nu avem date istorice de abateri) -- semnalat ca atare.
  for (const a of activitati) {
    a.pert = {
      optimist: Math.max(1, Math.round(a.durataZile * 0.8)),
      realist: a.durataZile,
      pesimist: Math.round(a.durataZile * 1.3),
    };
  }

  // Curba S -- valoarea fiecarei activitati distribuita LINIAR pe zilele ei
  // [esd, efd), apoi cumulata pe zi, pe tot proiectul. Activitatile fara
  // faza (esd/efd null) nu intra in curba (nu stim cand s-ar executa).
  const valoarePeZi = new Array(Math.max(durataTotalaZile, 1)).fill(0);
  for (const a of activitati) {
    if (a.esd === null || a.durataZile <= 0) continue; // eslint-disable-line no-continue
    const valoarePeZiActivitate = a.valoare.total / a.durataZile;
    for (let z = a.esd; z < a.efd; z += 1) valoarePeZi[z] += valoarePeZiActivitate;
  }
  let cumulat = 0;
  const curbaS = valoarePeZi.map((v, i) => {
    cumulat += v;
    return { zi: i + 1, valoareZilnica: Math.round(v), valoareCumulata: Math.round(cumulat) };
  });

  return {
    activitati, durataTotalaZile, drumCritic, curbaS, avertismente,
  };
}

module.exports = {
  construiestePlanExecutie, agregaPeCapitol, gasesteFaza, estimeazaDurataZile, FAZE_CONSTRUCTIE,
};
