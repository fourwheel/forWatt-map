# VNB-Karte + for.Watt coverage overlay

A map of German distribution grid operators (Verteilnetzbetreiber) coloured by their
smart-meter rollout quota, with an overlay for the **Messstellenbetreiber supported by for.Watt**.

**Live:** https://elboiler.github.io/for-watt-vnb-monitoring/

Originally built by [Thomas Boyle](https://www.linkedin.com/in/tom-boyle-92345a17/), inspired by
[vnb-monitoring.org](https://vnb-monitoring.org/). All data is now built from public sources —
see [Updating](#updating).

## What it does

- **Map** – Leaflet choropleth of ~10,900 Gemeinde tiles across ~732 VNB on a light CARTO basemap,
  by Smart-Meter-Quote (with/without optional install cases), with hover tooltips.
- **for.Watt overlay** – territories whose operator is a for.Watt-supported Messstellenbetreiber
  keep their choropleth colour and get a for.Watt-orange outline; the rest grey out. The sidebar
  lists every matched partner with its Smart-Meter-Quote.

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

### 2. The Netzbetreiber + smart-meter quota (`dso.json` / `sm.json`)

Both files are built entirely from public sources — no third-party redistribution involved:

- **[Marktstammdatenregister](https://www.marktstammdatenregister.de/)** (MaStR), the
  Bundesnetzagentur's public register — every Netzbetreiber that shows up anywhere in the MaStR
  scan (see below), with its registered name, city, and the voltage levels (Spannungsebenen) its
  connection points appear on. The Netzbetreiber's MaStR-Nummer is used as `id`/`vnb_id`
  throughout the app.
- **Bundesnetzagentur's own Smart-Meter-Rollout quota table** — an `.xlsx` published quarterly
  directly on [bundesnetzagentur.de](https://www.bundesnetzagentur.de/DE/Fachthemen/ElektrizitaetundGas/NetzzugangMesswesen/Mess-undZaehlwesen/iMSys/start.html),
  listing every Messstellenbetreiber's rollout quota with and without optional install cases.
  Matched to the MaStR operator list by name (`lib/match.js`, same matcher as the for.Watt list).

Note: BNetzA does not publish absolute metering-point counts per operator anywhere public (only
the quota %, plus national size-class buckets) — vnb-monitoring's old snapshot had an "Anzahl
Zähler" figure that came from an undocumented source, so that feature (map mode, absolute
counts in tooltips/lists) was removed rather than kept on shaky footing.

To refresh (update the xlsx URL in `scripts/build-dso.cjs` first if BNetzA has published a newer quarter):

```bash
npm run build-dso       # BNetzA quota xlsx + MaStR scan -> data/dso.json, data/sm.json
npm run build-geo       # re-run after build-dso so Gemeinde tiles + bbox match the new ids
npm run check           # VNB names may have shifted — re-verify the for.Watt matches
git add data/dso.json data/sm.json data/geo.json
git commit -m "refresh Netzbetreiber + quota data (QX 20XX)" && git push
```

### 3. The territory shapes (`geo.json`)

`data/geo.json` used to be vnb-monitoring's own territory polygons, whose upstream
origin/licence wasn't documented. It's now built independently from two public sources:

- **BKG VG250** (amtliche Verwaltungsgebiete), fetched live from the
  [BKG WFS](https://gdz.bkg.bund.de/index.php/default/digitale-geodaten/verwaltungsgebiete.html) —
  Gemeinde (municipality) polygons in WGS84. Licence:
  [Datenlizenz Deutschland – Namensnennung – Version 2.0](https://www.govdata.de/dl-de/by-2-0)
  (`© GeoBasis-DE / BKG`, attribution required, no share-alike).
- **Marktstammdatenregister** — used to work out, per Gemeinde, which Netzbetreiber (grid
  operator) has the most registered connection points there, via the chain
  `Einheit → Lokation → Netzanschlusspunkt → Netzbetreiber`. This is the same MaStR scan
  `build-dso.cjs` uses (shared in `scripts/lib/mastr-scan.cjs`, cached locally so running both
  scripts back to back only downloads the export once).

The map is therefore a choropleth of ~10,900 Gemeinde tiles rather than 793 hand-shaped
territories. This is a **majority-vote proxy, not an exact franchise boundary** — a Gemeinde
genuinely split between two grid operators is assigned to whichever has more registered units
there (mostly EEG/PV installations, present in nearly every municipality). A handful of for.Watt
partners with a narrow, non-residential grid (e.g. an industrial park's own Netzbetreiber, or a
transmission operator with no Gemeinde-level footprint) will therefore not appear on the map even
though they're correctly matched in the sidebar list — there's just no Gemeinde where they hold
the majority of registered units.

To regenerate it (run `npm run build-dso` first — see above):

```bash
npm run build-geo       # downloads ~2 GB from marktstammdatenregister.de via HTTP range
git add data/geo.json data/dso.json   # requests (never the whole multi-GB export); several minutes
git commit -m "rebuild geo.json (MaStR + VG250)" && git push
```

`scripts/build-geo.cjs` also patches each `dso.json` entry's `bbox` (used to fly the map to a
Netzbetreiber from the sidebar) once the Gemeinde tiles exist to compute it from.
