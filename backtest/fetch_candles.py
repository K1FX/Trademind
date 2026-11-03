"""Étape 1b — bougies 1 minute GeckoTerminal pour chaque coin gradué (avec cache disque).

Usage : python backtest/fetch_candles.py [--sample 1000] [--seed 42] [--rpm 25]
Entrée : data/graduated.json
Sorties : data/sample.json, data/pools.json, data/candles/<token>.json,
          data/sol_usd_hourly.json
Relançable : tout ce qui est déjà sur disque n'est pas retéléchargé.
"""
import argparse
import json
import os
import random
import sys
import time

import requests

sys.path.insert(0, os.path.dirname(__file__))
from config import CANDLES, DATA  # noqa: E402

GT = "https://api.geckoterminal.com/api/v2"
HDR = {"Accept": "application/json;version=20230302"}
WSOL = "So11111111111111111111111111111111111111112"
# Données à récupérer après la migration : 60 min de fenêtre + 3h + marge
# (1000 bougies max par appel ≈ 16,6 h).
HORIZON_S = 1000 * 60


class Client:
    def __init__(self, rpm):
        self.min_gap = 60.0 / rpm
        self.last = 0.0
        self.calls = 0

    def get(self, path, params=None):
        for attempt in range(8):
            wait = self.min_gap - (time.time() - self.last)
            if wait > 0:
                time.sleep(wait)
            self.last = time.time()
            self.calls += 1
            try:
                r = requests.get(GT + path, params=params, headers=HDR, timeout=30)
            except requests.RequestException as e:
                print(f"  réseau: {e}; retry")
                time.sleep(5 * (attempt + 1))
                continue
            if r.status_code == 429:
                print("  429 (limite GeckoTerminal) -> pause 60 s")
                time.sleep(60)
                continue
            if r.status_code == 404:
                return None
            if r.status_code >= 500:
                time.sleep(5 * (attempt + 1))
                continue
            r.raise_for_status()
            return r.json()
        raise RuntimeError(f"GeckoTerminal: échec répété sur {path}")


def chunks(xs, n):
    for i in range(0, len(xs), n):
        yield xs[i:i + n]


def pick_sample(n, seed):
    path = DATA / "sample.json"
    if path.exists():
        s = json.loads(path.read_text())
        print(f"Échantillon en cache : {len(s['tokens'])} coins")
        return s["tokens"]
    g = json.loads((DATA / "graduated.json").read_text())
    toks = g["tokens"]
    # Il faut au moins ~4h de données après la migration pour juger un trade.
    cutoff = int(time.time()) - 4 * 3600
    toks = [t for t in toks if t["graduated_ts"] <= cutoff]
    total = len(toks)
    if n and total > n:
        toks = random.Random(seed).sample(toks, n)
        note = f"échantillon aléatoire de {n} sur {total} (seed={seed})"
    else:
        note = f"tous les {total} coins"
    toks.sort(key=lambda t: t["graduated_ts"])
    path.write_text(json.dumps({"note": note, "population": total, "tokens": toks}, indent=1))
    print(note)
    return toks


