// src/util.js
// Helpers partajate. Copiat identic din recrutare-bot/src/util.js.
'use strict';

const fs = require('fs');

/** Asigura existenta unui director (recursiv). */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Data curenta ca YYYY-MM-DD (pentru numele fisierului). */
function todayStamp(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

/** Scoate diacriticele si trece la lowercase (comparatii robuste). */
function fold(s) {
  return String(s == null ? '' : s)
    .normalize('NFD')
    // ̀-ͯ = semnele diacritice combinate rezultate din NFD
    .replace(/[̀-ͯ]/g, '')
    .replace(/[șş]/gi, 's')
    .replace(/[țţ]/gi, 't')
    .toLowerCase()
    .trim();
}

/** Slug simplu, pentru id-uri stabile. */
function slug(s) {
  return fold(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Unitatile din nomenclator vin uneori scalate ("100 mc", "1000 buc", "10 mp")
 * -- reteta e definita per 100/1000/10 unitati reale, nu per 1. Confirmat
 * empiric: 7.512 din 291.246 articole (~2,6%) au unitate scalata, mai ales la
 * terasamente/excavatii, tocmai categoriile cu volume mari. Fara asta,
 * cantitatile calculate ar iesi de 100x (sau 1000x) prea mari.
 * @returns {{factor:number, baza:string}} baza = unitatea reala ("mc"), factor = cate unitati reale intra intr-un "1" din nomenclator.
 */
function parseUnitateScalata(unitate) {
  const text = fold(unitate).replace(/\s+/g, ' ').trim();
  const m = text.match(/^(\d+)\s*([a-z]+)/);
  if (m) return { factor: Number(m[1]), baza: m[2] };
  return { factor: 1, baza: text };
}

module.exports = { ensureDir, todayStamp, fold, slug, parseUnitateScalata };
