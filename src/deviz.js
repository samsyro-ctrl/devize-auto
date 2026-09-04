// src/deviz.js
// Construieste devizul final: pentru fiecare linie confirmata, descompune
// reteta si preteruieste cu preturile curente (cache global), apoi grupeaza
// pe capitole si calculeaza centralizatorul (C+M+U + indirecte + profit + TVA).
'use strict';

const db = require('./db');
const { descompuneLinie } = require('./descompunere');
const { ensureDir } = require('./util');

const TIP_MATERIALE = 3;
const TIP_MANOPERA = 1;
const TIP_UTILAJ = 2;

/** Aduna, pe cele 3 categorii, valoarea unei linii dupa descompunere+pretuire. */
function valoareLinie(colectie, cod, cantitate, avertismente) {
  const reteta = descompuneLinie(colectie, cod, cantitate, avertismente);
  let materiale = 0;
  let manopera = 0;
  let utilaj = 0;
  for (const frunza of reteta.values()) {
    const pret = db.pretCurent(frunza.colectie, frunza.cod) || 0;
    const valoare = frunza.cantitateTotala * pret;
    if (frunza.tip === TIP_MATERIALE) materiale += valoare;
    else if (frunza.tip === TIP_MANOPERA) manopera += valoare;
    else if (frunza.tip === TIP_UTILAJ) utilaj += valoare;
  }
  return { materiale, manopera, utilaj, total: materiale + manopera + utilaj };
}

/**
 * Construieste devizul complet pentru un proiect.
 * @throws {Error} daca exista linii nerezolvate -- nu genereaza deviz partial fara avertisment explicit.
 */
function construiesteDeviz(proiectId) {
  const proiect = db.proiectDupaId(proiectId);
  if (!proiect) throw new Error(`Proiect inexistent: ${proiectId}`);

  const linii = db.liniiCuRezolutiiPeProiect(proiectId);
  const nerezolvate = linii.filter((l) => !l.colectie || !l.cod || !['auto', 'confirmat'].includes(l.stare));
  if (nerezolvate.length) {
    const exemple = nerezolvate.slice(0, 5).map((l) => `  #${l.ordine} "${l.denumire}" (stare: ${l.stare || 'fara rezolutie'})`).join('\n');
    throw new Error(`${nerezolvate.length} linii nerezolvate -- ruleaza intai "revizuieste ${proiectId}":\n${exemple}`
      + (nerezolvate.length > 5 ? `\n  ... si inca ${nerezolvate.length - 5}.` : ''));
  }

  const avertismente = [];
  const capitolePeNume = new Map();
  for (const l of linii) {
    const { materiale, manopera, utilaj, total } = valoareLinie(l.colectie, l.cod, l.cantitate, avertismente);
    const capitolNume = l.capitol || 'Nespecificat';
    if (!capitolePeNume.has(capitolNume)) capitolePeNume.set(capitolNume, { nume: capitolNume, linii: [], materiale: 0, manopera: 0, utilaj: 0, total: 0 });
    const cap = capitolePeNume.get(capitolNume);
    cap.linii.push({ ordine: l.ordine, denumire: l.denumire, cantitate: l.cantitate, unitate: l.unitate, materiale, manopera, utilaj, total });
    cap.materiale += materiale;
    cap.manopera += manopera;
    cap.utilaj += utilaj;
    cap.total += total;
  }

  const capitole = [...capitolePeNume.values()];
  const totalMateriale = capitole.reduce((s, c) => s + c.materiale, 0);
  const totalManopera = capitole.reduce((s, c) => s + c.manopera, 0);
  const totalUtilaj = capitole.reduce((s, c) => s + c.utilaj, 0);
  const totalCMU = totalMateriale + totalManopera + totalUtilaj;
  const indirecte = totalCMU * (proiect.adaos_indirecte_procent / 100);
  const dupaIndirecte = totalCMU + indirecte;
  const profit = dupaIndirecte * (proiect.adaos_profit_procent / 100);
  const totalGeneral = dupaIndirecte + profit;
  const tva = totalGeneral * (proiect.tva_procent / 100);
  const totalCuTva = totalGeneral + tva;

  return {
    proiect, capitole, avertismente,
    centralizator: {
      totalMateriale, totalManopera, totalUtilaj, totalCMU,
      adaosIndirecteProcent: proiect.adaos_indirecte_procent, indirecte,
      adaosProfitProcent: proiect.adaos_profit_procent, profit,
      totalGeneral, tvaProcent: proiect.tva_procent, tva, totalCuTva,
    },
  };
}

/** Exporta devizul construit ca Excel, cu o foaie pe capitol plus un centralizator. */
function exportaDevizExcel(proiectId, cale) {
  const XLSX = require('xlsx');
  const { proiect, capitole, centralizator, avertismente } = construiesteDeviz(proiectId);
  const carte = XLSX.utils.book_new();

  const randuriDeviz = [];
  for (const cap of capitole) {
    randuriDeviz.push({ Pozitie: '', Denumire: `--- ${cap.nume} ---`, Cantitate: '', UM: '', Materiale: '', Manopera: '', Utilaj: '', Total: '' });
    for (const l of cap.linii) {
      randuriDeviz.push({
        Pozitie: l.ordine, Denumire: l.denumire, Cantitate: l.cantitate, UM: l.unitate,
        Materiale: rotund(l.materiale), Manopera: rotund(l.manopera), Utilaj: rotund(l.utilaj), Total: rotund(l.total),
      });
    }
    randuriDeviz.push({ Pozitie: '', Denumire: `Subtotal ${cap.nume}`, Cantitate: '', UM: '',
      Materiale: rotund(cap.materiale), Manopera: rotund(cap.manopera), Utilaj: rotund(cap.utilaj), Total: rotund(cap.total) });
  }
  XLSX.utils.book_append_sheet(carte, XLSX.utils.json_to_sheet(randuriDeviz), 'Deviz');

  const c = centralizator;
  const randuriCentralizator = [
    { Element: 'Total Materiale', Valoare: rotund(c.totalMateriale) },
    { Element: 'Total Manopera', Valoare: rotund(c.totalManopera) },
    { Element: 'Total Utilaj', Valoare: rotund(c.totalUtilaj) },
    { Element: 'TOTAL C+M+U', Valoare: rotund(c.totalCMU) },
    { Element: `Cheltuieli indirecte (${c.adaosIndirecteProcent}%)`, Valoare: rotund(c.indirecte) },
    { Element: `Profit (${c.adaosProfitProcent}%)`, Valoare: rotund(c.profit) },
    { Element: 'TOTAL GENERAL (fara TVA)', Valoare: rotund(c.totalGeneral) },
    { Element: `TVA (${c.tvaProcent}%)`, Valoare: rotund(c.tva) },
    { Element: 'TOTAL GENERAL (cu TVA)', Valoare: rotund(c.totalCuTva) },
  ];
  XLSX.utils.book_append_sheet(carte, XLSX.utils.json_to_sheet(randuriCentralizator), 'Centralizator');

  if (avertismente.length) {
    XLSX.utils.book_append_sheet(carte, XLSX.utils.json_to_sheet(avertismente.map((a) => ({ Avertisment: a }))), 'Avertismente');
  }

  ensureDir(require('path').dirname(cale));
  XLSX.writeFile(carte, cale);
  return { proiect, avertismente };
}

const rotund = (n) => Math.round(n * 100) / 100;

module.exports = { construiesteDeviz, exportaDevizExcel };
