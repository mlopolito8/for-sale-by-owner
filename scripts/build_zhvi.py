#!/usr/bin/env python3
"""
build_zhvi.py: slim Zillow Research CSVs into small per-ZIP JSON files for the browser.

Run locally (not on Vercel), then commit the output in data/zhvi/.

    python3 scripts/build_zhvi.py --raw ~/Downloads/zillow --states MA --zips 06830

Input: any Zillow CSVs in --raw (file names may have prefixes; matched by pattern).
Output:
    data/zhvi/index.json        list of ZIPs + which series each has + data freshness
    data/zhvi/zip3/<NNN>.json   all ZIPs sharing a 3-digit prefix, e.g. 021.json holds 02140
                                (sharded so there are ~20 files, not ~500: GitHub's web upload
                                takes at most 100 files at a time)

Shard shape: { "02140": <ZIP record>, ... }, where a ZIP record is:
    {
      "zip": "02140", "city": "Cambridge", "county": "Middlesex County",
      "metro": "Boston-Cambridge-Newton, MA-NH", "state": "MA",
      "start": "2000-01",                       # month of values[0]
      "series": { "sfr": [int|null, ...], "condo": [...], "bd3": [...], ... },
      "metroContext": { "month": "2026-07", "pctSoldAboveList": 0.41, ... }
    }

Series keys: all (all homes, SFR + condo), sfr, condo, bd1..bd5, bottom, top (ZIP-level tiers),
cityBottom, cityTop (city-level tiers, matched to the ZIP by city + state + county; used for the
estimate range when ZIP-level tiers aren't available).
Only series present in --raw are included. Values are rounded to whole dollars.
"""
import argparse
import csv
import json
import re
import sys
from pathlib import Path

# (series key, filename regex). First match wins, so specific patterns go first.
ZIP_SERIES = [
    ("bd1", r"Zip_zhvi_bdrmcnt_1_"),
    ("bd2", r"Zip_zhvi_bdrmcnt_2_"),
    ("bd3", r"Zip_zhvi_bdrmcnt_3_"),
    ("bd4", r"Zip_zhvi_bdrmcnt_4_"),
    ("bd5", r"Zip_zhvi_bdrmcnt_5_"),
    ("bottom", r"Zip_zhvi_uc_sfrcondo_tier_0\.0_0\.33_"),
    ("top", r"Zip_zhvi_uc_sfrcondo_tier_0\.67_1\.0_"),
    ("all", r"Zip_zhvi_uc_sfrcondo_tier_0\.33_0\.67_"),
    ("sfr", r"Zip_zhvi_uc_sfr_tier_0\.33_0\.67_"),
    ("condo", r"Zip_zhvi_uc_condo_tier_0\.33_0\.67_"),
]
# City-level tier series, attached to each ZIP whose (City, State, County) matches.
CITY_SERIES = [
    ("cityBottom", r"City_zhvi_uc_sfrcondo_tier_0\.0_0\.33_"),
    ("cityTop", r"City_zhvi_uc_sfrcondo_tier_0\.67_1\.0_"),
]
METRO_SERIES = [
    ("pctSoldAboveList", r"Metro_pct_sold_above_list_"),
    ("pctSoldBelowList", r"Metro_pct_sold_below_list_"),
    ("medianListPrice", r"Metro_mlp_"),
]
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def find(raw: Path, pattern: str):
    hits = sorted(p for p in raw.glob("*.csv") if re.search(pattern, p.name))
    return hits[0] if hits else None


def month(col: str) -> str:
    return col[:7]  # "2026-08-31" -> "2026-08"


def metro_short(cbsa: str) -> str:
    """'Boston-Cambridge-Newton, MA-NH' -> 'Boston, MA' (the naming the metro files use)."""
    if not cbsa or "," not in cbsa:
        return ""
    cities, states = cbsa.rsplit(",", 1)
    return f"{cities.split('-')[0].strip()}, {states.strip().split('-')[0]}"