def find_pools(cli, toks):
    path = DATA / "pools.json"
    pools = json.loads(path.read_text()) if path.exists() else {}
    todo = [t["token"] for t in toks if t["token"] not in pools]
    print(f"Pools : {len(pools)} en cache, {len(todo)} à chercher")
    for ch in chunks(todo, 30):
        js = cli.get(f"/networks/solana/tokens/multi/{','.join(ch)}", {"include": "top_pools"})
        cand = {}
        for d in (js or {}).get("data", []):
            addr = d["attributes"]["address"]
            ids = [p["id"].split("_", 1)[1] for p in
                   d.get("relationships", {}).get("top_pools", {}).get("data", [])]
            cand[addr] = ids
        allp = sorted({p for ids in cand.values() for p in ids})
        info = {}
        for pch in chunks(allp, 30):
            pj = cli.get(f"/networks/solana/pools/multi/{','.join(pch)}", {"include": "dex"})
            for d in (pj or {}).get("data", []):
                at, rel = d["attributes"], d.get("relationships", {})
                info[at["address"]] = {
                    "dex": rel.get("dex", {}).get("data", {}).get("id"),
                    "base": rel.get("base_token", {}).get("data", {}).get("id", "").split("_", 1)[-1],
                    "created": at.get("pool_created_at"),
                    "reserve_usd_now": at.get("reserve_in_usd"),
                }
        for tok in ch:
            best = None
            for p in cand.get(tok, []):
                i = info.get(p, {})
                if i.get("dex") and "pump" in i["dex"] and "fun" not in i["dex"]:
                    best = {"pool": p, **i}
                    break
            pools[tok] = best  # None = pas de pool PumpSwap trouvé
        path.write_text(json.dumps(pools, indent=1))
        print(f"  pools: {sum(1 for v in pools.values() if v)} PumpSwap / {len(pools)}")
    return pools


def fetch_candles(cli, toks, pools):
    CANDLES.mkdir(parents=True, exist_ok=True)
    todo = [t for t in toks if pools.get(t["token"]) and not (CANDLES / f"{t['token']}.json").exists()]
    print(f"Bougies : {len(todo)} coins à télécharger (~{len(todo) * cli.min_gap / 60:.0f} min)")
    for n, t in enumerate(todo, 1):
        p = pools[t["token"]]["pool"]
        js = cli.get(f"/networks/solana/pools/{p}/ohlcv/minute", {
            "aggregate": 1, "limit": 1000, "currency": "usd", "token": t["token"],
            "before_timestamp": t["graduated_ts"] + HORIZON_S,
        })
        ohlcv = (js or {}).get("data", {}).get("attributes", {}).get("ohlcv_list", [])
        ohlcv = sorted(ohlcv, key=lambda r: r[0])
        (CANDLES / f"{t['token']}.json").write_text(json.dumps({
            "token": t["token"], "pool": p, "graduated_ts": t["graduated_ts"], "ohlcv": ohlcv}))
        if n % 25 == 0:
            print(f"  {n}/{len(todo)}")


def fetch_sol(cli, toks):
    path = DATA / "sol_usd_hourly.json"
    if path.exists():
        return
    js = cli.get(f"/networks/solana/tokens/{WSOL}/pools", {"page": 1})
    pool = None
    for d in js["data"]:
        name = d["attributes"]["name"].upper()
        if "USDC" in name and "SOL" in name:
            pool = d["attributes"]["address"]
            break
    end = max(t["graduated_ts"] for t in toks) + HORIZON_S
    rows = []
    before = end
    start = min(t["graduated_ts"] for t in toks) - 3600
    while before > start:
        oj = cli.get(f"/networks/solana/pools/{pool}/ohlcv/hour", {
            "aggregate": 1, "limit": 1000, "currency": "usd", "token": WSOL,
            "before_timestamp": before})
        lst = oj["data"]["attributes"]["ohlcv_list"]
        if not lst:
            break
        rows += lst
        before = min(r[0] for r in lst)
    rows = sorted({r[0]: r for r in rows}.values())
    path.write_text(json.dumps({"pool": pool, "ohlcv": rows}))
    print(f"SOL/USD horaire : {len(rows)} bougies")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", type=int, default=1000, help="0 = tous les coins")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--rpm", type=float, default=25, help="requêtes/min (limite gratuite : 30)")
    a = ap.parse_args()
    cli = Client(a.rpm)
    toks = pick_sample(a.sample, a.seed)
    fetch_sol(cli, toks)
    pools = find_pools(cli, toks)
    fetch_candles(cli, toks, pools)
    print(f"Terminé ({cli.calls} requêtes cette session).")


if __name__ == "__main__":
    main()
