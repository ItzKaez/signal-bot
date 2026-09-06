/**
 * Mise en forme Telegram des événements du moteur — messages PARLANTS :
 * chaque message porte la date/heure UTC de l'ÉVÉNEMENT dont il parle (et
 * non de l'envoi — indispensable en mode TEST où le passé est rejoué), une
 * phrase qui explique ce qui se passe, et l'action attendue.
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

/** Horodatage de l'événement (UTC) — toujours affiché. */
const when = (t: number): string => `🗓 ${dt(t)} UTC`;

/** Message complet d'un NOUVEAU SETUP : niveaux, AOI, TPs, RR + action. */
export function setupMessage(symbol: string, plan: TradePlan): string {
  return [
    `🎯 NOUVEAU SETUP · ${symbol} · ${plan.side === 'LONG' ? 'ACHAT' : 'VENTE'} ${tf(plan.executionSeconds)}`,
    when(plan.createdAt),
    '',
    `Le RSI ${tf(plan.executionSeconds)} a formé un peak à ${f1(plan.peakRsi)} (prix ${f0(plan.peakPrice)}) — retour attendu vers la liquidité.`,
    `POC d’entrée : ${f0(plan.entryPoc)} · AOI ${(plan.aoiPct * 100).toFixed(2)}% · borne SL : ${f0(plan.aoiBoundary)}`,
    '',
    `Entrées limites (DCA) : ${plan.entryLevels.map((l) => f0(l)).join(' / ')}`,
    `TPs : ${plan.targets.map((t) => f0(t.price)).join(' / ')}`,
    `RR→TP1 : ${f2(plan.rrToTp1)} · impulsion fib ${tf(plan.fibonacci?.timeframeSeconds ?? 0)}`,
    '',
    '→ Pose ces limites. Le stop se joue à la borne AOI ; le setup s’annule si le peak est cassé ou la divergence confirmée sans fill.',
  ].join('\n');
}

/** Explication d'une raison de clôture. */
function closeExplain(reason: string): string {
  if (reason.startsWith('tp')) return 'Objectif atteint — prise de profit partielle ou totale.';
  if (reason.includes('break_even')) return 'Sortie au break-even — le stop frais-couverts a été touché.';
  if (reason.includes('hard_stop')) return 'Stop dur 2×AOI touché — sortie en perte pleine.';
  if (reason.includes('wick')) return 'Stop sur la mèche adverse touché.';
  return 'Clôture de la position.';
}

/** Message de clôture d'un trade (couvre TPs, BE, SL mèche, hard stop). */
export function closeMessage(symbol: string, t: ClosedTrade): string {
  const pnl = t.pnl >= 0 ? `+${t.pnl.toFixed(2)}$` : `${t.pnl.toFixed(2)}$`;
  const hours = ((t.exitAt - t.entryAt) / 3600).toFixed(1);
  return [
    `${t.pnl >= 0 ? '✅' : '🔻'} CLÔTURE · ${symbol} · ${t.side === 'LONG' ? 'ACHAT' : 'VENTE'} (${t.reason})`,
    when(t.exitAt),
    '',
    `Entrée ${f0(t.averageEntry)} → sortie ${f0(t.exitPrice)} · ${t.fills} fill(s) · durée ${hours}h`,
    `P&L ${pnl} (frais ${t.fees.toFixed(2)}$)`,
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

/** Titre + explication par type d’événement (ce qui se passe / l’action). */
const EVENT_TEXT: Record<string, { title: string; explain: string }> = {
  plan_activated: {
    title: 'SETUP ACTIF',
    explain: 'Les limites sont posées au marché — en attente des fills. Surveille les messages suivants pour la gestion.',
  },
  dca_fill: {
    title: 'FILL',
    explain: 'Une limite d’entrée a été remplie : la position se construit, les limites restantes restent posées.',
  },
  breakeven_enabled: {
    title: 'BREAK-EVEN ARMÉ',
    explain: 'Le stop est déplacé au niveau frais-couverts : le trade ne peut plus être perdant. Les DCA restantes sont annulées.',
  },
  sl_wick: {
    title: 'SL SUR LA MÈCHE',
    explain: 'Stop posé sur la mèche adverse — actif à la bougie suivante. BE dès qu’une clôture repasse en profit.',
  },
  cancelled_unfilled: {
    title: 'SETUP ANNULÉ',
    explain: 'Invalidé avant tout fill — aucune position n’a été prise.',
  },
  limits_cancelled: {
    title: 'DCA ANNULÉES',
    explain: 'Invalidation partielle : les limites restantes sont retirées, la partie déjà remplie continue d’être gérée.',
  },
  ladder_upgrade: {
    title: 'MONTÉE DE REGARD',
    explain: 'Un setup d’un TF supérieur est disponible : on le surveille désormais. Entrées, stops et TPs restent ceux du plan d’origine.',
  },
  ladder_downgrade: {
    title: 'DESCENTE DE REGARD',
    explain: 'Le setup surveillé s’est invalidé : on surveille le TF inférieur. La gestion (plan d’origine) est inchangée.',
  },
  ladder_downgrade_late: {
    title: 'DESCENTE (tardive)',
    explain: 'Un setup inférieur est enfin disponible après l’invalidation — on le surveille maintenant.',
  },
  ladder_await_downgrade: {
    title: 'EN ATTENTE DE DESCENTE',
    explain: 'Setup surveillé invalidé sans candidat inférieur dispo : on reste en position, hard stop 2×AOI en filet.',
  },
};

// Événements DIAGNOSTIQUES (purges de file, attentes) : utiles en live
// (rarissimes), mais en rafale de mode TEST ce sont eux qui spamment et
// déclenchent les 429 — silencés quand quiet=true.
const QUIET_SKIP = new Set(['cancelled_unfilled', 'ladder_await_downgrade', 'waiting_margin']);

/** Événement de journal → message (null = à ne pas envoyer).
 *  quiet (mode TEST) : sans les événements de diagnostic. */
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
