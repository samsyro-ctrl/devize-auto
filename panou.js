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
const bfla = require('./src/bfla');
const rfq = require('./src/rfq');
const planExecutie = require('./src/planExecutie');
const completitudine = require('./src/completitudine');
const istoricArticole = require('./src/istoricArticole');
const textDocumenteLicitatie = require('./src/textDocumenteLicitatie');
const serviciiToken = require('./src/servicii-token');
const { slug } = require('./src/util');

// Acces pe token de serviciu (src/servicii-token.js, SERVICE_TOKENS din .env)
// -- pentru UNELTE (Core API), nu oameni; panou.js nu are niciun sistem de
// conturi (e strict intern, ascultand doar pe 127.0.0.1). Un token valid NU
// deschide toate rutele, doar cele listate aici -- "plan-executie" (Server/
// Ofertetehnice) si "text-documente" (deduplicare OCR cu Ofertetehnice).
// Tipar identic cu RUTE_PENTRU_SERVICII din licitatie-analiza/panou.js.
const RUTE_PENTRU_SERVICII = new Set(['/api/plan-executie', '/api/text-documente']);

const PORT = parseInt(process.env.PANOU_PORT, 10) || 7778;
const RADACINA = __dirname;
const OUTPUT_DIR = path.join(RADACINA, 'output');

