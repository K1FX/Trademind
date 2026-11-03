"""Tests de la mécanique du moteur sur des bougies synthétiques (PAS des résultats de marché).

Usage : python backtest/test_engine.py
"""
import os
import sys
from dataclasses import replace

sys.path.insert(0, os.path.dirname(__file__))
from config import BASE  # noqa: E402
from engine import build_coin, run_portfolio, signal_indices, simulate_trade  # noqa: E402

MIG = 1_700_000_000 - (1_700_000_000 % 60)
SOL = lambda ts: 150.0  # noqa: E731
P0 = 2.0e-4  # 85 SOL * 206.9M tokens, SOL=150$ -> liquidité = 2*sqrt(k*p*150) ≈ 46 k$


def mk(path, vol=1000.0, start=MIG):
    """path = liste de (o, h, l, c) ; une bougie par minute à partir de la migration."""
    rows = [[start + 60 * i, o, h, l, c, vol] for i, (o, h, l, c) in enumerate(path)]
    return build_coin("TEST", MIG, rows, SOL, BASE)


def flat(n, px=P0):
    return [(px, px, px, px)] * n


def check(name, cond):
    print(("OK   " if cond else "FAIL ") + name)
    if not cond:
        check.failed = True


check.failed = False


def test_liquidity_model():
    c = mk(flat(5))
    check("modèle de liquidité ~46k$ à p0", 44_000 < c.liq[0] < 48_000)


def test_window_and_filters():
    c = mk(flat(120), vol=5000.0)
    s = signal_indices(c, BASE)
    # 1re décision possible : clôture à mig+10 min = bougie 9
    check("aucun signal avant +10 min", s and s[0] == 9)
    check("aucun signal après +60 min", s[-1] == 59)
    low_vol = mk(flat(120), vol=100.0)
    check("volume 1h insuffisant -> pas de signal", not signal_indices(low_vol, BASE))
    pump = [(P0, P0, P0, P0)] + [(P0 * 2, P0 * 2, P0 * 2, P0 * 2)] * 119
    check("hausse 1h > 80% -> pas de signal", not signal_indices(mk(pump), BASE))


def test_no_lookahead():
    a = flat(30) + [(P0, P0, P0, P0 * 0.2)] + flat(90, P0 * 0.2)
    b = flat(30) + flat(91)
    sa, sb = signal_indices(mk(a), BASE), signal_indices(mk(b), BASE)
    check("signaux avant le krach identiques (pas de look-ahead)",
          [i for i in sa if i < 30] == [i for i in sb if i < 30])


def test_entry_delay_and_stop():
    path = flat(10) + [(P0, P0, P0, P0 * 1.01)] + [(P0 * 1.01, P0 * 1.01, P0 * 0.9, P0 * 0.9)] + flat(5)
    c = mk(path)
    tr = simulate_trade(c, 9, BASE)
    check("entrée au close de la bougie suivante (retard 1 min)", abs(tr.entry_raw - P0 * 1.01) < 1e-12)
    check("prix d'entrée + 3% slippage", abs(tr.entry_fill - P0 * 1.01 * 1.03) < 1e-12)
    stop = tr.entry_fill * 0.94
    check("stop touché en cours de bougie -> au niveau du stop", abs(tr.exit_raw - stop) < 1e-12)
    exp = 0.98 * (stop * 0.97 / tr.entry_fill) * 0.98
    check("frais 2%+2% et slippage 3% en sortie", abs(tr.mult - exp) < 1e-9)
    tr2 = simulate_trade(c, 9, replace(BASE, stop_fill="always_low"))
    check("variante pessimiste -> au plus bas", abs(tr2.exit_raw - P0 * 0.9) < 1e-12)


def test_gap_through_stop():
    path = flat(11) + [(P0 * 0.85, P0 * 0.86, P0 * 0.80, P0 * 0.82)] + flat(5)
    tr = simulate_trade(mk(path), 9, BASE)
    check("bougie qui saute le stop -> plus bas de la bougie", abs(tr.exit_raw - P0 * 0.80) < 1e-12)


def test_trailing():
    up = [(P0 * x, P0 * x * 1.01, P0 * x * 0.995, P0 * x) for x in (1.1, 1.2, 1.3, 1.4, 1.5)]
    path = flat(11) + up + [(P0 * 1.45, P0 * 1.45, P0 * 1.2, P0 * 1.25)] + flat(5)
    tr = simulate_trade(mk(path), 9, BASE)
    peak = P0 * 1.5 * 1.01
    check("stop suiveur 12% sous le plus haut", tr.reason == "stop suiveur"
          and abs(tr.exit_raw - peak * 0.88) < 1e-12)


def test_time_exit():
    path = flat(11) + flat(300, P0 * 1.02)
    tr = simulate_trade(mk(path), 9, BASE)
    check("sortie 3h si < +5%", tr.reason.startswith("temps") and
          abs((tr.exit_time - tr.entry_time) - 180 * 60) < 61)


def test_rug():
    path = flat(11) + [(P0, P0, P0 * 0.05, P0 * 0.05)] + flat(5, P0 * 0.05)
    tr = simulate_trade(mk(path), 9, BASE)
    check("liquidité disparue -> -100%", tr.mult == 0.0 and tr.reason.startswith("rug"))


def test_portfolio_limits():
    coins = [mk(flat(11) + flat(300, P0 * 1.02)) for _ in range(5)]
    for i, c in enumerate(coins):
        c.token = f"T{i}"
    res = run_portfolio(coins, BASE)
    check("max 3 positions simultanées (200€ / 47.5€ -> 3 tickets max de toute façon)",
          len(res["trades"]) == 3)
    check("ticket = 47.50€ au départ", all(abs(t.ticket - 47.5) < 1e-9 for t in res["trades"]))


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
    sys.exit(1 if check.failed else 0)
