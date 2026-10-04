# Sentieri

App di mappa dei sentieri per il telefono: https://ynnoronny.github.io/sentieri/

È basata sul sito open source [Waymarked Trails](https://hiking.waymarkedtrails.org)
(di Sarah Hoffmann e collaboratori, licenza GPL-3.0), con in più:

- installazione sulla schermata Home come app;
- uso offline: mappe, sentieri, schede e ricerche già viste restano salvate nel telefono;
- apertura sulla zona delle Foreste Casentinesi.

Dati © OpenStreetMap contributors (ODbL).

## Le app

- `/` – **Sentieri, il compagno di cammino** (nuova): segui un sentiero e vedi quanto manca, la salita, il tempo, fonti, rifugi e paline; GPS a intervalli per risparmiare batteria; SOS a pressione lunga; mappa scura con curve di livello. Dati: OpenStreetMap via Waymarked Trails, Overpass e Nominatim; mappa OpenTopoMap (CC-BY-SA); quote da Terrain Tiles; schede della zona da Wikipedia (CC BY-SA) e iNaturalist.
- `/waymarked/` – il sito di Waymarked Trails con offline.
- `/classica/` – la prima versione.

## Struttura

- `/waymarked/` – la copia compilata di Waymarked Trails
- `sorgente/` – il codice sorgente. Per ricompilare:
  `cd sorgente && npm install && npx rollup -c && python3 make_sw.py`,
  poi copiare `sorgente/public/` in `waymarked/`.
- `classica/` – la prima versione dell'app, più semplice.

Licenza: GPL-3.0 (vedi `COPYING`).
