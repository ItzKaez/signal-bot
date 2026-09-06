/**
 * SIGNAL BOT — moteur de signaux live de la stratégie Peak/POC/Fib LADDER
 * (mêmes moteurs que l'app, parité exacte) sur N paires, notifications
 * Telegram, conçu pour tourner 24/7 sur un VPS (systemd).
 *
 *   PAIRS=BTC,ETH,SOL,BNP…  QUOTE=USDT  DRY_RUN=1 npm start
 *
 * Voir README.md (BotFather, chat id, unit systemd).
 */
import { PairRunner } from './pair-runner';
import { Telegram } from './telegram';
import { statusLine } from './format';
import { parsePocSources } from './sources';

// ── .env (sans dépendance) ──
try { process.loadEnvFile?.(); } catch { /* optionnel */ }

const env = process.env;
const DRY_RUN = env.DRY_RUN === '1';
const TOKEN = env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = env.TELEGRAM_CHAT_ID;
const PAIRS = (env.PAIRS ?? 'BTC,ETH,SOL,BNB,XRP').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const QUOTE = (env.QUOTE ?? 'USDT').toUpperCase();
const CAPITAL = Number(env.CAPITAL ?? 10_000);
const POLL_SEC = Number(env.POLL_SEC ?? 20);
const WARMUP_DAYS = Number(env.WARMUP_DAYS ?? 90);
const CATCHUP_DAYS = Number(env.CATCHUP_DAYS ?? 3);
// Les 7 SOURCES POC des backtests (union des niveaux, meta première
// écriture dans cet ordre) : POC_SOURCES pour restreindre.
const POC_SOURCES = parsePocSources(env.POC_SOURCES ?? 'BINANCE:USD,BINANCE:USDT.P,BYBIT:USDT.P,OKX:USDT.P,BITFINEX:USD,COINBASE:USD,COINBASE:USDT');
const BOOT_STAGGER_SEC = Number(env.BOOT_STAGGER_SEC ?? 45);
/** TEST_DAYS=14 : rejoue les 14 derniers jours et ENVOIE tous les
 *  événements (setups, fills, BE, SL, clôtures) puis s'arrête — tester
 *  le pipeline complet sans attendre de vrais setups. */
const TEST_DAYS = Number(env.TEST_DAYS ?? 0);

// Stratégie : setups 15m/30m UNIQUEMENT (exécution multi-TF sans descente
// — les frames ne détectent des peaks qu'en 900s/1800s, la cascade vers
// 5m/1m est structurellement impossible ; la priorité 30m et la montée
// 15m→30m restent actives) + preset « POCs Reversal Optimisé ». Surcharge
// possible via SIGNAL_OVERRIDE='{"executionSeconds":[60,300,900,1800],…}'.
const DEFAULT_OVERRIDE: Record<string, unknown> = {
  // Ladder OFF : mono-15m strict — EXACTEMENT la config validée IS +217$ /
  // OOS +1002$ (déferral 3-drives actif, comme le run de référence).
  mtfLadderEnabled: false,
  // 15m SEUL : l'analyse par classe de trades (IS+OOS) a montré que les
  // entrées 30m perdent (-2081$/-1016$) et bloquent le slot mono avec des
  // trades lents — le combiné [900,1800] est la pire des 3 configs testées.
  // Mono-15m : IS +217$ / OOS +1002$ (meilleure config mesurée).
  executionSeconds: [900],
  limitExpiryBars: 375, // 6,25 h en bougies 1m (parité avec la validation)
  breakevenCoverFees: true,
  breakevenMode: 'profit_close',
  hardExitAoiMultiple: 2.0,
  wickStopMode: 'after_tp1',
  maxConcurrentPositions: 1,
  feeModel: 'maker_taker',
  minAoiFloorPct: 0.003,
  minPocConcentration: 0.07,
  pocZoneAgg: 'avg',
  wickArmStrategy: 'breathe',
  maxLeverage: 10,
};
let override = DEFAULT_OVERRIDE;
if (env.SIGNAL_OVERRIDE) {
  try {
    override = { ...DEFAULT_OVERRIDE, ...JSON.parse(env.SIGNAL_OVERRIDE) as Record<string, unknown> };
  } catch (err) {
    console.error('SIGNAL_OVERRIDE JSON invalide, valeurs par défaut utilisées :', err instanceof Error ? err.message : err);
  }
}

