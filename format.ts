/**
 * Mise en forme Telegram des événements du moteur (journal + diffs de
 * plans/trades). Les notes du journal sont déjà riches — on les encadre
 * d'un emoji et du contexte paire.
 */
import type { JournalEntry, ClosedTrade } from './engine/strategy-v2/engine';
import type { TradePlan } from './engine/strategy-v2/plans';

const f0 = (v: number | undefined | null): string =>
  v === undefined || v === null || !Number.isFinite(v) ? '—' : v.toLocaleString('fr-FR', { maximumFractionDigits: 1 });

const f1 = (v: number | undefined | null): string =>
  v === undefined || v === null || !Number.isFinite(v) ? '—' : v.toFixed(1);

const f2 = (v: number | undefined | null): string =>
  v === undefined || v === null || !Number.isFinite(v) ? '—' : v.toFixed(2);

const tf = (sec: number): string => (sec >= 3600 ? `${sec / 3600}h` : `${sec / 60}m`);

const dt = (t: number): string => new Date(t * 1000).toISOString().slice(5, 16).replace('T', ' ');

/** Message complet d'un NOUVEAU SETUP (niveaux, AOI, TPs, RR). */
export function setupMessage(symbol: string, plan: TradePlan): string {
  const lines = [
    `🎯 SETUP ${symbol} · ${plan.side} ${tf(plan.executionSeconds)}`,
    `Peak RSI ${f1(plan.peakRsi)} @ ${f0(plan.peakPrice)} · POC d'entrée ${f0(plan.entryPoc)}`,
    `AOI ${(plan.aoiPct * 100).toFixed(2)}% · borne SL (AOI) ${f0(plan.aoiBoundary)}`,
    `Entrées limites : ${plan.entryLevels.map((l) => f0(l)).join(' / ')}`,
    `TPs : ${plan.targets.map((t) => f0(t.price)).join(' / ')}`,
    `RR→TP1 ${f2(plan.rrToTp1)} · fib ${tf(plan.fibonacci?.timeframeSeconds ?? 0)}`,
  ];
  return lines.join('\n');
}

/** Message de clôture d'un trade (couvre TPs, BE, SL mèche, hard stop). */
export function closeMessage(symbol: string, t: ClosedTrade): string {
  const pnl = t.pnl >= 0 ? `+${t.pnl.toFixed(2)}$` : `${t.pnl.toFixed(2)}$`;
  const hours = ((t.exitAt - t.entryAt) / 3600).toFixed(1);
  return [
    `${t.pnl >= 0 ? '✅' : '🔻'} CLÔTURE ${symbol} · ${t.side} (${t.reason})`,
    `Entrée ${f0(t.averageEntry)} → sortie ${f0(t.exitPrice)} · ${t.fills} fill(s) · ${hours}h`,
    `P&L ${pnl} (frais ${t.fees.toFixed(2)}$)`,
  ].join('\n');
}

const EVENT_EMOJI: Record<string, string> = {
  plan_activated: '⚡️',
  dca_fill: '🟢',
  breakeven_enabled: '🟡',
  sl_wick: '🔴',
  exit: '💰',
  cancelled_unfilled: '❌',
  limits_cancelled: '➖',
  ladder_upgrade: '⬆️',
  ladder_downgrade: '⬇️',
  ladder_downgrade_late: '⬇️',
  ladder_await_downgrade: 'ℹ️',
  fill_check: '👈',
  waiting_margin: '⏳',
};

/** Événement de journal → message (null = à ne pas envoyer). */
export function eventMessage(symbol: string, e: JournalEntry): string | null {
  if (!(e.type in EVENT_EMOJI)) return null;
  const head = `${EVENT_EMOJI[e.type]} ${symbol}`;
  const price = e.price !== undefined && e.price !== null ? ` @ ${f0(e.price)}` : '';
  const note = e.note ? `\n${e.note}` : '';
  return `${head}${price}${note}`;
}

/** Ligne d'état pour /status. */
export function statusLine(symbol: string, info: {
  booted: boolean;
  openPositions: number;
  pending: number;
  lastEventAt: number | null;
  positionSummary: string[];
  pocCount: number;
}): string {
  if (!info.booted) return `⏳ ${symbol} : démarrage (warmup)…`;
  const pos = info.positionSummary.length > 0 ? `\n${info.positionSummary.map((l) => `   ${l}`).join('\n')}` : '';
  return [
    `${symbol} : ${info.openPositions} position(s) · ${info.pending} setup(s) en file · ${info.pocCount} POCs actifs`,
    `   dernier événement : ${info.lastEventAt ? dt(info.lastEventAt) : '—'}`,
  ].join('\n') + pos;
}

export { dt };
