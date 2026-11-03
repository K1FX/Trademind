"""Étape 2-4 — applique la stratégie sur les données en cache et écrit le rapport.

Usage : python backtest/run_backtest.py [--data-dir data]
Sorties : data/results/rapport.md, trades_<scenario>.csv, jours_<scenario>.csv
"""
import argparse
import bisect
import csv
import json
import os
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))
import config  # noqa: E402
from engine import build_coin, run_portfolio, signal_indices, stats  # noqa: E402


def day(ts):
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d")


def hm(ts):
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%m-%d %H:%M")


def load(data_dir: Path, p):
    sol = json.loads((data_dir / "sol_usd_hourly.json").read_text())["ohlcv"]
    sol_t = [int(r[0]) for r in sol]
    sol_c = [float(r[4]) for r in sol]

    def sol_at(ts):
        i = bisect.bisect_right(sol_t, ts - 3600) - 1   # dernière heure CLÔTURÉE
        return sol_c[max(i, 0)]

    sample = json.loads((data_dir / "sample.json").read_text())
    coins, funnel = [], defaultdict(int)
    funnel["échantillon"] = len(sample["tokens"])
    for tk in sample["tokens"]:
        f = data_dir / "candles" / f"{tk['token']}.json"
        if not f.exists():
            funnel["sans pool PumpSwap / sans bougies"] += 1
            continue
        js = json.loads(f.read_text())
        coin = build_coin(tk["token"], tk["graduated_ts"], js["ohlcv"], sol_at, p)
        if coin is None:
            funnel["sans pool PumpSwap / sans bougies"] += 1
            continue
        if coin.first_candle_delay_s > 15 * 60:
            funnel["1re bougie > 15 min après migration (données douteuses)"] += 1
        coins.append(coin)
    funnel["coins avec bougies"] = len(coins)
    return coins, funnel, sample.get("note", "")


def filter_funnel(coins, p):
    """Combien de coins passent chaque filtre à au moins une minute de la fenêtre."""
    n = defaultdict(int)
    for c in coins:
        lo, hi = c.mig_ts + p.wait_min * 60, c.mig_ts + p.window_min * 60
        idx = [i for i, t in enumerate(c.t) if lo <= t + 60 <= hi]
        if not idx:
            continue
        n["avec données dans la fenêtre 10-60 min"] += 1
        if any(c.liq[i] >= p.min_liquidity_usd for i in idx):
            n["liquidité >= 40k$ au moins 1 fois"] += 1
        if signal_indices(c, p):
            n["les 3 filtres OK (signal)"] += 1
    return n


def slug(s):
    return re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_")


def write_csv(path, rows, header):
    with open(path, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(header)
        w.writerows(rows)


def daily(trades, p):
    by = defaultdict(list)
    for t in trades:
        by[day(t.exit_time)].append(t)
    cap, rows = p.start_capital, []
    for d in sorted(by):
        pnl = sum(t.pnl for t in by[d])
        cap += pnl
        rows.append((d, len(by[d]), sum(1 for t in by[d] if t.pnl > 0), round(pnl, 2), round(cap, 2)))
    return rows


def eur(x):
    return f"{x:+.2f} €"


def pct(x):
    return f"{x * 100:+.1f} %"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default=str(config.DATA))
    a = ap.parse_args()
    data_dir = Path(a.data_dir)
    out = data_dir / "results"
    out.mkdir(parents=True, exist_ok=True)

    base = config.BASE
    coins, funnel, note = load(data_dir, base)
    funnel.update(filter_funnel(coins, base))
    first = min(c.mig_ts for c in coins) if coins else 0
    last = max(c.mig_ts for c in coins) if coins else 0

    md = ["# Backtest stratégie memecoin pump.fun → PumpSwap", ""]
    md.append(f"Période des migrations : {day(first)} → {day(last)} (UTC). Sélection : {note}.")
    md.append("")
    md.append("## Entonnoir des données")
    md += [f"- {k} : {v}" for k, v in funnel.items()]
    md.append("")

    summary = []
    for name, p in config.SCENARIOS.items():
        res = run_portfolio(coins, p)
        st = stats(res, p)
        tr = res["trades"]
        summary.append((name, st))
        write_csv(out / f"trades_{slug(name)}.csv",
                  [(t.token, hm(t.signal_time), hm(t.entry_time), t.entry_raw, hm(t.exit_time),
                    t.exit_raw, t.reason, round(t.ticket, 2), round(t.ret * 100, 2), round(t.pnl, 2))
                   for t in tr],
                  ["token", "signal", "entree", "prix_entree", "sortie", "prix_sortie", "raison",
                   "mise_eur", "rendement_pct", "pnl_eur"])
        drows = daily(tr, p)
        write_csv(out / f"jours_{slug(name)}.csv", drows,
                  ["jour", "trades", "gagnants", "pnl_eur", "capital_fin_jour"])

        md.append(f"## Scénario : {name}")
        md.append("")
        md.append(f"- **Capital final : {st['capital_final']:.2f} €** (départ {p.start_capital:.0f} €, "
                  f"{pct(st['rendement'])})")
        md.append(f"- Trades : {st['trades']} — gagnants : {st['gagnants_pct'] * 100:.1f} %")
        md.append(f"- Gain moyen : {pct(st['gain_moyen_pct'])} ({eur(st['gain_moyen_eur'])}) — "
                  f"perte moyenne : {pct(st['perte_moyenne_pct'])} ({eur(st['perte_moyenne_eur'])})")
        md.append(f"- Plus grosse perte : {eur(st['pire_trade_eur'])} ({pct(st['pire_trade_pct'])})")
        md.append(f"- Pire drawdown (capital réalisé) : {st['max_drawdown_pct'] * 100:.1f} %")
        md.append(f"- Sorties : {st['raisons_sortie']}")
        md.append(f"- Coins avec signal : {st['coins_avec_signal']} — ratés car 3 positions déjà "
                  f"ouvertes : {st['rates_max_positions']} — ratés faute de cash : {st['rates_manque_cash']}")
        md.append("")
        if name == next(iter(config.SCENARIOS)):
            md.append("### Jour par jour")
            md.append("| Jour | Trades | Gagnants | P&L | Capital fin de jour |")
            md.append("|---|---|---|---|---|")
            md += [f"| {d} | {n} | {w} | {eur(pl)} | {c:.2f} € |" for d, n, w, pl, c in drows]
            md.append("")
            srt = sorted(tr, key=lambda t: t.pnl)
            for title, sel in (("10 meilleurs trades", srt[::-1][:10]), ("10 pires trades", srt[:10])):
                md.append(f"### {title}")
                md.append("| Token | Entrée (UTC) | Sortie (UTC) | Raison | Rendement | P&L |")
                md.append("|---|---|---|---|---|---|")
                md += [f"| `{t.token[:8]}…` | {hm(t.entry_time)} | {hm(t.exit_time)} | {t.reason} | "
                       f"{pct(t.ret)} | {eur(t.pnl)} |" for t in sel]
                md.append("")

    md.append("## Comparatif")
    md.append("| Scénario | Capital final | Trades | % gagnants | Drawdown max |")
    md.append("|---|---|---|---|---|")
    md += [f"| {n} | {s['capital_final']:.2f} € | {s['trades']} | {s['gagnants_pct'] * 100:.1f} % | "
           f"{s['max_drawdown_pct'] * 100:.1f} % |" for n, s in summary]
    md.append("")
    (out / "rapport.md").write_text("\n".join(md))
    (out / "resume.json").write_text(json.dumps({n: s for n, s in summary}, indent=1, default=str))
    print("\n".join(md))


if __name__ == "__main__":
    main()
