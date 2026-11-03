"""Moteur de backtest : signaux (passé uniquement), exécution d'un trade, portefeuille.

Convention de temps : la bougie i couvre [t_i, t_i + 60 s). Sa clôture est connue
à t_i + 60. Une décision prise à la clôture de la bougie i n'utilise QUE les
bougies 0..i. L'entrée se fait `entry_delay_min` bougies plus tard, au prix de
clôture de cette bougie-là. La gestion de la position commence à la bougie suivante.
"""
import bisect
import heapq
import math
from dataclasses import dataclass, field

from config import Params


# ---------------------------------------------------------------- données
@dataclass
class Coin:
    token: str
    mig_ts: int
    t: list            # timestamps début de bougie (grille minute dense)
    o: list
    h: list
    l: list
    c: list
    v: list
    liq: list = field(default_factory=list)   # liquidité estimée (USD) à la clôture
    first_candle_delay_s: int = 0             # retard de la 1re bougie vs migration


def build_coin(token, mig_ts, ohlcv, sol_price_at, p: Params):
    """ohlcv = [[ts, o, h, l, c, vol_usd], ...] trié. Grille dense : les minutes
    sans trade deviennent des bougies plates au dernier prix, volume 0."""
    if not ohlcv:
        return None
    by_ts = {int(r[0]): r for r in ohlcv}
    start, end = int(ohlcv[0][0]), int(ohlcv[-1][0])
    t, o, h, l, c, v = [], [], [], [], [], []
    last = None
    for ts in range(start, end + 60, 60):
        r = by_ts.get(ts)
        if r is not None:
            ro, rh, rl, rc, rv = map(float, r[1:6])
            last = rc
        else:
            ro = rh = rl = rc = last
            rv = 0.0
        t.append(ts); o.append(ro); h.append(rh); l.append(rl); c.append(rc); v.append(rv)
    coin = Coin(token, mig_ts, t, o, h, l, c, v, first_candle_delay_s=start - mig_ts)
    # Liquidité estimée par le modèle à produit constant x*y=k du pool PumpSwap
    # (réserves initiales standard pump.fun). liq_usd = 2*sqrt(k * prix_usd * sol_usd).
    k = p.pool_sol_reserve0 * p.pool_token_reserve0
    coin.liq = [2.0 * math.sqrt(k * max(ci, 0.0) * sol_price_at(ti)) for ti, ci in zip(t, c)]
    return coin


# ---------------------------------------------------------------- signaux
def signal_indices(coin: Coin, p: Params):
    """Indices de bougies dont la clôture est dans la fenêtre [mig+10, mig+60] min
    ET qui passent les 3 filtres. N'utilise que des données <= clôture de la bougie."""
    out = []
    lo = coin.mig_ts + p.wait_min * 60
    hi = coin.mig_ts + p.window_min * 60
    t = coin.t
    for i, ti in enumerate(t):
        close_time = ti + 60
        if close_time < lo:
            continue
        if close_time > hi:
            break
        if coin.liq[i] < p.min_liquidity_usd:
            continue
        # volume de la dernière heure : bougies dont le début est >= close_time-3600
        j0 = bisect.bisect_left(t, close_time - 3600)
        vol = sum(coin.v[j0:i + 1])
        if vol < p.min_volume_1h_usd:
            continue
        # hausse sur 1h : prix d'il y a 60 min si dispo, sinon 1er prix du pool
        ref_i = bisect.bisect_right(t, close_time - 3600 - 60) - 1
        ref = coin.c[ref_i] if ref_i >= 0 else coin.o[0]
        if ref <= 0 or coin.c[i] / ref - 1 > p.max_rise_1h:
            continue
        out.append(i)
    return out


# ---------------------------------------------------------------- un trade
@dataclass
class Trade:
    token: str
    signal_time: int
    entry_time: int
    entry_raw: float
    entry_fill: float
    exit_time: int
    exit_raw: float
    exit_fill: float
    reason: str
    mult: float          # valeur finale / mise (frais + slippage inclus)
    ticket: float = 0.0
    pnl: float = 0.0

    @property
    def ret(self):
        return self.mult - 1.0


