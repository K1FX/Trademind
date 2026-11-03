# Backtest memecoin pump.fun → PumpSwap (14 jours, 200 €)

## Lancer

```bash
pip install requests
export MORALIS_API_KEY=...                 # clé gratuite : https://admin.moralis.com
python backtest/fetch_graduated.py --days 14   # -> data/graduated.json
python backtest/fetch_candles.py --sample 1000 # -> data/candles/*.json (~45 min à 25 req/min)
python backtest/run_backtest.py               # -> data/results/rapport.md + CSV
python backtest/test_engine.py                # tests de la mécanique (bougies synthétiques)
```

Tout est mis en cache dans `data/`. Relancer un script ne retélécharge que ce qui manque.
La seconde fois, `run_backtest.py` suffit, sans réseau.

## Sources
- Coins gradués + heure de migration : Moralis, `GET /token/mainnet/exchange/pumpfun/graduated`.
- Pool PumpSwap : GeckoTerminal `tokens/multi` (top_pools) + `pools/multi` (dex = pumpswap).
- Bougies 1 min (OHLC + volume USD) : GeckoTerminal `pools/{pool}/ohlcv/minute`, 1000 bougies
  après la migration (~16 h).
- SOL/USD horaire : GeckoTerminal (pool SOL/USDC), pour le modèle de liquidité.
- Échantillon : tirage aléatoire (seed 42) d'au moins 1000 coins si la liste est plus longue.

## Règles appliquées (sans regarder le futur)
- Décisions à la clôture de chaque bougie 1 min, de +10 à +60 min après la migration,
  avec uniquement les bougies déjà clôturées.
- Filtres : liquidité ≥ 40 k$, volume 60 min ≥ 25 k$, hausse 60 min ≤ +80 %.
- Entrée 1 bougie après le signal (réaction humaine), au prix de clôture, + 3 % de slippage, 2 % de frais.
- Ticket = max(47,50 €, 8 % du capital), max 3 positions, pas d'entrée si le cash manque.
- Sorties, évaluées bougie par bougie avec les niveaux connus au début de la bougie :
  1. le plus bas ≤ -90 % du prix d'entrée → liquidité disparue / rug → **-100 %** ;
  2. stop -6 % (ou stop suiveur 12 % sous le plus haut, actif dès +20 % atteint).
     Si la bougie **ouvre** sous le stop (gap) → sortie au **plus bas de la bougie**,
     sinon au niveau du stop. Le scénario « stop toujours au plus bas » est encore plus pessimiste ;
  3. après 3 h, sortie à la clôture de la première bougie sous +5 % ;
  4. fin des données → sortie au dernier prix (signalé dans le rapport).
- Scénarios : base, sans frais ni slippage, slippage ×2 (6 %), stop toujours au plus bas.

## Limites connues (à lire avant de croire un chiffre)
- **Filtres de sécurité (dev, holders, bundles) non vérifiables dans le passé.** Ils ne sont
  pas appliqués. Seule protection simulée : un krach ≥ 90 % compte comme une perte totale.
- **Pas de liquidité historique dans GeckoTerminal.** Elle est estimée avec le modèle du pool
  à produit constant de PumpSwap (réserves initiales ~85 SOL / ~206,9 M tokens) :
  `liq = 2·sqrt(k·prix_usd·SOL_usd)`. Cette estimation ne voit pas la liquidité ajoutée ou
  retirée par d'autres LP. La liquidité actuelle n'est pas utilisée, pour ne pas introduire
  de biais du futur.
- Conséquence importante : au moment de la migration la liquidité vaut ≈ 2 × 85 SOL ≈ 170 SOL.
  Pour atteindre 40 k$, il faut un SOL ≥ 235 $, ou un prix déjà monté de
  (40 000 / (170·SOL))² − 1. À SOL = 150 $, c'est ≈ +146 %, ce qui est incompatible avec le filtre
  « hausse 1h ≤ 80 % » dans l'heure qui suit la migration. Les filtres peuvent donc presque
  s'exclure : le rapport affiche l'entonnoir pour le mesurer.
- « Hausse 1h » : avant la migration, il n'y a pas de bougie de pool (le token est encore sur
  la bonding curve). La référence est alors le 1er prix du pool.
- Coût minimal d'un aller-retour, prix inchangé : 0,98 × 0,98 × 0,97 / 1,03 ≈ **-9,6 %**.
  Un stop -6 % coûte en réalité ≈ **-12,4 %**. Un stop suiveur déclenché juste après
  l'activation (+20 % puis -12 %) donne ≈ **-1,6 %**.
- Les bougies GeckoTerminal sautent les minutes sans trade. Elles sont remplies au dernier prix,
  avec un volume de 0.
- Le drawdown est calculé sur le capital réalisé (positions comptées au prix d'achat).
- 14 jours représentent un seul régime de marché. Ce n'est pas une preuve statistique.
