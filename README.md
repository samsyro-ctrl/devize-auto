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

## Flux de lucru

```bash
node index.js incarca antemasuratoare.xlsx --proiect "Reabilitare scoala X"
node index.js revizuieste 1
node index.js genereaza 1
node index.js preturi 1
# completeaza manual coloana "Pret unitar" in Excel-ul exportat
node index.js incarca-preturi output/proiecte/1/preturi.xlsx
node index.js export 1
```

`node index.js proiecte` — lista proiectelor existente si starea lor.

## Structura

Vezi comentariile din fiecare fisier `src/*.js` -- fiecare explica DE CE, nu doar CE.
Nomenclatorul (`nomenclator_articole`/`nomenclator_descompuneri`/`nomenclator_fts`) e
o copie independenta a aceluiasi import folosit in `recrutare-bot`, nu partajata live.
