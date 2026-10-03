# Sentieri

App di mappa dei sentieri per il telefono: https://ynnoronny.github.io/sentieri/

È basata sul sito open source [Waymarked Trails](https://hiking.waymarkedtrails.org)
(di Sarah Hoffmann e collaboratori, licenza GPL-3.0), con in più:

- installazione sulla schermata Home come app;
- uso offline: mappe, sentieri, schede e ricerche già viste restano salvate nel telefono;
- apertura sulla zona delle Foreste Casentinesi.

Dati © OpenStreetMap contributors (ODbL).

## Struttura

- `/` – l'app compilata (servita da GitHub Pages)
- `sorgente/` – il codice sorgente. Per ricompilare:
  `cd sorgente && npm install && npx rollup -c && python3 make_sw.py`,
  poi copiare `sorgente/public/` nella radice.
- `classica/` – la prima versione dell'app, più semplice.

Licenza: GPL-3.0 (vedi `COPYING`).
