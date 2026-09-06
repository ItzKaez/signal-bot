/**
 * Telegram formatting of engine events — SELF-EXPLANATORY messages:
 * every message carries the UTC date/time of the EVENT it talks about
 * (not the send time — essential in TEST mode where the past is replayed),
 * a sentence explaining what is happening, and the expected action.
 */
import type { JournalEntry, ClosedTrade } from './engine/strategy-v2/engine';
import type { TradePlan } from './engine/strategy-v2/plans';

const f0 = (v: number | undefined | null): string =>
  v === undefined || v === null || !Number.isFinite(v) ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: 1 });

const f1 = (v: number | undefined | null): string =>
  v === undefined || v === null || !Number.isFinite(v) ? '—' : v.toFixed(1);

const f2 = (v: number | undefined | null): string =>
  v === undefined || v === null || !Number.isFinite(v) ? '—' : v.toFixed(2);

const tf = (sec: number): string => (sec >= 3600 ? `${sec / 3600}h` : `${sec / 60}m`);

const dt = (t: number): string => new Date(t * 1000).toISOString().slice(5, 16).replace('T', ' ');

/** Timestamp of the event (UTC) — always shown. */
const when = (t: number): string => `🗓 ${dt(t)} UTC`;

/** Full message for a NEW SETUP: levels, AOI, TPs, RR + action. */
export function setupMessage(symbol: string, plan: TradePlan): string {
  return [
    `🎯 NEW SETUP · ${symbol} · ${plan.side} ${tf(plan.executionSeconds)}`,
    when(plan.createdAt),
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
  if (reason.includes('break_even')) return 'Break-even exit — the fee-covering stop was touched.';
  if (reason.includes('hard_stop')) return 'Hard stop 2×AOI hit — full-loss exit.';
  if (reason.includes('wick')) return 'Adverse wick stop touched.';
  return 'Position closed.';
}

/** Trade close message (covers TPs, BE, wick SL, hard stop). */
export function closeMessage(symbol: string, t: ClosedTrade): string {
  const pnl = t.pnl >= 0 ? `+${t.pnl.toFixed(2)}$` : `${t.pnl.toFixed(2)}$`;
  const hours = ((t.exitAt - t.entryAt) / 3600).toFixed(1);
  return [
    `${t.pnl >= 0 ? '✅' : '🔻'} CLOSED · ${symbol} · ${t.side} (${t.reason})`,
    when(t.exitAt),
    '',
    `Entry ${f0(t.averageEntry)} → exit ${f0(t.exitPrice)} · ${t.fills} fill(s) · duration ${hours}h`,
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
};

// DIAGNOSTIC events (queue purges, waits): useful live (rare), but in a
// TEST-mode burst they are what spams and triggers 429s — muted when quiet.
const QUIET_SKIP = new Set(['cancelled_unfilled', 'ladder_await_downgrade', 'waiting_margin']);

/** Journal event → message (null = do not send).
 *  quiet (TEST mode): without diagnostic events. */
export function eventMessage(symbol: string, e: JournalEntry, quiet = false): string | null {
  const emoji = EVENT_EMOJI[e.type];
  if (!emoji) return null;
  if (quiet && QUIET_SKIP.has(e.type)) return null;
  const text = EVENT_TEXT[e.type];
  const price = e.price !== undefined && e.price !== null ? ` @ ${f0(e.price)}` : '';
  const lines = [
    `${emoji} ${text.title} · ${symbol}${price}`,
    when(e.t),
  ];
  if (e.note) lines.push('', e.note);
  lines.push('', `→ ${text.explain}`);
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
