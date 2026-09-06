/**
 * Telegram formatting of engine events — SELF-EXPLANATORY messages:
 * every message carries the UTC date/time of the EVENT it talks about
 * (not the send time — essential in TEST mode where the past is replayed),
 * a sentence explaining what is happening, and the expected action.
 */
import type { JournalEntry, ClosedTrade } from './engine/strategy-v2/engine';
import type { TradePlan } from './engine/strategy-v2/plans';

// Chiffres significatifs adaptés au prix : BTC/ETH 1-2 décimales, mais
// XRP/SOL/DOGE en ont besoin de 4-6 (sinon tous les niveaux s'arrondissent
// à la même valeur affichée et les ordres sont inplaçables).
const priceDigits = (v: number): number => (v >= 1000 ? 1 : v >= 100 ? 2 : v >= 1 ? 4 : 6);

const f0 = (v: number | undefined | null): string =>
  v === undefined || v === null || !Number.isFinite(v) ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: priceDigits(v) });

const f1 = (v: number | undefined | null): string =>
  v === undefined || v === null || !Number.isFinite(v) ? '—' : v.toFixed(1);

const f2 = (v: number | undefined | null): string =>
  v === undefined || v === null || !Number.isFinite(v) ? '—' : v.toFixed(2);

const tf = (sec: number): string => (sec >= 3600 ? `${sec / 3600}h` : `${sec / 60}m`);

const dt = (t: number): string => new Date(t * 1000).toISOString().slice(5, 16).replace('T', ' ');

/** Timestamp of the event (UTC) — always shown. */
const when = (t: number): string => `🗓 ${dt(t)} UTC`;

/** Full message for a NEW SETUP: levels, AOI, TPs, RR + action.
 *  announceAt : quand le message est émis à l'ACTIVATION (setup qui a
 *  attendu en file) — l'heure affichée est l'activation, la découverte
 *  du peak est mentionnée dans le corps. */
export function setupMessage(symbol: string, plan: TradePlan, announceAt?: number): string {
  const header = announceAt !== undefined && announceAt > plan.createdAt
    ? [
      `🎯 NEW SETUP · ${symbol} · ${plan.side} ${tf(plan.executionSeconds)}`,
      when(announceAt),
      '',
      `Setup detected ${dt(plan.createdAt)} UTC — it waited in queue while the previous position was live; it activates NOW.`,
    ]
    : [
      `🎯 NEW SETUP · ${symbol} · ${plan.side} ${tf(plan.executionSeconds)}`,
      when(plan.createdAt),
    ];
  return [
    ...header,
    '',
    `The ${tf(plan.executionSeconds)} RSI printed a peak at ${f1(plan.peakRsi)} (price ${f0(plan.peakPrice)}) — expecting a pullback into liquidity.`,
    `Entry POC: ${f0(plan.entryPoc)} · AOI ${(plan.aoiPct * 100).toFixed(2)}% · SL bound: ${f0(plan.aoiBoundary)}`,
    '',
    `Entry limits (DCA): ${plan.entryLevels.map((l) => f0(l)).join(' / ')}`,
    `TPs: ${plan.targets.map((t) => f0(t.price)).join(' / ')}`,
    `RR→TP1: ${f2(plan.rrToTp1)} · fib impulse ${tf(plan.fibonacci?.timeframeSeconds ?? 0)}`,
    '',
    '→ Place these limits. The stop sits at the AOI bound; the setup cancels if the peak breaks or the divergence confirms without a fill.',
  ].join('\n');
}

/** Explanation of a close reason. */
function closeExplain(reason: string): string {
  if (reason.startsWith('tp')) return 'Target hit — partial or full profit taken.';
  if (reason.includes('break_even')) return 'BE STOP TOUCHED — exited at the fee-covering level: no loss on the trade.';
  if (reason.includes('hard_stop')) return 'Hard stop 2×AOI hit — full-loss exit.';
  if (reason.includes('wick')) return 'WICK SL touched — exited on the adverse-wick stop placed after the divergence.';
  if (reason.includes('forced')) return 'Forced exit — consecutive closes beyond 2×AOI.';
  if (reason.includes('divergence_invalidated')) return 'Protective stop hit after divergence invalidation.';
  return 'Position closed.';
}

/** Clear label per close reason (what exactly was hit). */
function closeLabel(reason: string): string {
  if (reason.startsWith('tp')) return `TP${reason.slice(2)} HIT`;
  if (reason.includes('break_even')) return 'BE STOP HIT';
  if (reason.includes('hard_stop')) return 'HARD STOP HIT';
  if (reason.includes('wick')) return 'WICK SL HIT';
  if (reason.includes('forced')) return 'FORCED EXIT';
  return 'CLOSED';
}

/** Trade close message (covers TPs, BE, wick SL, hard stop, forced exit). */
export function closeMessage(symbol: string, t: ClosedTrade): string {
  const pnl = t.pnl >= 0 ? `+${t.pnl.toFixed(2)}$` : `${t.pnl.toFixed(2)}$`;
  const hours = ((t.exitAt - t.entryAt) / 3600).toFixed(1);
  return [
    `${t.pnl >= 0 ? '✅' : '🔻'} ${closeLabel(t.reason)} · ${symbol} · ${t.side}`,
    when(t.exitAt),
    '',
    `Entry ${f0(t.averageEntry)} → exit ${f0(t.exitPrice)} · ${t.fills} fill(s) · duration ${hours}h · reason: ${t.reason}`,
    `P&L ${pnl} (fees ${t.fees.toFixed(2)}$)`,
    '',
    `→ ${closeExplain(t.reason)}`,
  ].join('\n');
}

