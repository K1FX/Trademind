"""Paramètres de la stratégie et du backtest (tout est ici, rien de caché ailleurs)."""
from dataclasses import dataclass, replace
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
RAW = DATA / "raw"
CANDLES = DATA / "candles"
RESULTS = DATA / "results"


@dataclass(frozen=True)
class Params:
    # --- Capital ---
    start_capital: float = 200.0          # €
    ticket_min: float = 47.50             # €
    ticket_pct: float = 0.08              # 8 % du capital si > ticket_min
    max_positions: int = 3

    # --- Fenêtre d'entrée (minutes après la migration) ---
    wait_min: int = 10
    window_min: int = 60

    # --- Filtres d'entrée ---
    min_liquidity_usd: float = 40_000
    min_volume_1h_usd: float = 25_000
    max_rise_1h: float = 0.80             # +80 % max sur 1h

    # --- Sorties ---
    stop_loss: float = 0.06               # -6 %
    trail_trigger: float = 0.20           # stop suiveur activé à +20 %
    trail_dist: float = 0.12              # 12 % sous le plus haut
    time_exit_min: int = 180              # 3h
    time_exit_min_gain: float = 0.05      # sortie si < +5 % après 3h

    # --- Réalisme ---
    entry_delay_min: int = 1              # temps de réaction humain
    fee: float = 0.02                     # 2 % achat, 2 % vente
    slippage: float = 0.03                # 3 % entrée, 3 % sortie
    # "gap_low" : si la bougie OUVRE sous le stop -> sortie au plus bas,
    #             sinon au niveau du stop.
    # "always_low" : dès que le stop est touché -> sortie au plus bas (pessimiste).
    stop_fill: str = "gap_low"
    # Chute >= 90 % sous le prix d'entrée = liquidité disparue / rug -> -100 %.
    rug_drop: float = 0.90

    # --- Modèle de liquidité (voir README : pas de liquidité historique dispo) ---
    # Réserves initiales d'un pool PumpSwap après migration pump.fun.
    pool_sol_reserve0: float = 85.0
    pool_token_reserve0: float = 206.9e6


BASE = Params()
SCENARIOS = {
    "base (2% frais, 3% slippage)": BASE,
    "sans frais ni slippage": replace(BASE, fee=0.0, slippage=0.0),
    "slippage x2 (2% frais, 6% slippage)": replace(BASE, slippage=0.06),
    "base + stop toujours au plus bas": replace(BASE, stop_fill="always_low"),
}
