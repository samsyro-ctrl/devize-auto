// src/descompunere.js
// Expandarea unui articol compus pana la resursele-frunza (material/manopera/
// utilaj), cu cantitatea totala consumata per unitate din articolul parinte.
'use strict';

const db = require('./db');
const { parseUnitateScalata } = require('./util');

/**
 * Cauta un cod mai intai in colectia data, apoi in 'norme_munca' ca fallback
 * -- vezi comentariul din db.js (nomenclator_descompuneri): unele colectii
 * isi iau manopera din codurile comune Norme de Munca, nu din colectia lor.
 * @returns {{colectieRezolvata}|null}
 */
function rezolvaArticol(colectie, cod) {
  let art = db.cautaArticol(colectie, cod);
  if (art) return { ...art, colectieRezolvata: colectie };
  if (colectie !== 'norme_munca') {
    art = db.cautaArticol('norme_munca', cod);
    if (art) return { ...art, colectieRezolvata: 'norme_munca' };
  }
  return null;
}

// Memoizare per (colectie,cod) -- aceeasi reteta reaparand in zeci de linii
// ale aceluiasi proiect nu se re-parcurge de fiecare data. Cache-ul traieste
// cat procesul (per rulare de CLI), nu persistat -- nomenclatorul nu se
// schimba intre doua comenzi succesive.
const cacheExpandare = new Map();

/**
 * Expandeaza recursiv un articol pana la resurse-frunza.
 * @returns {Map<string, {colectie, cod, tip, unitate, descriere, cantitatePerUnitate}>}
 *   cheia e `${colectie}|${cod}` al resursei-frunza.
 */
function expandeazaPanaLaFrunze(colectie, cod, adancime = 0, avertismente = []) {
  const cheieCache = `${colectie}|${cod}`;
  if (cacheExpandare.has(cheieCache)) return cacheExpandare.get(cheieCache);
  if (adancime > 20) {
    avertismente.push(`Descompunere prea adanca la ${cheieCache} -- posibil ciclu in nomenclator, oprit.`);
    return new Map();
  }

  // O linie poate fi potrivita DIRECT pe o resursa bruta (transport/manopera/
  // utilaj/material), nu doar pe un articol compus -- gasire reala
  // (14.09.2026, SCN1178517): linii de transport pur ("TRANSPORTUL RUTIER...
  // PE DIST. = 20 KM"), cu cod dat de estimator EXACT corect ("TRA01A20"),
  // care insa e chiar o resursa-frunza (tip=0, TRANSPORT), fara copii
  // proprii -- fara acest caz special, copiiDescompunere ar intoarce gol
  // pentru un asemenea cod, iar linia ar iesi cu ZERO resurse, silentios
  // (devizul ar "uita" complet de acea linie la agregare/pretuire). Aici,
  // "reteta" e articolul insusi -- 1 unitate din el per unitate ceruta.
  // NU se aplica la adancime>0 (in interiorul unei retete): acolo, apelul
  // recursiv (mai jos) e facut STRICT pentru copii deja confirmati compusi
  // (tip==null) de apelant, deci verificarea de aici e un no-op sigur pentru
  // ei -- rezolva doar cazul cand INSUSI codul de varf e o resursa bruta.
  const propriuArticol = rezolvaArticol(colectie, cod);
  if (propriuArticol && propriuArticol.tip != null) {
    const rezultatFrunza = new Map([[
      `${propriuArticol.colectieRezolvata}|${propriuArticol.cod}`,
      {
        colectie: propriuArticol.colectieRezolvata, cod: propriuArticol.cod, tip: propriuArticol.tip,
        unitate: propriuArticol.unitate, descriere: propriuArticol.descriere, cantitatePerUnitate: 1,
      },
    ]]);
    cacheExpandare.set(cheieCache, rezultatFrunza);
    return rezultatFrunza;
  }

  const rezultat = new Map();
  const copii = db.copiiDescompunere(colectie, cod);
  for (const c of copii) {
    const artCopil = rezolvaArticol(colectie, c.cod_copil);
    if (!artCopil) {
      avertismente.push(`Cod nerezolvat: ${colectie}/${c.cod_copil} (copil al ${colectie}/${cod}) -- nu exista nici in colectia proprie, nici in norme_munca.`);
      continue;
    }
    if (artCopil.tip != null) {
      // Resursa-frunza: aduna direct.
      const cheieFrunza = `${artCopil.colectieRezolvata}|${artCopil.cod}`;
      const existent = rezultat.get(cheieFrunza);
      const cantitatePerUnitate = (existent ? existent.cantitatePerUnitate : 0) + c.cantitate;
      rezultat.set(cheieFrunza, {
        colectie: artCopil.colectieRezolvata, cod: artCopil.cod, tip: artCopil.tip,
        unitate: artCopil.unitate, descriere: artCopil.descriere, cantitatePerUnitate,
      });
    } else {
      // Articol compus la randul lui -- expandeaza recursiv, apoi scaleaza cu cantitatea ceruta aici.
      const subRezultat = expandeazaPanaLaFrunze(artCopil.colectieRezolvata, c.cod_copil, adancime + 1, avertismente);
      for (const [cheieFrunza, frunza] of subRezultat) {
        const existent = rezultat.get(cheieFrunza);
        const cantitatePerUnitate = (existent ? existent.cantitatePerUnitate : 0) + frunza.cantitatePerUnitate * c.cantitate;
        rezultat.set(cheieFrunza, { ...frunza, cantitatePerUnitate });
      }
    }
  }
  cacheExpandare.set(cheieCache, rezultat);
  return rezultat;
}

/**
 * Descompune o linie de antemasuratoare (articol + cantitate ceruta, in
 * unitati REALE -- ce a scris omul in antemasuratoare) in resursele-frunza
 * cu cantitatea totala necesara pentru toata linia.
 *
 * Unitatea articolului poate fi scalata ("100 mc") -- reteta din
 * nomenclator_descompuneri e per 1 "unitate de nomenclator" (=100 mc reale),
 * nu per 1 mc real. Cantitatea ceruta (in unitati reale) trebuie deci
 * impartita la factorul de scala INAINTE de multiplicare -- doar la acest
 * nivel (varful apelului); recursiv, in interiorul retetei, cantitatile
 * dintre articole sunt deja consistente intre ele, indiferent de unitatea
 * "reala" a fiecarui nivel (vezi parseUnitateScalata).
 * @returns {Map<string, {colectie, cod, tip, unitate, descriere, cantitateTotala}>}
 */
function descompuneLinie(colectie, cod, cantitateCeruta, avertismente = []) {
  const articol = db.cautaArticol(colectie, cod);
  const { factor } = parseUnitateScalata(articol ? articol.unitate : '');
  const cantitateNomenclator = cantitateCeruta / factor;

  const retetaPerUnitate = expandeazaPanaLaFrunze(colectie, cod, 0, avertismente);
  const rezultat = new Map();
  for (const [cheieFrunza, frunza] of retetaPerUnitate) {
    rezultat.set(cheieFrunza, { ...frunza, cantitateTotala: frunza.cantitatePerUnitate * cantitateNomenclator });
  }
  return rezultat;
}

module.exports = { rezolvaArticol, expandeazaPanaLaFrunze, descompuneLinie };