def to_num(s: str):
    try:
        return float(s) if s.strip() else None
    except ValueError:
        return None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--raw", required=True, type=Path, help="folder holding the Zillow CSVs")
    ap.add_argument("--out", default=Path("data/zhvi"), type=Path)
    ap.add_argument("--states", default="MA", help="comma-separated state codes to keep (default MA)")
    ap.add_argument("--zips", default="", help="extra comma-separated ZIPs to keep from any state")
    args = ap.parse_args()

    states = {s.strip().upper() for s in args.states.split(",") if s.strip()}
    extra = {z.strip().zfill(5) for z in args.zips.split(",") if z.strip()}

    zips = {}  # zip -> record
    start, latest = None, None

    for key, pat in ZIP_SERIES:
        path = find(args.raw, pat)
        if not path:
            print(f"  [skip] {key}: no file matching {pat}")
            continue
        n = 0
        with path.open(newline="") as fh:
            reader = csv.reader(fh)
            header = next(reader)
            idx = {c: i for i, c in enumerate(header)}
            date_cols = [i for i, c in enumerate(header) if DATE_RE.match(c)]
            s0, s1 = month(header[date_cols[0]]), month(header[date_cols[-1]])
            if start is None:
                start, latest = s0, s1
            elif s0 != start:
                sys.exit(f"{path.name} starts {s0}, expected {start}. Align series before mixing.")
            latest = max(latest, s1)
            for row in reader:
                z = row[idx["RegionName"]].zfill(5)
                if row[idx["State"]] not in states and z not in extra:
                    continue
                rec = zips.setdefault(z, {
                    "zip": z,
                    "city": row[idx["City"]],
                    "county": row[idx["CountyName"]],
                    "metro": row[idx["Metro"]],
                    "state": row[idx["State"]],
                    "start": start,
                    "series": {},
                })
                vals = [to_num(row[i]) for i in date_cols]
                rec["series"][key] = [round(v) if v is not None else None for v in vals]
                n += 1
        print(f"  [ok]   {key}: {n} ZIPs from {path.name}")

    if not zips:
        sys.exit("No ZIPs matched. Check --raw and --states.")

    for key, pat in CITY_SERIES:
        path = find(args.raw, pat)
        if not path:
            print(f"  [skip] {key}: no file matching {pat}")
            continue
        with path.open(newline="") as fh:
            reader = csv.reader(fh)
            header = next(reader)
            idx = {c: i for i, c in enumerate(header)}
            date_cols = [i for i, c in enumerate(header) if DATE_RE.match(c)]
            if month(header[date_cols[0]]) != start:
                sys.exit(f"{path.name} doesn't start at {start}.")
            by_city = {}
            for row in reader:
                k = (row[idx["RegionName"]], row[idx["State"]], row[idx["CountyName"]])
                by_city[k] = [round(v) if (v := to_num(row[i])) is not None else None for i in date_cols]
        n = 0
        for rec in zips.values():
            vals = by_city.get((rec["city"], rec["state"], rec["county"]))
            if vals:
                rec["series"][key] = vals
                n += 1
        print(f"  [ok]   {key}: matched {n} of {len(zips)} ZIPs from {path.name}")

    # Metro context: latest non-empty value of each metro series, keyed by short metro name.
    metro = {}
    for key, pat in METRO_SERIES:
        path = find(args.raw, pat)
        if not path:
            print(f"  [skip] metro {key}")
            continue
        with path.open(newline="") as fh:
            reader = csv.reader(fh)
            header = next(reader)
            date_cols = [i for i, c in enumerate(header) if DATE_RE.match(c)]
            for row in reader:
                for i in reversed(date_cols):
                    v = to_num(row[i])
                    if v is not None:
                        m = metro.setdefault(row[2], {})
                        m[key] = round(v, 4) if v < 10 else round(v)
                        m[key + "Month"] = month(header[i])
                        break
        print(f"  [ok]   metro {key}")

    out_dir = args.out / "zip3"
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("*.json"):
        old.unlink()
    index = {"source": "Zillow Research (zillow.com/research/data)", "start": start, "latest": latest, "zips": {}}
    shards = {}
    for z, rec in sorted(zips.items()):
        ctx = metro.get(metro_short(rec["metro"]))
        if ctx:
            rec["metroContext"] = {"metroName": metro_short(rec["metro"]), **ctx}
        shards.setdefault(z[:3], {})[z] = rec
        index["zips"][z] = sorted(rec["series"])
    for prefix, recs in shards.items():
        (out_dir / f"{prefix}.json").write_text(json.dumps(recs, separators=(",", ":")))
    (args.out / "index.json").write_text(json.dumps(index, separators=(",", ":")))

    sizes = [p.stat().st_size for p in out_dir.glob("*.json")]
    print(f"\nWrote {len(zips)} ZIPs in {len(sizes)} files to {out_dir} "
          f"({sum(sizes) / 1e6:.1f} MB total, largest {max(sizes) / 1e3:.0f} KB). Data {start} -> {latest}.")


if __name__ == "__main__":
    main()
