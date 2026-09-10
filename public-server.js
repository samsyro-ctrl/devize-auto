// public-server.js
// Versiunea PUBLICA a panoului (devize.buildandfix.ai) -- firme externe, cu
// cont propriu, izolate complet una de alta si de instrumentul intern.
//
// Reutilizeaza NESCHIMBAT tot motorul stateless (matching, descompunere,
// extragere AI) -- doar persistenta si autentificarea sunt diferite fata de
// panou.js: baza proprie (public.db, nu devize.db), fiecare proiect legat de
// o firma_id, fiecare pret in preturi_curente_firma, nu in cache-ul global.
// Vezi planul (goofy-dazzling-bee.md) pentru motivatia completa.
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
const deviz = require('./src/deviz');
const { slug } = require('./src/util');
const firmePublic = require('./src/firmePublic');

const PORT = parseInt(process.env.PUBLIC_PORT, 10) || 8090;
const RADACINA = __dirname;
const OUTPUT_DIR = path.join(RADACINA, 'output');

// Firma-proprietar (RED POWER CONS -- singura cu acces la Administrare, vezi
// mai jos) -- acelasi tipar ca PROPRIETAR din recrutare-bot/src/server.js,
// un email comparat, nu un rol nou in baza. Nicio alta firma de pe platforma
// publica, oricat de veche, nu vede vreodata pagina asta.
const EMAIL_PROPRIETAR = (process.env.EMAIL_PROPRIETAR_DEVIZE || '').toLowerCase();
let cacheModeleOR = { la: 0, lista: [] };
const ETICHETE_ROL_MODEL = {
  MODEL_EXTRAGERE: 'Extragere linii din antemăsurătoare',
  MODEL_SCOP: 'Extragere scop proiect (produs, activități)',
  MODEL_COMPLETITUDINE: 'Verificare completitudine deviz ↔ documentație',
  MODEL_DESCOMPUNERE: 'Devize predefinite — descompune activitate în poziții',
  MODEL_CANTITATI: 'Devize predefinite — extrage cantități din documentație',
};

db.deschide(OUTPUT_DIR, 'public.db');

function caleProiect(proiectId, ...parti) {
  return path.join(OUTPUT_DIR, 'public-proiecte', String(proiectId), ...parti);
}

// ─── Helpers server (acelasi tipar ca panou.js/licitatie-analiza) ───────────

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

function serveFisier(res, cale, contentType) {
  const flux = fs.createReadStream(cale);
  flux.on('error', () => { res.writeHead(404); res.end('Nu gasesc fisierul.'); });
  res.writeHead(200, { 'Content-Type': contentType });
  flux.pipe(res);
}

// ─── Server ──────────────────────────────────────────────────────────────────

const PUBLICE = new Set(['/api/login', '/api/stare-acces']);

