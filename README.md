# VNB-Karte + for.watt coverage overlay

A map of German distribution grid operators (Verteilnetzbetreiber) coloured by their
smart-meter rollout quota, with an overlay for the **Messstellenbetreiber supported by for.watt**.

**Live:** https://elboiler.github.io/for-watt-vnb-monitoring/

Built on the great work at [vnb-monitoring.org](https://vnb-monitoring.org/), enhanced by
[Thomas Boyle](https://www.linkedin.com/in/tom-boyle-92345a17/).

## What it does

- **Map** – Leaflet choropleth of all 793 VNB territories on a light CARTO basemap.
  Modes: *Smart-Meter-Quote* (Q4 2025, with/without optional install cases) and *Anzahl Zähler*.
  Filters (quote %, meter count), a ranking list, and hover tooltips.
- **for.watt overlay** – toggle in the sidebar. Territories whose operator is a for.watt-supported
  Messstellenbetreiber keep their choropleth colour and get a for.watt-orange outline; the rest grey out.
  Each on-map operator shows its Smart-Meter-Quote, smart-meter count and total meters.
- **Germany-wide estimate** – share of metering points / smart meters that sit in a for.watt
  grid territory (lower bound; überregionale MSB have no single area and are listed separately).

## The Messstellenbetreiber list (source of truth)

`data/messstellenbetreiber.json` is a **manually maintained** list. To update coverage, edit
`operators` (add/remove names) and commit — the page resolves it to VNB territories on every load.

```json
{
  "operators": ["Stromnetz Berlin GmbH", "WEMAG Netz GmbH", "..."],
  "aliases": { "Tricky MSB name": "Exact VNB name in the dataset" }
}
```

Matching is by **operator name only** (never city — that is what previously mis-mapped
"Stadtwerke Erfurt" to TEN). Every match must share a distinctive name token with its VNB;
operators that are national/independent MSBs (e.g. metrify, Solandeo, wattline, 50Hertz) have no
single territory and appear under *Weitere for.watt-Partner*. Use `aliases` to force a specific
VNB if a name ever fails to resolve.

Verify the list after editing:

```bash
npm run check          # prints every mapping; fails if any match isn't name-anchored
```

## Local preview

```bash
node server.js         # http://localhost:5173  (zero deps)
```

## Data

`data/geo.json`, `dso.json`, `sm.json` are a decoded snapshot of the public Bundesnetzagentur
smart-meter rollout dataset (operator name, city, voltage levels, quota, meter count).
