# devize-auto

Genereaza automat un deviz de constructii dintr-o antemasuratoare (Excel/PDF/Word),
folosind nomenclatorul de norme de deviz (indicatoare BC3/FIEBDC-3).

## Setup

```bash
npm install
cp .env.example .env
# completeaza ANTHROPIC_API_KEY si NOMENCLATOR_BC3_DIR in .env

node scripts/importa-nomenclator.js --scrie
node scripts/verifica-nomenclator.js

# optional, o singura data: preia preturile deja introduse manual in
# colectia "proprii" din recrutare-bot, ca punct de plecare pentru cache
node scripts/importa-preturi-proprii.js --scrie
```

## Calibrare (o singura data, inainte de a avea incredere in auto-matching)

```bash
node scripts/calibreaza-prag-matching.js
```

Uita-te la scorurile si gap-urile afisate pentru denumiri pe care le cunosti deja
raspunsul corect, apoi completeaza `PRAG_SCOR_MATCHING` si `PRAG_GAP_MATCHING` in `.env`.
Fara praguri calibrate, toate liniile merg la revizuire manuala (sigur, dar mai lent).

## Doua fluxuri de intrare

**Antemăsurătoare liberă** — doar denumire+cantitate+UM, fără nicio structură impusă.
Aleg singur, prin căutare, ce articol din nomenclator reprezintă fiecare linie:

```bash
node index.js incarca antemasuratoare.xlsx --proiect "Reabilitare scoala X"
```

**Deviz deja structurat (impus)** — vine cu propriile capitole/articole/cantități,
posibil chiar cu cod de nomenclator scris pe fiecare linie, dar fără valori.
Codul dat are prioritate (nu se mai caută liber în locul lui) — dar dacă nu
există în nomenclator, există în mai multe colecții deodată, sau unitatea nu
se potrivește, linia e semnalată explicit la revizuire, cu motivul exact:

```bash
node index.js incarca-deviz deviz-gol.xlsx --proiect "Modernizare stadion Buzau"
```

De aici încolo, ambele fluxuri continuă identic:

```bash
node index.js revizuieste 1
node index.js genereaza 1
node index.js preturi 1
# completeaza manual coloana "Pret unitar" in Excel-ul exportat
node index.js incarca-preturi output/proiecte/1/preturi.xlsx
node index.js export 1
```

`node index.js proiecte` — lista proiectelor existente si starea lor.

## Interfata web (panou)

Acelasi flux, dintr-o pagina in browser, in loc de linia de comanda:

```bash
npm run panou
# deschide http://127.0.0.1:7778
```

Server local simplu (`panou.js`, doar http-ul din Node, fara framework),
in stilul `licitatie-analiza/panou.js` -- asculta doar pe 127.0.0.1, nu e
vizibil din retea. Pagina (`panou.html`) e un singur fisier, fara build,
cu rutare pe hash (`#/proiect/3/preturi`).

## Structura

Vezi comentariile din fiecare fisier `src/*.js` -- fiecare explica DE CE, nu doar CE.
Nomenclatorul (`nomenclator_articole`/`nomenclator_descompuneri`/`nomenclator_fts`) e
o copie independenta a aceluiasi import folosit in `recrutare-bot`, nu partajata live.
