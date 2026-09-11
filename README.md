# VNB-Karte + for.Watt coverage overlay

A map of German distribution grid operators (Verteilnetzbetreiber) coloured by their
smart-meter rollout quota, with an overlay for the **Messstellenbetreiber supported by for.Watt**.

**Live:** https://elboiler.github.io/for-watt-vnb-monitoring/

Built on the great work at [vnb-monitoring.org](https://vnb-monitoring.org/), enhanced by
[Thomas Boyle](https://www.linkedin.com/in/tom-boyle-92345a17/).

## What it does

- **Map** – Leaflet choropleth of ~10,900 Gemeinde tiles across ~717 VNB on a light CARTO basemap.
  Modes: *Smart-Meter-Quote* (with/without optional install cases) and *Anzahl Zähler*.
  Filters (quote %, meter count), a ranking list, and hover tooltips.
- **for.Watt overlay** – toggle in the sidebar. Territories whose operator is a for.Watt-supported
  Messstellenbetreiber keep their choropleth colour and get a for.Watt-orange outline; the rest grey out.
  Each on-map operator shows its Smart-Meter-Quote, smart-meter count and total meters.
- **Germany-wide estimate** – share of metering points / smart meters that sit in a for.Watt
  grid territory (lower bound; überregionale MSB have no single area and are listed separately).

## Running it

Static site — GitHub Pages serves the repo root. No build step, no dependencies.

```bash
node server.js         # local preview at http://localhost:5173 (zero deps)
```

---

## Updating

There are two independent data sources, each with its own update process. Both are plain
files in `data/` — edit or regenerate, then commit; the page reads them on every load.

### 1. The for.Watt Messstellenbetreiber list

`data/messstellenbetreiber.json` is a **manually maintained** list — the source of truth for
which operators for.Watt supports.

```json
{
  "operators": ["Stromnetz Berlin GmbH", "WEMAG Netz GmbH", "..."],
  "aliases": { "Tricky MSB name": "Exact VNB name in the dataset" }
}
```

To update: add/remove names in `operators`, then verify and commit:

```bash
npm run check          # prints every mapping; FAILS if any match isn't name-anchored
git add data/messstellenbetreiber.json && git commit -m "update MSB list" && git push
```

Matching (`lib/match.js`) is by **operator name only** — city is never used, which is what
previously mis-mapped "Stadtwerke Erfurt" to TEN. Every match must share a distinctive name
token with its VNB. Operators that are national/independent MSBs (e.g. metrify, Solandeo,
wattline, 50Hertz) have no single territory and appear under *Weitere for.Watt-Partner*.
If a name ever fails to resolve to the right VNB, pin it via `aliases` (MSB name → exact VNB name)
and re-run `npm run check`.

### 2. The smart-meter quota (`dso.json` / `sm.json`)

`data/dso.json` and `data/sm.json` are a snapshot of the public Bundesnetzagentur smart-meter
rollout figures (operator name, city, voltage levels, quota, meter count), sourced from
vnb-monitoring.org. To pull the latest figures (e.g. a new quarter):

```bash
npm run update-data    # re-fetches + decodes the snapshot into data/dso.json, data/sm.json
git add data/dso.json data/sm.json && git commit -m "refresh smart-meter data (QX 20XX)" && git push
```

`scripts/update-data.cjs` fetches the source endpoints, decodes them, and writes the plain JSON
the app reads. It prints the period it pulled (e.g. `period Q4 2025`); the sidebar shows this label
automatically. If nothing changed, `git status` will show no diff — the source hasn't been updated
yet. After refreshing, re-run `npm run check`, since the VNB names it matches against may have
changed.

### 3. The territory shapes (`geo.json`)

`data/geo.json` used to be vnb-monitoring's own territory polygons, whose upstream
origin/licence wasn't documented. It's now built independently from two public sources:

- **[BKG VG250](https://gdz.bkg.bund.de/index.php/default/digitale-geodaten/verwaltungsgebiete.html)**
  (amtliche Verwaltungsgebiete), fetched live from the BKG WFS — Gemeinde (municipality) polygons
  in WGS84. Licence: [Datenlizenz Deutschland – Namensnennung – Version 2.0](https://www.govdata.de/dl-de/by-2-0)
  (`© GeoBasis-DE / BKG`, attribution required, no share-alike).
- **[Marktstammdatenregister](https://www.marktstammdatenregister.de/)** (MaStR), the
  Bundesnetzagentur's public register — used to work out, per Gemeinde, which Netzbetreiber
  (grid operator) is registered for the most connection points there, via the chain
  `Einheit → Lokation → Netzanschlusspunkt → Netzbetreiber`.

The map is therefore a choropleth of ~10,900 Gemeinde tiles rather than 793 hand-shaped
territories. This is a **majority-vote proxy, not an exact franchise boundary** — a Gemeinde
genuinely split between two grid operators is assigned to whichever has more registered units
there (mostly EEG/PV installations, present in nearly every municipality).

To regenerate it:

```bash
npm run build-geo      # downloads ~2 GB from marktstammdatenregister.de via HTTP range
git add data/geo.json  # requests (never the whole multi-GB export) and takes several minutes
git commit -m "rebuild geo.json (MaStR + VG250)" && git push
```

`scripts/build-geo.cjs` matches each MaStR Netzbetreiber name against `data/dso.json` using the
same name-only matcher as the for.Watt list (`lib/match.js`), so a Gemeinde only makes it into
`geo.json` if its majority operator resolves to a known VNB — Gemeinden that don't resolve are
left out rather than guessed at. Re-run this whenever `dso.json` changes meaningfully (new VNB
names) or just to pick up newer MaStR/VG250 data.