// Etichetele romanesti ale celor 3 roluri de model, pentru pagina de Setari --
// tehnic, db.ROLURI_MODEL ajunge, dar "MODEL_SCOP" singur nu spune nimic omului.
const ETICHETE_ROL_MODEL = {
  MODEL_EXTRAGERE: 'Extragere linii din antemăsurătoare',
  MODEL_SCOP: 'Extragere scop proiect (produs, activități)',
  MODEL_COMPLETITUDINE: 'Verificare completitudine deviz ↔ documentație',
  MODEL_DESCOMPUNERE: 'Devize predefinite — descompune activitate în poziții',
  MODEL_CANTITATI: 'Devize predefinite — extrage cantități din documentație',
};
let cacheModeleOR = { la: 0, lista: [] };

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
  // "no-store" DOAR pe HTML (SPA-ul insusi) -- vezi public-server.js pentru
  // motivul complet (gasit live: un fix deployat corect, dar browserul tot
  // servea din cache pagina veche).
  const headere = { 'Content-Type': contentType };
  if (contentType.startsWith('text/html')) headere['Cache-Control'] = 'no-store';
  res.writeHead(200, headere);
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
    if (p === '/favicon.svg') {
      return serveFisier(res, path.join(RADACINA, 'favicon.svg'), 'image/svg+xml');
    }

    // ─── Plan de executie (WBS/CPM/Gantt/curba S), pe cod de licitatie ───
    // Singura ruta de aici pe token de serviciu (RUTE_PENTRU_SERVICII, mai
    // sus) -- apelata azi doar de buildandfix-core, niciodata de panou.html.
    if (p === '/api/plan-executie' && req.method === 'GET') {
      const servicu = RUTE_PENTRU_SERVICII.has(p) ? serviciiToken.identificaServiciu(req.headers.authorization) : null;
      if (!servicu) return json(res, { eroare: 'neautorizat' }, 401);

      const cod = (u.searchParams.get('cod') || '').trim();
      if (!cod) return json(res, { eroare: 'lipseste parametrul "cod"' }, 400);
      const proiect = db.proiectDupaCodLicitatie(cod);
      if (!proiect) return json(res, { eroare: `niciun proiect gasit pentru codul de licitatie "${cod}"` }, 404);

      try {
        const plan = planExecutie.construiestePlanExecutie(proiect.id);
        // "complet" = true doar daca NICIO linie a proiectului n-a fost
        // exclusa ca neconfirmata (vezi avertismentul din agregaPeCapitol) --
        // Ofertetehnice/Core API il pot arata direct, fara sa parseze textul
        // avertismentelor ca sa afle daca planul e partial.
        const complet = db.liniiCuRezolutiiPeProiect(proiect.id).every((l) => ['auto', 'confirmat'].includes(l.stare));
        return json(res, {
          proiectId: proiect.id, codLicitatie: cod, complet, ...plan,
        });
      } catch (e) {
        return json(res, { eroare: e.message }, 422);
      }
    }

    // ─── Text documente licitatie (deduplicare OCR cu Ofertetehnice) ───
    // Pe token de serviciu, la fel ca "plan-executie" -- vezi
    // src/textDocumenteLicitatie.js. Lucreaza direct pe cod_licitatie, fara
    // sa ceara un proiect Devize existent -- poate fi apelata chiar inainte
    // ca noi sa fi importat vreun proiect pentru acea licitatie.
    if (p === '/api/text-documente' && req.method === 'GET') {
      const servicu = RUTE_PENTRU_SERVICII.has(p) ? serviciiToken.identificaServiciu(req.headers.authorization) : null;
      if (!servicu) return json(res, { eroare: 'neautorizat' }, 401);

      const cod = (u.searchParams.get('cod') || '').trim();
      if (!cod) return json(res, { eroare: 'lipseste parametrul "cod"' }, 400);

      try {
        const avertismente = [];
        const documente = await textDocumenteLicitatie.texteDocumenteLicitatie(cod, avertismente);
        return json(res, { codLicitatie: cod, documente, avertismente });
      } catch (e) {
        return json(res, { eroare: e.message }, 422);
      }
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
        // O singura interogare BFLA pentru tot lotul de linii, nu una per
        // linie -- vezi REGULA DE AUR din src/bfla.js. Esec sau BFLA
        // neconfigurat => lista goala, comportament identic cu azi.
        const bflaEntries = bfla.ACTIV ? await bfla.cauta({ tip: 'potrivire_articol', limita: 500 }) : [];
        let auto = 0; let deRevizuit = 0; let faraPotrivire = 0;
        for (const l of db.liniiPeProiect(proiectId)) {
          const rezolutie = alegeMatchFn(l, bflaEntries);
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

    // ─── Completitudine (Caz A/B -- activitati lipsa/partiale din deviz) ───
    // GET intoarce DOAR ultima verificare salvata (gratuit, fara apel AI) --
    // panoul afiseaza asta implicit; POST ruleaza din nou (cost real AI),
    // declansat explicit de un buton, niciodata implicit la simpla vizitare
    // a tab-ului (acelasi principiu ca la Robotul B din CLI -- costul real
    // cere o actiune explicita, nu se intampla la incarcarea paginii).
    const mCompletitudine = p.match(/^\/api\/proiecte\/(\d+)\/completitudine$/);
    if (mCompletitudine && req.method === 'GET') {
      const proiectId = Number(mCompletitudine[1]);
      const proiect = db.proiectDupaId(proiectId);
      if (!proiect) return json(res, { eroare: 'proiect inexistent' }, 404);
      let scop = null;
      try { scop = proiect.scop_json ? JSON.parse(proiect.scop_json) : null; } catch { /* scop lipsa/invalid -- ramane null */ }
      return json(res, {
        verificari: db.verificariCompletitudinePeProiect(proiectId),
        produs: scop?.produs || null,
        nivelLivrare: scop?.nivel_livrare || null,
        areScop: !!scop,
      });
    }
    if (mCompletitudine && req.method === 'POST') {
      const proiectId = Number(mCompletitudine[1]);
      try {
        const rezultat = await completitudine.verificaCompletitudine(proiectId);
        return json(res, rezultat);
      } catch (e) {
        return json(res, { eroare: e.message }, 422);
      }
    }

    // ─── Plan de executie (WBS/CPM/curba S) -- calcul LIVE, fara apel AI ───
    // (descompuneLinie e determinist, pretCurent e o simpla citire din cache)
    // -- niciun cost, deci se poate calcula direct la fiecare GET, fara
    // separare intre "ultima rulare salvata" si "ruleaza din nou" ca la
    // completitudine/cantitati-PT.
    const mExecutie = p.match(/^\/api\/proiecte\/(\d+)\/executie$/);
    if (mExecutie && req.method === 'GET') {
      const proiectId = Number(mExecutie[1]);
      const proiect = db.proiectDupaId(proiectId);
      if (!proiect) return json(res, { eroare: 'proiect inexistent' }, 404);
      try {
        return json(res, planExecutie.construiestePlanExecutie(proiectId));
      } catch (e) {
        return json(res, { eroare: e.message }, 422);
      }
    }

    // ─── Referinte istorice de pret (F3, devize castigatoare) -- gratuit ───
    // (cautare locala FTS5/cod exact in istoric_articole_castigate, fara AI).
    const mReferinte = p.match(/^\/api\/proiecte\/(\d+)\/referinte-istorice$/);
    if (mReferinte && req.method === 'GET') {
      const proiectId = Number(mReferinte[1]);
      const proiect = db.proiectDupaId(proiectId);
      if (!proiect) return json(res, { eroare: 'proiect inexistent' }, 404);
      const linii = db.liniiCuRezolutiiPeProiect(proiectId);
      const rezultate = linii.map((l) => ({
        linieId: l.id,
        ordine: l.ordine,
        denumire: l.denumire,
        capitol: l.capitol,
        cantitate: l.cantitate,
        unitate: l.unitate,
        referinte: istoricArticole.gasesteReferintaIstorica({ denumire: l.denumire, capitol: l.capitol, cod: l.cod }, 3),
      }));
      return json(res, { rezultate });
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
      const linie = db.confirmaRezolutie(corp.linieId, corp.colectie, corp.cod);
      // Scriere in BFLA DUPA ce confirmarea locala a reusit deja -- JSON-ul/
      // SQLite-ul local ramane sursa de adevar; esecul scrierii in BFLA nu
      // trebuie sa strice confirmarea, deja salvata (vezi REGULA DE AUR).
      if (bfla.ACTIV && linie?.denumire) {
        await bfla.scrie({
          tip: 'potrivire_articol',
          cheie: linie.denumire,
          continut: { colectie: corp.colectie, cod: corp.cod },
          validatDe: 'Cristian Samson (panou intern)',
          stare: 'HUMAN_VALIDATED',
        });
      }
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
      // Provenienta (Faza B) -- editare manuala directa in pagina de Preturi.
      db.adaugaIstoricPretSigur({
        colectie: corp.colectie, cod: corp.cod, pret: Number(corp.pret), tipSursa: 'MARKET_ESTIMATE',
        proiectId: corp.proiectId ? Number(corp.proiectId) : null, introdusDe: 'Cristian Samson (panou intern)',
      });
      return json(res, { ok: true });
    }

    // ─── RFQ (trimite necesarul de resurse spre recrutare-bot, prin Core API) ───
    const mRfq = p.match(/^\/api\/proiecte\/(\d+)\/rfq$/);
    if (mRfq && req.method === 'POST') {
      const proiectId = Number(mRfq[1]);
      const proiect = db.proiectDupaId(proiectId);
      if (!proiect) return json(res, { eroare: 'proiect inexistent' }, 404);
      try {
        const resurse = preturi.listaResursePentruPreturi(proiectId);
        const raspuns = await rfq.trimiteRfq(proiect, resurse);
        return json(res, raspuns);
      } catch (e) { return json(res, { eroare: e.message }, 502); }
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

    // ─── Setari model (alegere model per task, vezi src/ai.js + db.js) ───
    if (p === '/api/setari-model' && req.method === 'GET') {
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
      const corp = await citesteCorp(req);
      if (!db.ROLURI_MODEL.includes(corp.rol)) return json(res, { eroare: 'rol necunoscut' }, 400);
      try {
        db.seteazaModelRol(corp.rol, corp.modelSlug);
      } catch (e) {
        return json(res, { eroare: e.message }, 400);
      }
      return json(res, { ok: true });
    }

    // Catalogul de modele OpenRouter, pentru selectorul cu cautare din pagina
    // de Setari. Trecut prin server (nu chemat direct din browser) ca sa
    // ramana un singur loc care vorbeste cu OpenRouter. Cache in proces, o ora.
    if (p === '/api/modele-openrouter' && req.method === 'GET') {
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

    // Preturi castigatoare recente din recrutare-bot (domeniul 'cautare' in
    // BFLA, scrise la /alege-castigator) -- DOAR referinta, fara legatura
    // automata la un colectie/cod anume (cautareId nu se poate lega inapoi
    // de un proiect/resursa din devize-auto, vezi discutia din sesiune).
    // Intern (panou.js), nu si pe site-ul public -- aceleasi date "ale
    // noastre" ca preturile din colectia "proprii", nu pentru firme externe.
    if (p === '/api/preturi-castigatoare' && req.method === 'GET') {
      const experiente = bfla.ACTIV
        ? await bfla.cauta({ domeniu: 'cautare', tip: 'furnizor_castigator', limita: 50 })
        : [];
      const preturi = experiente.map((e) => ({
        firma: e.cheie,
        pret: e.continut?.pret ?? null,
        moneda: e.continut?.moneda || 'RON',
        durata: e.continut?.durata || null,
        validatDe: e.validatDe || null,
        creatLa: e.creatLa || null,
        // Sugestie AUTOMATA (nu auto-aplicare) -- daca firma a mai fost
        // legata manual de un cod inainte, il propunem, dar omul tot
        // confirma explicit prin acelasi /aplica ca la cautarea manuala.
        sugestii: db.sugestiiPentruFurnizor(e.cheie),
      }));
      return json(res, { preturi });
    }

    // Leaga MANUAL un pret castigator (BFLA, doar referinta) de un cod anume
    // din nomenclator -- omul cauta si alege codul (vezi /api/cauta), noi
    // doar salvam ce a ales el. Niciodata potrivire automata AI aici.
    if (p === '/api/preturi-castigatoare/aplica' && req.method === 'POST') {
      const corp = await citesteCorp(req);
      if (!corp.colectie || !corp.cod || !Number.isFinite(corp.pret)) {
        return json(res, { eroare: 'colectie, cod si pret sunt obligatorii' }, 400);
      }
      db.salveazaPretCurent(corp.colectie, corp.cod, corp.pret);
      db.adaugaIstoricPretSigur({
        colectie: corp.colectie,
        cod: corp.cod,
        pret: corp.pret,
        moneda: corp.moneda || 'RON',
        tipSursa: 'SUPPLIER_QUOTE',
        furnizor: corp.firma || null,
        introdusDe: 'Cristian Samson (panou intern)',
      });
      return json(res, { ok: true });
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