def simulate_trade(coin: Coin, i_sig: int, p: Params):
    j = i_sig + p.entry_delay_min
    if j >= len(coin.t):
        return None
    entry_raw = coin.c[j]
    entry_time = coin.t[j] + 60
    fill = entry_raw * (1 + p.slippage)
    stop_lvl = fill * (1 - p.stop_loss)
    rug_lvl = fill * (1 - p.rug_drop)
    peak = fill
    trail_on = False

    def done(k, raw, reason, exit_t, rug=False):
        exit_fill = raw * (1 - p.slippage)
        mult = 0.0 if rug else (1 - p.fee) * (exit_fill / fill) * (1 - p.fee)
        return Trade(coin.token, coin.t[i_sig] + 60, entry_time, entry_raw, fill,
                     exit_t, raw, exit_fill, reason, mult)

    for k in range(j + 1, len(coin.t)):
        o, h, l, c = coin.o[k], coin.h[k], coin.l[k], coin.c[k]
        close_t = coin.t[k] + 60
        # 1) rug / liquidité disparue -> perte totale
        if l <= rug_lvl:
            return done(k, l, "rug (-100%)", close_t, rug=True)
        # 2) stops, avec les niveaux connus AVANT cette bougie (pas de look-ahead intra-bougie)
        eff = stop_lvl
        reason = "stop -6%"
        if trail_on and peak * (1 - p.trail_dist) > eff:
            eff = peak * (1 - p.trail_dist)
            reason = "stop suiveur"
        if l <= eff:
            if p.stop_fill == "always_low" or o <= eff:
                px = l          # la bougie a sauté le stop -> plus bas de la bougie
            else:
                px = eff
            return done(k, px, reason, close_t)
        # 3) mise à jour du plus haut / activation du suiveur
        if h > peak:
            peak = h
        if not trail_on and peak >= fill * (1 + p.trail_trigger):
            trail_on = True
        # 4) sortie temporelle : après 3h, sortie si gain < +5 %
        if close_t - entry_time >= p.time_exit_min * 60 and c < fill * (1 + p.time_exit_min_gain):
            return done(k, c, "temps 3h (<+5%)", close_t)
    return done(len(coin.t) - 1, coin.c[-1], "fin des données", coin.t[-1] + 60)


# ---------------------------------------------------------------- portefeuille
def run_portfolio(coins, p: Params):
    """Simulation chronologique sur tous les coins, max N positions, capital réel."""
    heap = []
    sigs = {}
    for ci, coin in enumerate(coins):
        idx = signal_indices(coin, p)
        sigs[ci] = idx
        for i in idx:
            heapq.heappush(heap, (coin.t[i] + 60, ci, i))

    cash = p.start_capital
    open_pos = []              # heap (exit_time, n, trade)
    entered = set()
    trades, equity_curve = [], [(None, p.start_capital)]
    skipped_capacity = set()
    skipped_cash = set()
    n = 0

    def close_until(ts):
        nonlocal cash
        while open_pos and open_pos[0][0] <= ts:
            _, _, tr = heapq.heappop(open_pos)
            cash += tr.ticket * tr.mult
            equity_curve.append((tr.exit_time, cash + sum(x[2].ticket for x in open_pos)))

    while heap:
        ts, ci, i = heapq.heappop(heap)
        if ci in entered:
            continue
        close_until(ts)
        equity = cash + sum(x[2].ticket for x in open_pos)
        ticket = max(p.ticket_min, p.ticket_pct * equity)
        if len(open_pos) >= p.max_positions:
            skipped_capacity.add(ci)
            continue
        if cash < ticket:
            skipped_cash.add(ci)
            continue
        tr = simulate_trade(coins[ci], i, p)
        if tr is None:
            continue
        tr.ticket = ticket
        tr.pnl = ticket * (tr.mult - 1)
        cash -= ticket
        n += 1
        heapq.heappush(open_pos, (tr.exit_time, n, tr))
        entered.add(ci)
        trades.append(tr)
    close_until(float("inf"))

    return {
        "trades": trades,
        "final": cash,
        "equity_curve": equity_curve,
        "coins_with_signal": sum(1 for v in sigs.values() if v),
        "missed_capacity": len(skipped_capacity - entered),
        "missed_cash": len(skipped_cash - entered),
    }


def stats(res, p: Params):
    tr = res["trades"]
    eq = [e for _, e in res["equity_curve"]]
    peak, mdd = eq[0], 0.0
    for e in eq:
        peak = max(peak, e)
        mdd = max(mdd, (peak - e) / peak if peak > 0 else 0)
    wins = [t for t in tr if t.pnl > 0]
    losses = [t for t in tr if t.pnl <= 0]
    mean = lambda xs: sum(xs) / len(xs) if xs else 0.0  # noqa: E731
    reasons = {}
    for t in tr:
        reasons[t.reason] = reasons.get(t.reason, 0) + 1
    return {
        "capital_final": res["final"],
        "rendement": res["final"] / p.start_capital - 1,
        "trades": len(tr),
        "gagnants_pct": len(wins) / len(tr) if tr else 0.0,
        "gain_moyen_pct": mean([t.ret for t in wins]),
        "perte_moyenne_pct": mean([t.ret for t in losses]),
        "gain_moyen_eur": mean([t.pnl for t in wins]),
        "perte_moyenne_eur": mean([t.pnl for t in losses]),
        "pire_trade_eur": min((t.pnl for t in tr), default=0.0),
        "pire_trade_pct": min((t.ret for t in tr), default=0.0),
        "max_drawdown_pct": mdd,
        "raisons_sortie": reasons,
        "coins_avec_signal": res["coins_with_signal"],
        "rates_max_positions": res["missed_capacity"],
        "rates_manque_cash": res["missed_cash"],
    }
