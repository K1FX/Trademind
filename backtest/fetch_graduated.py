"""Étape 1a — liste des coins pump.fun gradués (migration PumpSwap) via Moralis.

Usage :  MORALIS_API_KEY=xxx python backtest/fetch_graduated.py [--days 14] [--refresh]
Sortie : data/graduated.json  (+ pages brutes dans data/raw/moralis/)
"""
import argparse
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone

import requests

sys.path.insert(0, os.path.dirname(__file__))
from config import DATA, RAW  # noqa: E402

URL = "https://solana-gateway.moralis.io/token/mainnet/exchange/pumpfun/graduated"


def parse_ts(s: str) -> int:
    s = s.replace("Z", "+00:00")
    return int(datetime.fromisoformat(s).timestamp())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=14)
    ap.add_argument("--refresh", action="store_true")
    a = ap.parse_args()

    out_path = DATA / "graduated.json"
    if out_path.exists() and not a.refresh:
        print(f"Déjà en cache : {out_path} (--refresh pour retélécharger)")
        return
    key = os.environ.get("MORALIS_API_KEY")
    if not key:
        sys.exit("MORALIS_API_KEY manquante (clé gratuite sur https://admin.moralis.com)")

    now = datetime.now(timezone.utc)
    since = int((now - timedelta(days=a.days)).timestamp())
    raw_dir = RAW / "moralis"
    raw_dir.mkdir(parents=True, exist_ok=True)

    tokens, cursor, page = {}, None, 0
    while True:
        params = {"limit": 100}
        if cursor:
            params["cursor"] = cursor
        for attempt in range(6):
            r = requests.get(URL, params=params, headers={"X-API-Key": key}, timeout=30)
            if r.status_code == 429 or r.status_code >= 500:
                time.sleep(2 ** attempt)
                continue
            r.raise_for_status()
            break
        else:
            sys.exit(f"Moralis : échec répété ({r.status_code})")
        js = r.json()
        (raw_dir / f"page_{page:04d}.json").write_text(json.dumps(js))
        oldest = None
        for it in js.get("result", []):
            ts = parse_ts(it["graduatedAt"])
            oldest = ts if oldest is None else min(oldest, ts)
            if ts >= since:
                tokens[it["tokenAddress"]] = {
                    "token": it["tokenAddress"],
                    "symbol": it.get("symbol"),
                    "name": it.get("name"),
                    "graduated_at": it["graduatedAt"],
                    "graduated_ts": ts,
                }
        page += 1
        cursor = js.get("cursor")
        print(f"page {page}: {len(tokens)} coins (plus ancien vu : "
              f"{datetime.fromtimestamp(oldest, timezone.utc) if oldest else '-'})")
        if not cursor or oldest is None or oldest < since:
            break
        time.sleep(0.3)

    rows = sorted(tokens.values(), key=lambda x: x["graduated_ts"])
    meta = {"source": "Moralis /token/mainnet/exchange/pumpfun/graduated",
            "fetched_at": now.isoformat(), "days": a.days, "count": len(rows)}
    out_path.write_text(json.dumps({"meta": meta, "tokens": rows}, indent=1))
    print(f"{len(rows)} coins gradués sur {a.days} jours -> {out_path}")


if __name__ == "__main__":
    main()
