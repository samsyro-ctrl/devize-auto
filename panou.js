// panou.js
// Panoul de lucru: un mic server local + o pagina in browser.
//   node panou.js        (sau "npm run panou")
//
// Nicio dependinta noua fata de CLI -- doar http-ul din Node, plus modulele
// deja existente in src/ (db, extract, antemasuratoare, matching, descompunere,
// preturi, deviz). Serverul asculta DOAR pe 127.0.0.1, nu e vizibil din retea.
// Tipar (server plain, JSON helper, upload prin PUT cu corp brut, fara
// multipart) copiat din licitatie-analiza/panou.js, ca sa ramana consecvent.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const db = require('./src/db');
const extract = require('./src/extract');
const antemasuratoare = require('./src/antemasuratoare');
const matching = require('./src/matching');
const descompunere = require('./src/descompunere');
const preturi = require('./src/preturi');
const deviz = require('./src/deviz');
const { slug } = require('./src/util');

const PORT = parseInt(process.env.PANOU_PORT, 10) || 7778;
const RADACINA = __dirname;
const OUTPUT_DIR = path.join(RADACINA, 'output');

db.deschide(OUTPUT_DIR);

function caleProiect(proiectId, ...parti) {
  return path.join(OUTPUT_DIR, 'proiecte', String(proiectId), ...parti);
}

// ─── Helpers server (tipar din licitatie-analiza/panou.js) ──────────────────

