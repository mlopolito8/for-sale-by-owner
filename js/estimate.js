/*
 * estimate.js — price estimate from Zillow ZHVI data (see scripts/build_zhvi.py).
 *
 * Method A: price paid × ZHVI(latest) ÷ ZHVI(purchase month), using the series
 *           that matches the property type.
 * Method B: typical value for this bedroom count in this ZIP (latest month).
 * Blend:    70% A + 30% B when both exist; otherwise whichever exists.
 * Range:    blend ± max(5%, half the A–B gap), capped at ±15%.
 *
 * estimate() is a pure function so it can be tested in Node.
 */
(function (root) {
  const WEIGHT_A = 0.7;
  const MIN_HALF_WIDTH = 0.05;
  const MAX_HALF_WIDTH = 0.15;
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  // Series to try for Method A, in order, by property type.
  const TYPE_SERIES = {
    "single-family": ["sfr", "all"],
    "condo": ["condo", "all"],
    "townhome": ["all", "sfr"],
    "multi-family": ["all", "sfr"],
  };
  const SERIES_LABEL = {
    sfr: "single-family homes", condo: "condos", all: "all homes",
  };

  /** "2000-01" + index -> "Aug 2026" */
  function monthLabel(start, i) {
    const [y, m] = start.split("-").map(Number);
    const t = (y * 12 + (m - 1)) + i;
    return `${MONTHS[t % 12]} ${Math.floor(t / 12)}`;
  }

  /** Index of (year, month) relative to start "YYYY-MM". */
  function monthIndex(start, year, month) {
    const [y, m] = start.split("-").map(Number);
    return (year * 12 + (month - 1)) - (y * 12 + (m - 1));
  }

  function lastIndex(arr) {
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return i;
    return -1;
  }

  const round1k = (n) => Math.round(n / 1000) * 1000;

  /**
   * @param rec   property record (js/property.js)
   * @param zd    ZIP record from data/zhvi/zip3/<NNN>.json, or null if not covered
   * @returns     { ok, estimate, low, high, methodA, methodB, position, notes[], ... }
   */
  function estimate(rec, zd) {
    const out = { ok: false, methodA: null, methodB: null, notes: [] };
    if (!zd) {
      out.notes.push(`We don't have Zillow data for ZIP ${rec.zip} yet.`);
      return out;
    }
    const S = zd.series;

    // ---- Method A: appreciation-adjusted purchase price ----
    const order = TYPE_SERIES[rec.propertyType] || ["all", "sfr"];
    let p = monthIndex(zd.start, rec.purchaseYear, rec.purchaseMonth);
    for (const key of order) {
      const s = S[key];
      if (!s) continue;
      const L = lastIndex(s);
      if (L < 0) continue;
      const pi = Math.min(p, L); // bought after the latest data month: no change yet
      if (pi < 0 || s[pi] == null) continue;
      const factor = s[L] / s[pi];
      out.methodA = {
        value: round1k(rec.pricePaid * factor),
        factor,
        series: key,
        seriesLabel: SERIES_LABEL[key],
        fromMonth: monthLabel(zd.start, pi),
        toMonth: monthLabel(zd.start, L),
        fromIndex: s[pi],
        toIndex: s[L],
      };
      if (key !== order[0]) {
        out.notes.push(`Zillow's ${SERIES_LABEL[order[0]] || order[0]} index for this ZIP doesn't cover your purchase date, so Method A uses the index for ${SERIES_LABEL[key]}.`);
      }
      if (p > L) out.notes.push(`You bought after Zillow's latest data month (${out.methodA.toMonth}), so Method A is just what you paid.`);
      break;
    }
    if (!out.methodA) {
      out.notes.push("Zillow's history for this ZIP doesn't go back to your purchase date, so we can't adjust what you paid.");
    }

    // ---- Method B: bedroom-matched typical value ----
    const bd = Math.min(Math.max(Math.round(rec.bedrooms), 1), 5);
    const bs = S["bd" + bd];
    if (bs && lastIndex(bs) >= 0) {
      const L = lastIndex(bs);
      out.methodB = {
        value: round1k(bs[L]),
        bedrooms: bd,
        bedroomsLabel: bd === 5 ? "5+" : String(bd),
        month: monthLabel(zd.start, L),
      };
      if (rec.bedrooms === 0) out.notes.push("Studios are compared with 1-bedroom homes.");
    } else {
      out.notes.push(`Zillow doesn't publish a ${bd}-bedroom value for this ZIP.`);
    }

    // ---- Blend + range ----
    const A = out.methodA && out.methodA.value;
    const B = out.methodB && out.methodB.value;
    if (A == null && B == null) {
      out.notes.push("Not enough data for an estimate in this ZIP.");
      return out;
    }
    let est, wA;
    if (A != null && B != null) { wA = WEIGHT_A; est = WEIGHT_A * A + (1 - WEIGHT_A) * B; }
    else if (A != null) { wA = 1; est = A; }
    else { wA = 0; est = B; }

    let half = MIN_HALF_WIDTH;
    if (A != null && B != null) half = Math.max(half, Math.abs(A - B) / 2 / est);
    half = Math.min(half, MAX_HALF_WIDTH);

    out.ok = true;
    out.weightA = wA;
    out.estimate = round1k(est);
    out.low = round1k(est * (1 - half));
    out.high = round1k(est * (1 + half));

    // ---- Where it sits in the local market (city-level tiers) ----
    const lo = S.cityBottom && S.cityBottom[lastIndex(S.cityBottom)];
    const hi = S.cityTop && S.cityTop[lastIndex(S.cityTop)];
    const mid = S.all && S.all[lastIndex(S.all)];
    if (lo && hi) {
      let band;
      if (out.estimate < lo) band = "below the typical lower-priced home";
      else if (out.estimate > hi) band = "above the typical higher-priced home";
      else if (mid && out.estimate < mid) band = "between the typical lower-priced and mid-priced home";
      else band = "between the typical mid-priced and higher-priced home";
      out.position = { city: zd.city, lowerTier: round1k(lo), middle: mid ? round1k(mid) : null, upperTier: round1k(hi), band };
    }

    out.context = zd.metroContext || null;
    return out;
  }

  /** Browser: fetch the ZIP record. Resolves to null if the ZIP isn't covered. */
  async function loadZip(zip, base = "data/zhvi") {
    const idxRes = await fetch(`${base}/index.json`);
    if (!idxRes.ok) throw new Error("Couldn't load Zillow index");
    const index = await idxRes.json();
    if (!index.zips[zip]) return { index, zd: null };
    const shardRes = await fetch(`${base}/zip3/${zip.slice(0, 3)}.json`);
    if (!shardRes.ok) throw new Error("Couldn't load Zillow data for " + zip);
    const shard = await shardRes.json();
    return { index, zd: shard[zip] || null };
  }

  const api = { estimate, loadZip, monthLabel, monthIndex };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Estimator = api;
})(typeof window !== "undefined" ? window : globalThis);