// Candidatii de nomenclator (matching.gasesteCandidati) includ "pret" -- util
// intern (panou.js), dar AICI, pe partea publica, o parte din nomenclator
// (colectia "proprii") are preturile NOASTRE negociate. UI-ul nu le afiseaza
// niciodata, dar tot ajungeau in JSON-ul brut al raspunsului (vizibile in
// devtools) -- scoase explicit, la marginea publica, nu in motorul comun.
const faraPret = (candidati) => (candidati || []).map(({ pret, ...rest }) => rest);
const faraPretDinJson = (candidatiJson) => JSON.stringify(faraPret(JSON.parse(candidatiJson || '[]')));

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = u.pathname;

  try {
    if (p === '/' || p === '/index.html') {
      return serveFisier(res, path.join(RADACINA, 'public.html'), 'text/html; charset=utf-8');
    }
    if (p === '/favicon.svg') {
      return serveFisier(res, path.join(RADACINA, 'favicon.svg'), 'image/svg+xml');
    }

    const sesiune = firmePublic.dinCerere(req);
    if (!sesiune && !PUBLICE.has(p)) {
      return json(res, { eroare: 'neautentificat' }, 401);
    }

    // Cookie-ul de sesiune. In spatele lui Caddy cererea ajunge aici pe http,
    // dar omul e pe https -- "Secure" se pune dupa X-Forwarded-Proto, nu dupa
    // protocolul cererii (acelasi tipar ca licitatie-analiza/panou.js).
    const peHttps = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https'
                 || process.env.COOKIE_SECURE === '1';
    const cookieSesiune = (val, maxAge) =>
      `sesiune_firma=${val}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${peHttps ? '; Secure' : ''}`;

    if (p === '/api/stare-acces') {
      return json(res, {
        autentificat: !!sesiune,
        firma: sesiune ? {
          nume: sesiune.nume, email: sesiune.email, parolaTemporara: sesiune.parolaTemporara,
          proprietar: !!EMAIL_PROPRIETAR && (sesiune.email || '').toLowerCase() === EMAIL_PROPRIETAR,
        } : null,
      });
    }

    if (p === '/api/login' && req.method === 'POST') {
      const { utilizator, parola } = await citesteCorp(req);
      const r = firmePublic.autentifica(utilizator, parola);
      if (r && r.blocat) {
        return json(res, { eroare: 'Prea multe încercări greșite. Așteaptă câteva minute și mai încearcă o dată.' }, 429);
      }
      if (!r) return json(res, { eroare: 'Utilizator sau parolă greșită' }, 401);
      res.setHeader('Set-Cookie', cookieSesiune(r.token, firmePublic.DURATA_SESIUNE_MS / 1000));
      return json(res, { ok: true, nume: r.nume, email: r.email, parolaTemporara: r.parolaTemporara });
    }

    if (p === '/api/logout' && req.method === 'POST') {
      const m = (req.headers.cookie || '').match(/(?:^|;\s*)sesiune_firma=([a-f0-9]+)/);
      if (m) firmePublic.iesi(m[1]);
      res.setHeader('Set-Cookie', cookieSesiune('', 0));
      return json(res, { ok: true });
    }

    if (p === '/api/schimba-parola' && req.method === 'POST') {
      const { parolaVeche, parolaNoua } = await citesteCorp(req);
      try {
        firmePublic.schimbaParola(sesiune.firmaId, parolaVeche, parolaNoua);
        return json(res, { ok: true });
      } catch (e) { return json(res, { eroare: e.message }, 400); }
    }

    const firmaId = sesiune && sesiune.firmaId;

    // ─── Proiecte (scopate STRICT pe firma_id din sesiune) ───
    if (p === '/api/proiecte' && req.method === 'GET') {
      return json(res, db.proiectePeFirma(firmaId));
    }

    if (p === '/api/proiecte' && req.method === 'PUT') {
      const nume = path.basename(u.searchParams.get('nume') || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
      const proiect = (u.searchParams.get('proiect') || '').trim();
      const flux = u.searchParams.get('flux') === 'impus' ? 'impus' : 'liber';
      if (!nume) return json(res, { eroare: 'lipseste numele fisierului' }, 400);
      if (!proiect) return json(res, { eroare: 'lipseste numele proiectului' }, 400);

      const caleTemp = path.join(OUTPUT_DIR, '_incarcari-publice', `${Date.now()}-${nume}`);
      await primesteFisier(req, caleTemp);

      const avertismente = [];
      try {
        const text = await extract.textDinFisier({ nume, cale: caleTemp }, avertismente);
        if (!text) return json(res, { eroare: 'Nu am putut extrage text din fisier.', avertismente }, 422);

        const linii = await antemasuratoare.extrageLiniiAntemasuratoare(text, avertismente);
        if (!linii.length) return json(res, { eroare: 'Nicio linie gasita in document.', avertismente }, 422);

        const proiectId = db.creeazaProiectPentruFirma(proiect, nume, firmaId);
        db.insereazaLiniiAntemasuratoare(proiectId, linii);

        const alegeMatchFn = flux === 'impus' ? matching.alegeMatchCuCod : matching.alegeMatch;
        let auto = 0; let deRevizuit = 0; let faraPotrivire = 0;
        for (const l of db.liniiPeProiect(proiectId)) {
          const rezolutie = alegeMatchFn(l);
          if (rezolutie.candidati_json) rezolutie.candidati_json = faraPretDinJson(rezolutie.candidati_json);
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
      const proiect = db.proiectDupaIdSiFirma(proiectId, firmaId);
      if (!proiect) return json(res, { eroare: 'proiect inexistent' }, 404);
      return json(res, { proiect, linii: db.liniiCuRezolutiiPeProiect(proiectId) });
    }

    if (p === '/api/cauta' && req.method === 'GET') {
      const q = u.searchParams.get('q') || '';
      if (!q.trim()) return json(res, []);
      return json(res, faraPret(matching.gasesteCandidati(q, 10)));
    }

    const mRezolutie = p.match(/^\/api\/proiecte\/(\d+)\/rezolutie$/);
    if (mRezolutie && req.method === 'POST') {
      const proiectId = Number(mRezolutie[1]);
      if (!db.proiectDupaIdSiFirma(proiectId, firmaId)) return json(res, { eroare: 'proiect inexistent' }, 404);
      const corp = await citesteCorp(req);
      if (!corp.linieId || !corp.colectie || !corp.cod) return json(res, { eroare: 'linieId, colectie si cod sunt obligatorii' }, 400);
      db.confirmaRezolutie(corp.linieId, corp.colectie, corp.cod);
      return json(res, { ok: true });
    }

    const mGenereaza = p.match(/^\/api\/proiecte\/(\d+)\/genereaza$/);
    if (mGenereaza && req.method === 'POST') {
      const proiectId = Number(mGenereaza[1]);
      if (!db.proiectDupaIdSiFirma(proiectId, firmaId)) return json(res, { eroare: 'proiect inexistent' }, 404);
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
      return json(res, { resurse: db.resurseAgregatePeProiectFirma(proiectId, firmaId).length, avertismente });
    }

    const mResurse = p.match(/^\/api\/proiecte\/(\d+)\/resurse$/);
    if (mResurse && req.method === 'GET') {
      const proiectId = Number(mResurse[1]);
      if (!db.proiectDupaIdSiFirma(proiectId, firmaId)) return json(res, { eroare: 'proiect inexistent' }, 404);
      return json(res, db.resurseAgregatePeProiectFirma(proiectId, firmaId));
    }

    if (p === '/api/pret' && req.method === 'POST') {
      const corp = await citesteCorp(req);
      if (!corp.colectie || !corp.cod || !Number.isFinite(Number(corp.pret))) return json(res, { eroare: 'colectie, cod si pret sunt obligatorii' }, 400);
      db.salveazaPretCurentFirma(firmaId, corp.colectie, corp.cod, Number(corp.pret));
      return json(res, { ok: true });
    }

    const mDeviz = p.match(/^\/api\/proiecte\/(\d+)\/deviz$/);
    if (mDeviz && req.method === 'GET') {
      const proiectId = Number(mDeviz[1]);
      if (!db.proiectDupaIdSiFirma(proiectId, firmaId)) return json(res, { eroare: 'proiect inexistent' }, 404);
      try {
        return json(res, deviz.construiesteDeviz(proiectId, firmaId));
      } catch (e) {
        return json(res, { eroare: e.message }, 422);
      }
    }

    const mExport = p.match(/^\/api\/proiecte\/(\d+)\/export$/);
    if (mExport && req.method === 'GET') {
      const proiectId = Number(mExport[1]);
      const proiect = db.proiectDupaIdSiFirma(proiectId, firmaId);
      if (!proiect) return json(res, { eroare: 'proiect inexistent' }, 404);
      const cale = caleProiect(proiectId, `deviz-${slug(proiect.nume)}.xlsx`);
      try {
        deviz.exportaDevizExcel(proiectId, cale, firmaId);
      } catch (e) {
        return json(res, { eroare: e.message }, 422);
      }
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${path.basename(cale)}"`,
      });
      return fs.createReadStream(cale).pipe(res);
    }

    // ─── Administrare (STRICT firma-proprietar, vezi EMAIL_PROPRIETAR) ───
    // Reutilizeaza NESCHIMBAT db.setariModel/seteazaModelRol/ROLURI_MODEL --
    // tabelul setari_model exista deja in public.db (schema comuna cu
    // devize.db), doar rutele si pagina sunt noi aici.
    const ePropietar = !!sesiune && !!EMAIL_PROPRIETAR && (sesiune.email || '').toLowerCase() === EMAIL_PROPRIETAR;

    if (p === '/api/setari-model' && req.method === 'GET') {
      if (!ePropietar) return json(res, { eroare: 'Nu ai acces aici.' }, 403);
      const suprascrieri = db.setariModel();
      const roluri = db.ROLURI_MODEL.map((rol) => {
        const implicitEnv = process.env[rol] || 'claude-sonnet-5';
        const suprascris = suprascrieri[rol] || null;
        return {
          rol, eticheta: ETICHETE_ROL_MODEL[rol] || rol,
          implicitEnv, modelActiv: suprascris || implicitEnv, suprascris: !!suprascris,
        };
      });
      return json(res, { roluri });
    }

    if (p === '/api/setari-model' && req.method === 'POST') {
      if (!ePropietar) return json(res, { eroare: 'Nu ai acces aici.' }, 403);
      const corp = await citesteCorp(req);
      if (!db.ROLURI_MODEL.includes(corp.rol)) return json(res, { eroare: 'rol necunoscut' }, 400);
      try {
        db.seteazaModelRol(corp.rol, corp.modelSlug);
      } catch (e) {
        return json(res, { eroare: e.message }, 400);
      }
      return json(res, { ok: true });
    }

    if (p === '/api/modele-openrouter' && req.method === 'GET') {
      if (!ePropietar) return json(res, { eroare: 'Nu ai acces aici.' }, 403);
      const ORA = 60 * 60 * 1000;
      if (Date.now() - cacheModeleOR.la > ORA) {
        try {
          const r = await fetch('https://openrouter.ai/api/v1/models');
          const j = await r.json();
          cacheModeleOR = {
            la: Date.now(),
            lista: (j.data || []).map((m) => ({
              id: m.id, nume: m.name,
              structurat: (m.supported_parameters || []).includes('structured_outputs'),
            })),
          };
        } catch (e) {
          console.warn(`   ⚠️  catalog OpenRouter indisponibil: ${e.message}`);
          if (!cacheModeleOR.lista.length) return json(res, { eroare: 'Catalogul de modele e indisponibil chiar acum.' }, 502);
        }
      }
      return json(res, { modele: cacheModeleOR.lista });
    }

    res.writeHead(404); res.end('Not found');
  } catch (e) {
    console.error(e);
    json(res, { eroare: e.message || String(e) }, 500);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Panou public devize-auto: http://127.0.0.1:${PORT}`);
});
