# Signal Bot — Peak/POC/Fib Ladder en live, notifications Telegram

Moteur de signaux 24/7 pour la stratégie **15m/30m sans descente de TF** :
il scanne en continu 5 paires (BTC, ETH, SOL, BNB, XRP — modifiable via
la variable d'env PAIRS) en base 1m, joue UNIQUEMENT les setups 15m/30m
(priorité 30m, montée 15m→30m, confluence POC ≥ 8 % — la cascade vers
5m/1m est désactivée : les frames ne détectent des peaks qu'en 900s/1800s),
et envoie sur Telegram chaque événement :

- 🎯 **setup trouvé** — side, TF, peak RSI, POC d'entrée, AOI %, borne SL,
  toutes les entrées limites (DCA), tous les niveaux de TP, RR
- ⚡️ activation (limites posées) · 🟢 **fill** DCA par DCA
- 🟡 **BE** (niveau exact frais-couverts) · 🔴 **SL sur la mèche**
- ⬆️ montées de regard 15m→30m (« watching 15m → 30m · plan 15m kept »)
- ✅/🔻 clôtures avec P&L et raison (TPn / BE / wick / hard stop 2×AOI)
- 📅 actualisation des POCs à minuit UTC

Le moteur de stratégie est embarqué dans `engine/` — copie EXACTE des
moteurs de trading-helper (`src/lib/trading-scope/`) : parité totale des
signaux avec le chart et les backtests.

## Redémarrage sans perte

Au boot : warmup (90 j) puis **replay des 3 derniers jours** avec les POCs
injectés à chaque frontière de jour — les positions ouvertes et setups en
file sont reconstruits à l'identique. Seuls les événements post-démarrage
sont envoyés.

## Configuration (`.env`)

```bash
TELEGRAM_BOT_TOKEN=123456:ABC...   # via @BotFather
TELEGRAM_CHAT_ID=123456789         # votre chat (le bot vous le donne au /start)
PAIRS=BTC,ETH,SOL,BNB,XRP
POC_SOURCES=BINANCE:USD,BINANCE:USDT.P,BYBIT:USDT.P,OKX:USDT.P,BITFINEX:USD,COINBASE:USD,COINBASE:USDT
QUOTE=USDT
CAPITAL=10000
POLL_SEC=20
WARMUP_DAYS=90
CATCHUP_DAYS=3
# SIGNAL_OVERRIDE={"wickStopMode":"immediate"}   # surcharge stratégie (JSON)
# DRY_RUN=1                                      # console uniquement
```

## Créer le bot Telegram

1. [@BotFather](https://t.me/BotFather) → `/newbot` → nom + username → **token**.
2. Ouvrir une conversation avec votre bot, envoyer `/start` n'importe quoi.
3. `npm start` sans `TELEGRAM_CHAT_ID` : le bot répond au `/start` avec
   **votre chat id** → le mettre dans `.env`.
4. (Groupe ? ajouter le bot au groupe, il répond de même.)

## Lancer

```bash
npm install
cp .env.example .env   # puis renseigner TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID
npm start              # tsx index.ts (lit .env)
```

## VPS 24/7 (systemd)

```bash
git clone <ce repo> /opt/signal-bot && cd /opt/signal-bot
npm install && cp .env.example .env && nano .env

# ADAPTER le unit au VPS : chemins + emplacement réel de npx (sinon
# « Failed to spawn / Failed to load environment files »).
sudo cp signal-bot.service /etc/systemd/system/
sudo sed -i "s|ExecStart=/usr/bin/npx|ExecStart=$(which npx)|" /etc/systemd/system/signal-bot.service
# (clone ailleurs qu'en /opt ? adapter aussi WorkingDirectory/EnvironmentFile,
#  ou déplacer : sudo mv ~/signals-bot/signal-bot /opt/signal-bot)
# (node via nvm ? ajouter : Environment=PATH=$(dirname $(which npx)):/usr/bin:/bin)

sudo systemctl daemon-reload
sudo systemctl enable --now signal-bot
journalctl -u signal-bot -f        # logs
```

`signal-bot.service` attend `/opt/signal-bot` — adapter `WorkingDirectory`
et l'utilisateur. Redémarrage automatique (`Restart=always`) ; à chaque
redémarrage le replay de rattrapage reconstruit les positions ouvertes.

## Synchroniser le moteur avec trading-helper

`engine/` est la copie de 12 fichiers de `src/lib/trading-scope/`
(trading-helper) — fermeture d'imports complète, sans Firebase ni
backtest :

```
types.ts, indicator-engine.ts
strategy-v2/: app-engine, engine, config, peaks, rsipeaks-live, plans,
              fib, aoi, pocs, mtf-ladder
```

Après une évolution de la stratégie dans trading-helper :

```bash
cd /chemin/trading-helper
cp src/lib/trading-scope/types.ts            /opt/signal-bot/engine/
cp src/lib/trading-scope/indicator-engine.ts /opt/signal-bot/engine/
cp src/lib/trading-scope/strategy-v2/{app-engine,engine,config,peaks,rsipeaks-live,plans,fib,aoi,pocs,mtf-ladder}.ts    /opt/signal-bot/engine/strategy-v2/
```

puis `npm run typecheck` et redémarrage du service.

## Notes

- **Sources POC : les 7 des backtests** (BINANCE:USD, BINANCE:USDT.P,
  BYBIT:USDT.P, OKX:USDT.P, BITFINEX:USD, COINBASE:USD, COINBASE:USDT) —
  dailies propres à chaque source, intraday 1h Bybit partagé, UNION des
  niveaux et meta conc/TF « première écriture » dans cet ordre (fusion
  identique à runBacktest). Une paire absente d'une source (ex. BNB hors
  Bitfinex/Coinbase) est simplement retirée de l'union pour cette paire.
  `POC_SOURCES` pour restreindre. Mapping de parité avec le route de
  l'app : `.P` retiré (BINANCE/OKX publics = spot), BINANCE:USD → USDT.
- **Rate limit Bybit** : pacing 600 ms/page au boot, backoff sur retCode
  10003. Les ticks live (1 req/20 s/paire) sont très en dessous.
- Les **fils de commandes** : `/ping`, `/status` (positions ouvertes,
  floating, setups en file, dernière erreur).