const EVENT_EMOJI: Record<string, string> = {
  plan_activated: '⚡️',
  dca_fill: '🟢',
  breakeven_enabled: '🟡',
  sl_wick: '🔴',
  cancelled_unfilled: '❌',
  limits_cancelled: '➖',
  ladder_upgrade: '⬆️',
  ladder_downgrade: '⬇️',
  ladder_downgrade_late: '⬇️',
  ladder_await_downgrade: 'ℹ️',
  reference_peak_moved: '⛓',
  adverse_close: '⚠️',
  plan_replaced: '♻️',
  twin_replaced: '♻️',
  wick_breathe: '🫁',
};

/** Title + explanation per event type (what happens / the action). */
const EVENT_TEXT: Record<string, { title: string; explain: string }> = {
  plan_activated: {
    title: 'SETUP ACTIVE',
    explain: 'Limit orders are placed on the market — waiting for fills. Watch the next messages for management.',
  },
  dca_fill: {
    title: 'FILL',
    explain: 'An entry limit has been filled: the position is building up, remaining limits stay in place.',
  },
  breakeven_enabled: {
    title: 'BREAK-EVEN ARMED',
    explain: 'Stop moved to the fee-covering level: the trade can no longer lose. Remaining DCAs are cancelled.',
  },
  sl_wick: {
    title: 'WICK SL',
    explain: 'Stop placed on the adverse wick — active from the next candle. BE as soon as a close turns profitable.',
  },
  cancelled_unfilled: {
    title: 'SETUP CANCELLED',
    explain: 'Invalidated before any fill — no position was taken.',
  },
  limits_cancelled: {
    title: 'DCAS CANCELLED',
    explain: 'Partial invalidation: remaining limits are pulled, the filled part keeps being managed.',
  },
  wick_breathe: {
    title: 'BREATHING (NO WICK)',
    explain: 'Divergence confirmed at a loss but NO wick SL is placed: the trade breathes. BE arms on the first profitable close; the wick SL only comes if the div actually BREAKS — hard stop 2×AOI as backstop meanwhile.',
  },
  plan_replaced: {
    title: 'SETUP REPLACED',
    explain: 'The previous unfilled setup was cancelled — the latest peak takes its place (the former diverged).',
  },
  twin_replaced: {
    title: 'TWIN REPLACED',
    explain: 'This peak is a twin of a higher-priority timeframe setup: the higher TF takes the slot.',
  },
  ladder_upgrade: {
    title: 'WATCH UPGRADE',
    explain: 'A higher-TF setup is available: now watching it. Entries, stops and TPs remain those of the original plan.',
  },
  ladder_downgrade: {
    title: 'WATCH DOWNGRADE',
    explain: 'The watched setup got invalidated: now watching the lower TF. Management (original plan) unchanged.',
  },
  ladder_downgrade_late: {
    title: 'LATE DOWNGRADE',
    explain: 'A lower-TF setup finally became available after the invalidation — now watching it.',
  },
  ladder_await_downgrade: {
    title: 'AWAITING DOWNGRADE',
    explain: 'Watched setup invalidated with no lower candidate available: staying in the trade, hard stop 2×AOI as backstop.',
  },
  reference_peak_moved: {
    title: '3 DRIVES CHAIN',
    explain: 'A new same-side peak extends the setup (3 drives): divergences are now judged from this new reference peak — DCAs stay in place, hoping for fills during the divergence.',
  },
  adverse_close: {
    title: 'ADVERSE CLOSES',
    explain: 'Consecutive close(s) beyond 2×AOI — forced exit is approaching if the price keeps closing against the trade.',
  },
};

/** Journal event → message (null = do not send). posContext: line
 *  identifying the CURRENT position the event belongs to (mono-position). */
export function eventMessage(symbol: string, e: JournalEntry, posContext?: string): string | null {
  const emoji = EVENT_EMOJI[e.type];
  if (!emoji) return null;
  const text = EVENT_TEXT[e.type];
  // Variante : une RELÈVE de BE (profit_close) n'annule pas de DCA — c'est
  // un resserrement du stop, pas un premier armement.
  const isBeUpgrade = e.type === 'breakeven_enabled' && !!e.note?.includes('BE upgrade');
  // Variante : annulation des DCA par l'armement du BE (pas une invalidation).
  const isBeCancel = e.type === 'limits_cancelled' && !!e.note?.includes('BE armed');
  const title = isBeUpgrade ? 'BE RAISED' : isBeCancel ? 'DCAS CANCELLED (BE)' : text.title;
  const explain = isBeUpgrade
    ? 'Fee-covering stop RAISED higher (never loosened) — the trade locks in more as price closes better.'
    : isBeCancel
      ? 'Break-even armed: the remaining DCA limits are removed — setup complete, the stop is locked.'
      : text.explain;
  const price = e.price !== undefined && e.price !== null ? ` @ ${f0(e.price)}` : '';
  const lines = [
    `${emoji} ${title} · ${symbol}${price}`,
    when(e.t),
  ];
  if (e.note) lines.push('', e.note);
  if (posContext) lines.push(posContext);
  lines.push('', `→ ${explain}`);
  return lines.join('\n');
}

/** Status line for /status. */
export function statusLine(symbol: string, info: {
  booted: boolean;
  openPositions: number;
  pending: number;
  lastEventAt: number | null;
  positionSummary: string[];
  pocCount: number;
}): string {
  if (!info.booted) return `⏳ ${symbol}: starting (warmup)…`;
  const pos = info.positionSummary.length > 0 ? `\n${info.positionSummary.map((l) => `   ${l}`).join('\n')}` : '';
  return [
    `${symbol}: ${info.openPositions} position(s) · ${info.pending} setup(s) queued · ${info.pocCount} active POCs`,
    `   last event: ${info.lastEventAt ? dt(info.lastEventAt) : '—'}`,
  ].join('\n') + pos;
}

export { dt };