// TEST_DAYS > 0 : Terminal ONLY — the replay burst would hammer Telegram
// (429 rate limits); test messages go to the console, never sent.
const telegram = new Telegram(TOKEN, CHAT_ID, DRY_RUN || TEST_DAYS > 0);
const bootT = Date.now();
const runners = PAIRS.map((base) => new PairRunner({
  symbol: `${base}${QUOTE}`,
  capital: CAPITAL,
  override,
  warmupDays: WARMUP_DAYS,
  catchupDays: Math.max(CATCHUP_DAYS, TEST_DAYS),
  pollSec: POLL_SEC,
  testDays: TEST_DAYS,
  pocSources: POC_SOURCES,
  telegram,
}));

function buildStatus(): string {
  const up = Math.round((Date.now() - bootT) / 60000);
  const lines = [
    `🤖 Signal bot · ${Math.floor(up / 60)}h${String(up % 60).padStart(2, '0')} uptime · ${DRY_RUN ? 'DRY MODE (console)' : 'Telegram active'}`,
  ];
  for (const r of runners) {
    const s = r.status();
    lines.push(statusLine(r.symbol, s));
    if (s.lastError) lines.push(`   ⚠️ last error: ${s.lastError}`);
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  console.log(`Signal bot — ${runners.length} pair(s): ${runners.map((r) => r.symbol).join(', ')}`);
  console.log(`Strategy: ladder ${override.mtfLadderEnabled ? 'ON' : 'OFF'} · Optimized preset · warmup ${WARMUP_DAYS}d · catchup ${CATCHUP_DAYS}d`);
  if (DRY_RUN) console.log('DRY_RUN=1 → console messages only (no Telegram).');
  else if (!TOKEN || !CHAT_ID) console.warn('⚠️ TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing → console messages only.');

  // Sequential boot (Bybit pacing) — live ticks start only once each
  // pair is ready.
  if (TEST_DAYS > 0) {
    console.log(`TEST MODE: replaying the last ${TEST_DAYS} days — all events are printed to THIS terminal only (no Telegram), then the bot stops.`);
    telegram.send(`🧪 TEST MODE — replaying the last ${TEST_DAYS} days (${runners.map((r) => r.symbol).join(', ')}): here are ALL the events the bot would have sent. Test ends right after.`);
  } else {
    telegram.send(`🤖 Signal bot starting — ${runners.length} pairs: ${runners.map((r) => r.symbol).join(', ')}\nStrategy ladder 15m/30m · warmup ${WARMUP_DAYS}d (~${Math.round(runners.length * 2)} min)`);
  }
  for (const runner of runners) {
    try {
      await runner.boot();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${runner.symbol}] BOOT FAILED:`, msg);
      telegram.send(`🛑 ${runner.symbol}: boot failed — ${msg}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  // Test mode: the replay emitted everything — summary then clean stop.
  if (TEST_DAYS > 0) {
    const n = telegram.sentLog.length;
    telegram.send(`🧪 Test over — ${n} message(s) sent across ${TEST_DAYS} days of replay.`);
    console.log(`Test finished: ${n} message(s). Stopping.`);
    setTimeout(() => process.exit(0), 5000);
    return;
  }

  // Boucle live : une tick par POLL_SEC par paire, décalées entre elles.
  let running = false;
  let lastTickAt = 0;
  const loop = async (): Promise<void> => {
    if (running || Date.now() - lastTickAt < POLL_SEC * 1000) return;
    running = true;
    lastTickAt = Date.now();
    try {
      for (const runner of runners) await runner.tick();
    } finally {
      running = false;
    }
  };
  setInterval(() => { void loop(); }, Math.min(5, POLL_SEC) * 1000);

  // Commandes Telegram (/start /ping /status) — polling léger.
  if (TOKEN) {
    setInterval(() => {
      void telegram.pollCommands((cmd, chat) => {
        if (cmd === '/start' || cmd === '/help') {
          void telegram.reply(chat, `🤖 Signal bot operational.\nYour chat id: ${chat}\nCommands: /ping · /status`);
        } else if (cmd === '/ping') {
          void telegram.reply(chat, '🏓 pong');
        } else if (cmd === '/status') {
          void telegram.reply(chat, buildStatus());
        }
      });
    }, 3000);
  }

  console.log('Live loop started.');
}

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT:', err);
  telegram.send(`🛑 Erreur fatale — redémarrage propre : ${err instanceof Error ? err.message : err}`);
  setTimeout(() => process.exit(1), 4000);
});
process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err);
});

void main();
