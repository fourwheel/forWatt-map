# VNB-Karte + for.watt coverage overlay

A map of German distribution grid operators (Verteilnetzbetreiber) coloured by their
smart-meter rollout quota, with an overlay for the **Messstellenbetreiber supported by for.watt**.

**Live:** https://elboiler.github.io/

## What it does

- **Map** – Leaflet choropleth of all 793 VNB territories on a dark CARTO basemap.
  Modes: *Smart-Meter-Quote* (Q4 2025, with/without optional install cases) and *Anzahl Zähler*.
  Filters (quote %, meter count), a live ranking list, and hover tooltips.
- **for.watt overlay** – toggle in the sidebar. Territories whose operator is a
  for.watt-supported Messstellenbetreiber are outlined in for.watt orange; the rest turn grey.
  The sidebar always lists the supported operators (on-map MSBs + other partners).
- **Auto-refresh** – the page loads `data/forwatt-coverage.json` (cache-busted) on every open,
  so it always shows the latest known coverage.

## How the coverage stays current (static hosting)

GitHub Pages is static, so the scrape runs in CI instead of at request time.
`.github/workflows/update-coverage.yml` runs every 6 hours (and on demand): it renders
forwatt.io with Playwright (the partner grid is Blazor-rendered, invisible to a plain fetch),
matches the logos to VNB territories by name/city, and commits `data/forwatt-coverage.json`.
Each commit redeploys the page.

## Local preview

```bash
node server.js          # http://localhost:5173  (zero deps)
```

Refresh coverage locally:

```bash
npm install             # installs Playwright
npx playwright install chromium
npm run update-coverage
```

## Data

`data/geo.json`, `dso.json`, `sm.json` are a decoded snapshot of the public Bundesnetzagentur
smart-meter rollout dataset (operator name, city, voltage levels, quota, meter count).

## Matching notes

17 of the current for.watt partners map to a VNB territory. Pure energy-service providers
and national/independent metering operators have no single grid area and are listed under
*Weitere for.watt-Partner*.
