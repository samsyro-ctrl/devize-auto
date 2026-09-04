// src/preturi.js
// Prima versiune nu preteruieste automat -- nomenclatorul are preturi vechi/
// placeholder (vezi verificarea facuta la import), nu preturi de piata
// curente. In schimb, exporta lista de resurse ca Excel, editabil manual,
// si o reincarca -- pretul introdus ramane in cache-ul GLOBAL (preturi_curente),
// reutilizat automat la urmatoarele proiecte.
'use strict';

const db = require('./db');
const { ensureDir } = require('./util');

const ETICHETA_TIP = { 1: 'Manopera', 2: 'Utilaj', 3: 'Material' };

/** Resursele agregate ale unui proiect, cu pretul curent (din cache) alaturat. */
const listaResursePentruPreturi = (proiectId) => db.resurseAgregatePeProiect(proiectId);

/**
 * Scrie lista de resurse intr-un Excel, cu coloana "Pret unitar" goala sau
 * precompletata din cache -- omul o editeaza si o reincarca.
 */
function exportaPreturiExcel(proiectId, cale) {
  const XLSX = require('xlsx');
  const resurse = listaResursePentruPreturi(proiectId);
  const randuri = resurse.map((r) => ({
    Colectie: r.colectie,
    Cod: r.cod,
    Tip: ETICHETA_TIP[r.tip] || r.tip,
    Descriere: r.descriere,
    Unitate: r.unitate,
    'Cantitate necesara': r.cantitate_totala,
    'Pret unitar': r.pret_curent || '',
  }));
  const foaie = XLSX.utils.json_to_sheet(randuri);
  const carte = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(carte, foaie, 'Preturi');
  ensureDir(require('path').dirname(cale));
  XLSX.writeFile(carte, cale);
  return randuri.length;
}

/**
 * Reincarca un Excel de preturi (exportat si editat manual). Doar randurile
 * cu "Pret unitar" completat si numeric se salveaza -- restul raman goale
 * pentru urmatoarea trecere, fara sa strice ce era deja in cache.
 * @returns {{salvate:number, ignorate:number}}
 */
function incarcaPreturiExcel(cale) {
  const XLSX = require('xlsx');
  const carte = XLSX.readFile(cale);
  const foaie = carte.Sheets[carte.SheetNames[0]];
  const randuri = XLSX.utils.sheet_to_json(foaie);

  let salvate = 0;
  let ignorate = 0;
  for (const r of randuri) {
    const colectie = r.Colectie;
    const cod = r.Cod;
    const pret = Number(r['Pret unitar']);
    if (!colectie || !cod || !Number.isFinite(pret) || pret <= 0) { ignorate++; continue; }
    db.salveazaPretCurent(colectie, cod, pret);
    salvate++;
  }
  return { salvate, ignorate };
}

module.exports = { listaResursePentruPreturi, exportaPreturiExcel, incarcaPreturiExcel };