function json(res, obj, cod = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(cod, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function citesteCorp(req) {
  return new Promise((rezolva) => {
    let d = '';
    req.on('data', (c) => { d += c; });
    req.on('end', () => { try { rezolva(JSON.parse(d || '{}')); } catch { rezolva({}); } });
  });
}

/** Fisier primit prin PUT, scris direct pe disc (fara multipart, fara dependinte). */
function primesteFisier(req, cale) {
  return new Promise((rezolva, respinge) => {
    fs.mkdirSync(path.dirname(cale), { recursive: true });
    const out = fs.createWriteStream(cale);
    req.pipe(out);
    out.on('finish', rezolva);
    out.on('error', respinge);
    req.on('error', respinge);
  });
}

/** Serveste un fisier static din disc (pagina, sau un export de descarcat). */
function serveFisier(res, cale, contentType) {
  const flux = fs.createReadStream(cale);
  flux.on('error', () => { res.writeHead(404); res.end('Nu gasesc fisierul.'); });
  res.writeHead(200, { 'Content-Type': contentType });
  flux.pipe(res);
}

// ─── Server ──────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = u.pathname;

  try {
    if (p === '/' || p === '/index.html') {
      return serveFisier(res, path.join(RADACINA, 'panou.html'), 'text/html; charset=utf-8');
    }

    // ─── Proiecte ───
    if (p === '/api/proiecte' && req.method === 'GET') {
      return json(res, db.toateProiectele());
    }

    if (p === '/api/proiecte' && req.method === 'PUT') {
      // Upload + procesare completa: extragere text -> extragere linii (AI) ->
      // matching. Sincron -- pentru un singur document, dureaza de obicei
      // sub un minut; clientul arata un "se proceseaza", nu progres pas-cu-pas.
      const nume = path.basename(u.searchParams.get('nume') || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
      const proiect = (u.searchParams.get('proiect') || '').trim();
      const flux = u.searchParams.get('flux') === 'impus' ? 'impus' : 'liber';
      if (!nume) return json(res, { eroare: 'lipseste numele fisierului' }, 400);
      if (!proiect) return json(res, { eroare: 'lipseste numele proiectului' }, 400);

      const caleTemp = path.join(OUTPUT_DIR, '_incarcari', `${Date.now()}-${nume}`);
      await primesteFisier(req, caleTemp);

      const avertismente = [];
      try {
        const text = await extract.textDinFisier({ nume, cale: caleTemp }, avertismente);
        if (!text) return json(res, { eroare: 'Nu am putut extrage text din fisier.', avertismente }, 422);

        const linii = await antemasuratoare.extrageLiniiAntemasuratoare(text, avertismente);
        if (!linii.length) return json(res, { eroare: 'Nicio linie gasita in document.', avertismente }, 422);

        const proiectId = db.creeazaProiect(proiect, nume);
        db.insereazaLiniiAntemasuratoare(proiectId, linii);

        const alegeMatchFn = flux === 'impus' ? matching.alegeMatchCuCod : matching.alegeMatch;
        let auto = 0; let deRevizuit = 0; let faraPotrivire = 0;
        for (const l of db.liniiPeProiect(proiectId)) {
          const rezolutie = alegeMatchFn(l);
          db.salveazaRezolutie(l.id, rezolutie);
          if (rezolutie.stare === 'auto') auto++;
          else if (rezolutie.stare === 'fara_potrivire') faraPotrivire++;
          else deRevizuit++;
        }
        db.actualizeazaStareProiect(proiectId, 'matching');

        return json(res, { proiectId, totalLinii: linii.length, auto, deRevizuit, faraPotrivire, avertismente });
      } finally {
        fs.unlink(caleTemp, () => {});
      }
    }

    const mProiect = p.match(/^\/api\/proiecte\/(\d+)$/);
    if (mProiect && req.method === 'GET') {
      const proiectId = Number(mProiect[1]);
      const proiect = db.proiectDupaId(proiectId);
      if (!proiect) return json(res, { eroare: 'proiect inexistent' }, 404);
      return json(res, { proiect, linii: db.liniiCuRezolutiiPeProiect(proiectId) });
    }

    // ─── Cautare in nomenclator (revizuire manuala) ───
    if (p === '/api/cauta' && req.method === 'GET') {
      const q = u.searchParams.get('q') || '';
      if (!q.trim()) return json(res, []);
      return json(res, matching.gasesteCandidati(q, 10));
    }

    // ─── Rezolutie (confirmare manuala a unei linii) ───
    const mRezolutie = p.match(/^\/api\/proiecte\/(\d+)\/rezolutie$/);
    if (mRezolutie && req.method === 'POST') {
      const corp = await citesteCorp(req);
      if (!corp.linieId || !corp.colectie || !corp.cod) return json(res, { eroare: 'linieId, colectie si cod sunt obligatorii' }, 400);
      db.confirmaRezolutie(corp.linieId, corp.colectie, corp.cod);
      return json(res, { ok: true });
    }

    // ─── Genereaza (descompunere + agregare resurse) ───
    const mGenereaza = p.match(/^\/api\/proiecte\/(\d+)\/genereaza$/);
    if (mGenereaza && req.method === 'POST') {
      const proiectId = Number(mGenereaza[1]);
      const linii = db.liniiCuRezolutiiPeProiect(proiectId);
      const nerezolvate = linii.filter((l) => !l.colectie || !l.cod || !['auto', 'confirmat'].includes(l.stare));
      if (nerezolvate.length) return json(res, { eroare: `${nerezolvate.length} linii nerezolvate -- revizuieste-le intai.`, nerezolvate: nerezolvate.length }, 422);

      db.stergeResurseAgregate(proiectId);
      const avertismente = [];
      for (const l of linii) {
        const reteta = descompunere.descompuneLinie(l.colectie, l.cod, l.cantitate, avertismente);
        for (const frunza of reteta.values()) {
          db.adaugaResursaAgregata(proiectId, {
            colectie: frunza.colectie, cod: frunza.cod, tip: frunza.tip,
            unitate: frunza.unitate, descriere: frunza.descriere, cantitate: frunza.cantitateTotala,
          });
        }
      }
      db.actualizeazaStareProiect(proiectId, 'generat');
      return json(res, { resurse: db.resurseAgregatePeProiect(proiectId).length, avertismente });
    }

    // ─── Resurse + preturi ───
    const mResurse = p.match(/^\/api\/proiecte\/(\d+)\/resurse$/);
    if (mResurse && req.method === 'GET') {
      return json(res, preturi.listaResursePentruPreturi(Number(mResurse[1])));
    }

    if (p === '/api/pret' && req.method === 'POST') {
      const corp = await citesteCorp(req);
      if (!corp.colectie || !corp.cod || !Number.isFinite(Number(corp.pret))) return json(res, { eroare: 'colectie, cod si pret sunt obligatorii' }, 400);
      db.salveazaPretCurent(corp.colectie, corp.cod, Number(corp.pret));
      return json(res, { ok: true });
    }

    // ─── Deviz final ───
    const mDeviz = p.match(/^\/api\/proiecte\/(\d+)\/deviz$/);
    if (mDeviz && req.method === 'GET') {
      const proiectId = Number(mDeviz[1]);
      try {
        return json(res, deviz.construiesteDeviz(proiectId));
      } catch (e) {
        return json(res, { eroare: e.message }, 422);
      }
    }

    const mExport = p.match(/^\/api\/proiecte\/(\d+)\/export$/);
    if (mExport && req.method === 'GET') {
      const proiectId = Number(mExport[1]);
      const proiect = db.proiectDupaId(proiectId);
      if (!proiect) return json(res, { eroare: 'proiect inexistent' }, 404);
      const cale = caleProiect(proiectId, `deviz-${slug(proiect.nume)}.xlsx`);
      try {
        deviz.exportaDevizExcel(proiectId, cale);
      } catch (e) {
        return json(res, { eroare: e.message }, 422);
      }
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${path.basename(cale)}"`,
      });
      return fs.createReadStream(cale).pipe(res);
    }

    res.writeHead(404); res.end('Not found');
  } catch (e) {
    console.error(e);
    json(res, { eroare: e.message || String(e) }, 500);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Panou devize-auto: http://127.0.0.1:${PORT}`);
});
