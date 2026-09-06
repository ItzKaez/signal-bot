/**
 * Moteur stratégie V2 piloté par les INDICATEURS DE L'APP — la demande
 * fondatrice : les POCs sont ceux affichés sur le graphique (poc-engine
 * simulateMTFPOC, calculés sur dailyCandles + intradayCandles du store) et
 * les peaks/divergences RSI sont ceux de rsipeaks.ts (detectRsiPeaks), la
 * machine affichée sur le chart.
 *
 * Les règles d'exécution restent la référence validée : DCA sur groupes de
 * POC + 0.886, filtre RR, AOI ATR adaptatif, fibonacci golden pocket en
 * cascade 4h → 2×TF → TF, BE après TP1, stop de secours capé 2×AOI, stop
 * dur 2×AOI, purge de file, anti-zombie, priorité 2×TF > TF.
 *
 * incrémental : update() est appelé à chaque changement des bougies du store
 * (live OU replay) ; seules les bougies clôturées font avancer l'état.
 */

import { buildConfig, type StrategyV2Config } from './config';
import { ladderTfs, findUpgrade, findDowngrade, type LadderCandidate } from './mtf-ladder';
import { resampleCloseTime, type Bar, type Side } from './peaks';
import { atrWilderSeries } from './aoi';
import { planTrade, isTwin, extendAoiToPocGroups, groupLevels, type TradePlan } from './plans';
import { selectFibonacciDiag } from './fib';
import { RsiPeaksLiveFrame, ResampledCompletedFeeder, type LiveEvent } from './rsipeaks-live';
import type { Candle } from '../types';

export type { OverlaySpecV2, OverlayZone, OverlayLevel, StrategySnapshot, JournalEntry, ClosedTrade } from './engine';

import type { OverlaySpecV2, OverlayZone, OverlayLevel, StrategySnapshot, JournalEntry, ClosedTrade } from './engine';
export type { TradePlan } from './plans';

interface Fill {
  price: number;
  size: number;
  time: number;
}

interface Position {
  plan: TradePlan;
  /** Index du journal moteur au moment de l'activation — la tranche
   *  [journalStartIdx, fin] est figée dans le ClosedTrade final. */
  journalStartIdx: number;
  fills: Fill[];
  filledLevels: Set<number>;
  remainingSize: number;
  plannedSize: number;
  nextTarget: number;
  breakeven: boolean;
  /** Niveau du stop BE POSÉ (mode profit_close : moyenne pure ou niveau
   *  couvrant les frais, selon ce que la clôture permettait) — les autres
   *  modes le recalculent depuis la config à chaque bougie. */
  breakevenLevel: number | null;
  adverseCloses: number;
  divergenceConfirmed: boolean;
  awaitingDirectionCandle: boolean;
  emergencyStop: number | null;
  limitsCancelled: boolean;
  /** Ladder : gestion figée une fois fully filled — plus de changement
   *  de TF (SL mèche + BE comme d'habitude). */
  ladderFrozen?: boolean;
  /** Ladder : setup SURVEILLÉ (peak de référence, divergences, invalidation).
   *  null = on surveille le plan d'origine. Le plan d'ORIGINE (position.plan)
   *  reste TOUJOURS le plan d'exécution — limites, AOI, stops, TPs. */
  ladderRef?: TradePlan | null;
  /** Ladder : le setup surveillé a été INVALIDÉ sans candidat inférieur
   *  dispo à cet instant — on re-tente la descente à chaque bougie (les
   *  peaks inférieurs formés par le mouvement adverse entrent au pool
   *  quelques minutes plus tard). Hard stop 2×AOI en filet permanent. */
  ladderInvalidated?: boolean;
  /** SL posé sur la mèche adverse quand une div se confirme en loss —
   *  BE dès qu'une clôture repasse en profit. */
  wickStop: number | null;
  /** Bougie à partir de laquelle le stop protecteur (BE ou mèche) est
   *  ACTIF : posé à la clôture d'une bougie, il ne peut sortir qu'à partir
   *  de la bougie SUIVANTE — jamais sur la bougie qui l'a posé. */
  protectiveStopFrom: number | null;
  /** RSI de l'extrême de la dernière div vue sur notre peak de référence. */
  lastDivEndRsi: number | null;
  /** Temps de l'extrême de la dernière div (= le peak ré-armé, 3 drives). */
  lastDivDivergenceAt: number | null;
  /** Extrêmes de divs déjà traités par la position (dédup). */
  seenDivKeys: Set<number>;
  /** Peak de RÉFÉRENCE courant : le dernier peak joué (chaîne des 3-drives).
   *  Les divs et le SL mèche se jugent sur lui, pas sur le peak d'origine. */
  referencePeakAt: number;
  /** Bougie d'activation : l'ordre limite n'est placé qu'à la CLÔTURE de
   *  cette bougie — les fills ne peuvent survenir qu'à partir de la
   *  bougie SUIVANTE (la bougie de confirmation ne peut pas se remplir
   *  elle-même, même si sa mèche a balayé le POC). */
  activatedAt: number;
}

/** Peak converti depuis les markers de rsipeaks (confirmAt inféré : première
 *  bougie après le peak où le RSI repart hors zone — la transition de la
 *  machine). */
interface AppPeak {
  peakAt: number;
  confirmedAt: number;
  peakRsi: number;
  peakPrice: number;
  side: Side;
  executionSeconds: number;
}

interface AppDivergence {
  confirmedAt: number;
  peakAt: number;
  divergenceAt: number;
  divergenceWick: number;
  /** RSI au point extrême de la div : encore en zone OB/OS = 3 drives
   *  (un nouveau peak va se créer) ; hors zone = div finale. */
  divEndRsi: number;
  side: Side;
  directionCandleConfirmed: boolean;
}

interface AppInvalidation {
  at: number;
  side: Side;
  reason: 'rsi_breakout' | 'midline_age';
  executionSeconds: number;
}

function fillPrice(level: number, side: Side, slippage: number, entering: boolean): number {
  const direction = side === 'LONG' ? 1 : -1;
  const sign = entering ? direction : -direction;
  return level * (1 + sign * slippage);
}

function bisectLeft(sorted: number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Premier index avec sorted[i] > value (strictement après) — une
 *  invalidation À l'heure du peak appartient au peak PRÉCÉDENT (le breakout
 *  qui a créé ce peak), pas au peak lui-même. */
function bisectAfter(sorted: number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Contexte de dessin d'un plan : fenêtre (mode sélection → calée sur la
 *  sortie), fin des niveaux, échelle de base et bougies pour ancrer les
 *  diagonales de fib sur les vraies bougies du chart. */
interface PlanDrawCtx {
  windowEnd: number | null;
  end: number;
  baseIntervalSeconds: number;
  baseBars: ReadonlyArray<{ time: number; high: number; low: number }>;
  /** Niveaux d'entrée remplis (position ACTIVE uniquement — trade fermé : vide). */
  filledSet: Set<number>;
}

/** Dessine UN plan (zones AOI/GP, niveaux ENTRY/DCA/TP/SL, diagonale fib)
 *  dans les collections de l'overlay. Partagé par buildOverlay (live) et
 *  buildSinglePlanOverlay (trade de backtest sélectionné) — une seule source
 *  de vérité pour les règles de dessin. */
function drawPlanOverlay(
  plan: TradePlan,
  ctx: PlanDrawCtx,
  out: { zones: OverlayZone[]; levels: OverlayLevel[]; fibImpulseLines: OverlaySpecV2['fibImpulseLines'] }
): void {
  const { windowEnd, end, baseIntervalSeconds, baseBars, filledSet } = ctx;
  const start = plan.createdAt;
  // Diagonale de l'impulsion : swing low → swing high utilisés par la fib.
  // Les frames resamplées sont étiquetées à l'heure de CLÔTURE du groupe
  // (resampleCloseTime) alors que le chart positionne à l'heure d'OUVERTURE :
  // on retrouve la vraie bougie du chart portant l'extrême (mèche) en
  // scannant la plage du groupe. La frame du TF du chart garde ses labels
  // d'ouverture — rien à corriger dans ce cas.
  const exactExtremeTime = (label: number, timeframeSeconds: number, pickHigh: boolean): number => {
    if (timeframeSeconds <= baseIntervalSeconds) return label;
    const spanStart = label - timeframeSeconds;
    let bestTime = spanStart;
    let bestValue = pickHigh ? -Infinity : Infinity;
    for (const bar of baseBars) {
      if (bar.time < spanStart || bar.time >= label) continue;
      const value = pickHigh ? bar.high : bar.low;
      if (pickHigh ? value > bestValue : value < bestValue) { bestValue = value; bestTime = bar.time; }
    }
    return bestTime;
  };
  const fibTfLabel = plan.fibonacci.timeframeSeconds >= 3600 ? `${plan.fibonacci.timeframeSeconds / 3600}h` : `${plan.fibonacci.timeframeSeconds / 60}m`;
  out.fibImpulseLines.push({
    x1: exactExtremeTime(plan.fibonacci.swingLowAt, plan.fibonacci.timeframeSeconds, false),
    y1: plan.fibonacci.swingLow,
    x2: exactExtremeTime(plan.fibonacci.swingHighAt, plan.fibonacci.timeframeSeconds, true),
    y2: plan.fibonacci.swingHigh,
    color: '#f59e0b',
    label: `imp ${fibTfLabel}`,
  });
  // Largeur minimale de 10 bougies : la zone reste lisible dès l'apparition
  // du signal (fin potentiellement dans le futur, extrapolée au rendu),
  // puis suit la dernière bougie une fois celle-ci dépassée. En mode
  // sélection, la fenêtre est calée sur la sortie du trade.
  const zoneEnd = Math.max(windowEnd ?? end, start + 10 * baseIntervalSeconds);
  // Zones de fond uniquement (AOI + GP)
  out.zones.push({ start, end: zoneEnd, top: Math.max(plan.entryPoc, plan.aoiBoundary), bottom: Math.min(plan.entryPoc, plan.aoiBoundary), color: 'rgba(59, 130, 246, 0.15)', label: 'AOI' });
  out.zones.push({ start, end: zoneEnd, top: Math.max(plan.fibonacci.gpLow, plan.fibonacci.gpHigh), bottom: Math.min(plan.fibonacci.gpLow, plan.fibonacci.gpHigh), color: 'rgba(255, 215, 0, 0.20)', label: 'GP' });
  // Niveaux en TrendLine (comme les POC — texte auto-ajusté)
  // Entrée + DCAs : BLANCS tant qu'ils attendent, BLEUS une fois remplis.
  plan.entryLevels.forEach((lvl, i) => {
    const rounded = Math.round(lvl * 1e10) / 1e10;
    const filled = filledSet.has(rounded);
    out.levels.push({
      price: lvl,
      label: `${i === 0 ? 'ENTRY' : `DCA${i}`} ${lvl.toFixed(0)}${filled ? ' ✓' : ''}`,
      color: filled ? '#60a5fa' : '#e6edf3',
      // Texte inversé de la ligne : pastille blanche → texte bleu,
      // pastille bleue → texte blanc (sinon blanc sur blanc invisible).
      textColor: filled ? '#ffffff' : '#60a5fa',
      style: 'solid', start, end,
    });
  });
  plan.targets.forEach((tp, i) => {
    out.levels.push({ price: tp.price, label: `TP${i + 1} ${tp.price.toFixed(0)}`, color: '#22c55e', style: 'solid', start, end });
  });
  out.levels.push({ price: plan.aoiBoundary, label: `SL ${plan.aoiBoundary.toFixed(0)}`, color: '#ef4444', style: 'solid', start, end });
}

/** Événements d'armement du break-even dans une fenêtre [fromT, toT] —
 *  chaque entrée porte le niveau BE (prix = moyenne des fills au moment de
 *  l'armement). Sert à faire démarrer la ligne BE à la BOUGIE où elle a été
 *  posée, pas à la création du plan. */
export function beEventsIn(journal: ReadonlyArray<JournalEntry>, fromT: number, toT: number): JournalEntry[] {
  const out: JournalEntry[] = [];
  for (const e of journal) {
    if (e.t < fromT) continue;
    if (e.t > toT) break;
    if (e.type === 'breakeven_enabled' && e.price !== undefined) out.push(e);
  }
  return out;
}

/** Ligne BE d'un overlay : dashed jaune, DÉBUT à la bougie d'armement
 *  (premier événement du journal), niveau = dernier armement, FIN comme les
 *  autres niveaux (windowEnd). Poussée EN DERNIER → dessinée par-dessus
 *  les lignes pleines (entry incluse) : les pointillés restent visibles
 *  même à prix confondu. */
function pushBeLevel(levels: OverlayLevel[], be: JournalEntry[], end: number): void {
  if (be.length === 0) return;
  const price = be[be.length - 1].price!;
  levels.push({ price, label: `BE ${price.toFixed(0)}`, color: '#eab308', style: 'dashed', start: be[0].t, end, labelOffsetPx: -12 });
}

/** Overlay d'UN trade fermé (backtest) : exactement ce que buildOverlay
 *  dessine pour un trade sélectionné dans l'historique live — mêmes zones,
 *  mêmes niveaux, même fenêtre calée sur la sortie (exitAt + 4 bougies).
 *  baseBars = les bougies affichées par le chart, pour ancrer la diagonale
 *  de fib sur les mêmes extrêmes visibles qu'en live.
 *  journal = journal du run : permet de re-dessiner la ligne BE du trade
 *  fermé (la position n'existe plus) et de la faire démarrer à la bougie
 *  où le BE a été armé. */
export function buildSinglePlanOverlay(
  plan: TradePlan,
  opts: { exitAt: number; baseIntervalSeconds: number; baseBars: ReadonlyArray<{ time: number; high: number; low: number }>; journal?: ReadonlyArray<JournalEntry>; beFallback?: { price: number; startAt: number } | null }
): OverlaySpecV2 {
  const windowEnd = opts.exitAt + 4 * opts.baseIntervalSeconds;
  const end = opts.baseBars.length > 0 ? opts.baseBars[opts.baseBars.length - 1].time : windowEnd;
  const zones: OverlayZone[] = [];
  const levels: OverlayLevel[] = [];
  const fibImpulseLines: OverlaySpecV2['fibImpulseLines'] = [];
  drawPlanOverlay(plan, { windowEnd, end, baseIntervalSeconds: opts.baseIntervalSeconds, baseBars: opts.baseBars, filledSet: new Set<number>() }, { zones, levels, fibImpulseLines });
  // BE du trade fermé : reconstruit depuis le journal du run (la position
  // n'existe plus) — démarre à la bougie d'armement, dashed par-dessus.
  // FALLBACK anciens runs : journal tronqué (cap 2000 historique) mais trade
  // sorti en break-even → ligne dessinée à la moyenne d'entrée, démarrant
  // à la première sortie (BE armé au plus tard au 1er TP — approximation
  // honnête quand l'événement exact a disparu).
  const be = beEventsIn(opts.journal ?? [], plan.createdAt, opts.exitAt);
  if (be.length > 0) {
    pushBeLevel(levels, be, windowEnd);
  } else if (opts.beFallback) {
    levels.push({ price: opts.beFallback.price, label: `BE ${opts.beFallback.price.toFixed(0)}`, color: '#eab308', style: 'dashed', start: opts.beFallback.startAt, end: windowEnd, labelOffsetPx: -12 });
  }
  return {
    pocLines: [], peakMarkers: [], divergenceLines: [],
    fibImpulseLines, zones, levels,
    trades: [], journalMarkers: [],
  };
}

export class AppStrategyEngine {
  public readonly config: StrategyV2Config;
  private capital: number;
  private processedUntil = -1;
  private readonly journal: JournalEntry[] = [];
  private readonly trades: ClosedTrade[] = [];
  private pending: TradePlan[] = [];
  /** Positions ACTIVES simultanées (hedging) — chacune indépendante :
   *  fills, stops, TPs, break-even et peak de référence propres. Une seule
   *  en mode mono (hedgingEnabled=false). */
  private positions: Position[] = [];
  /** Plans ayant déjà loggé un 'waiting_margin' (anti-spam journal). */
  private readonly marginWaitLogged = new Set<string>();
  private readonly plannedPeaks = new Set<string>();

  // Événements dérivés des indicateurs (reconstruits à chaque update).
  private readonly divergenceEvents = new Map<string, AppDivergence[]>();
  private readonly invalidationsByTime = new Map<string, AppInvalidation[]>();
  private readonly invalidationTimes = new Map<string, number[]>();
  private readonly recentPeaks: AppPeak[] = [];
  private readonly recentDivergences: AppDivergence[] = [];
  private baseBars: Bar[] = [];
  /** Nombre de bougies de base "vues" par le moteur (fin de la fenêtre fib)
   *  — tracked dans update/warmup : en backtest, baseBars est l'array COMPLET
   *  (pas de slice par bougie) mais la fenêtre fib doit finir à la bougie
   *  COURANTE, jamais dans le futur. */
  private baseLen = 0;
  /** Frames d'exécution incrémentales (une par TF de config.executionSeconds,
   *  dans l'ordre de priorité de la config). Frame de base nourrie directement
   *  par les bougies ; frames resamplées via ResampledCompletedFeeder. */
  private execFrames: Array<{ seconds: number; frame: RsiPeaksLiveFrame; feeder: ResampledCompletedFeeder | null }> = [];
  /** POCs exacts de l'indicateur affiché sur le chart (via le store). */
  private storePocLevels: number[] = [];
  /** Meta par niveau (conc reelle du profil d'origine + TF) - filtres de confluence. */
  private storePocMeta: Map<number, { conc: number; tfSec: number }> = new Map();
  /** Plan sélectionné dans l'historique (clé createdAt|peakAt) : l'overlay
   *  n'affiche QUE lui. Null = comportement normal. */
  private selectedPlanKey: string | null = null;
  /** Peaks ignorés par la garde 3-drives (position vivante du même côté) :
   *  ils redeviennent éligibles dès que la position se ferme — typiquement
   *  le peak confirmé par la bougie qui nous stoppe. */
  private deferredPeaks: AppPeak[] = [];
  // ═══ LADDER MULTI-TF ═══ Candidats par TF (plans valides non activés) —
  // la sélection d'entrée, la montée et la descente en cascade y puisent.
  private ladderCandidates: LadderCandidate[] = [];
  /** Peaks libérés par releaseDeferredPeaks à la bougie N : leur plan est
   *  (re)créé au DÉBUT de la bougie N+1 — reproduit le batch, dont le
   *  rebuild de l'update N+1 re-livrait le marker historique une fois la
   *  clé de dédup retirée (la machine incrémentale, elle, ne ré-émet jamais
   *  un marker déjà émis). */
  private releasedPeaks: AppPeak[] = [];

  /** Sélectionne un plan de l'historique pour affichage isolé sur le chart. */
  setSelectedPlan(key: string | null): void {
    this.selectedPlanKey = key;
  }

  // Compteurs de diagnostic (affichés dans le panneau).
  public debug = { candles: 0, peaksDetected: 0, pocsAvailable: 0, plansCreated: 0, plansRejected: 0, fibFail: 0, aoiFail: 0, noPocForPeak: 0, rsiFiltered: 0, aoiFiltered: 0 };

  // Historique des signaux pour l'affichage (comme l'ancienne stratégie).
  public signalHistory: Array<{ plan: TradePlan; status: 'PENDING' | 'OPEN' | 'TP' | 'SL' | 'CANCELLED'; pnl: number; note?: string; tpsTaken?: number; pnlTotal?: number; feesTotal?: number; tpExits?: Array<{ tp: number; price: number; size: number; pnl: number }>; exitAt?: number }> = [];

  constructor(baseIntervalSeconds: number, capital = 10_000, configOverride?: Partial<StrategyV2Config>) {
    this.config = { ...buildConfig(baseIntervalSeconds), ...(configOverride ?? {}) };
    this.capital = capital;
    this.execFrames = this.config.executionSeconds.map((seconds) => {
      const frame = new RsiPeaksLiveFrame(this.config.rsiPeriod);
      const feeder = seconds === this.config.baseIntervalSeconds
        ? null
        : new ResampledCompletedFeeder(seconds, frame, this.config.baseIntervalSeconds);
      return { seconds, frame, feeder };
    });
  }

  setCapital(capital: number): void {
    this.capital = capital;
  }

  private log(t: number, type: string, price?: number, size?: number, note?: string): void {
    this.journal.push({ t, type, price, size, note });
    // Fenêtre largement agrandie (60k, trim amorti -10k) : à 2000, un run de
    // 3,7 ans évacuait les événements des vieux trades avant la fin — le
    // TradeLogPanel n'avait plus rien à montrer. ~60k entrées ≈ 6 Mo max.
    if (this.journal.length > 60000) this.journal.splice(0, this.journal.length - 50000);
  }

  /** Met à jour le statut d'un signal dans l'historique d'affichage. */
  private updateSignal(plan: TradePlan, status: 'PENDING' | 'OPEN' | 'TP' | 'SL' | 'CANCELLED', pnl?: number, note?: string): void {
    const entry = this.signalHistory.find((s) => s.plan === plan);
    if (entry) {
      entry.status = status;
      if (pnl !== undefined) entry.pnl = pnl;
      if (note) entry.note = note;
    }
  }

  /**
   * Warmup : ingère les bougies historiques pour initialiser les machines
   * (RSI peaks/divergences) SANS générer de signaux ni de trades. Les plans
   * créés pendant le warmup sont jetés — seuls les marqueurs de dédup
   * (plannedPeaks) et les maps d'événements persistent.
   */
  warmup(candles: Candle[], dailyCandles: Candle[], intradayCandles: Candle[]): void {
    if (candles.length === 0) return;
    this.baseBars = candles;
    this.baseLen = candles.length;
    // Nourrir les machines bougie par bougie : les événements s'accumulent
    // dans les maps (même contenu que l'unique rebuild du batch sur le warmup).
    for (const candle of candles) {
      this.feedBar(candle);
    }
    this.finishWarmup(candles[candles.length - 1], candles.length);
  }

  /** Fin commune des warmups : bornage processedUntil + purge des états de
   *  signaux du passé (les indicateurs restent chauds, les plans partent). */
  private finishWarmup(lastClosed: Candle, count: number): void {
    this.processedUntil = lastClosed.time;
    // Vider les plans/journal générés pendant le warmup : les indicateurs
    // sont chauds, mais les signaux du passé sont jetés.
    this.pending = [];
    this.positions = [];
    this.trades.length = 0;
    this.journal.length = 0;
    this.signalHistory.length = 0;
    this.deferredPeaks = [];
    // NE PAS vider plannedPeaks : les peaks historiques doivent rester marqués
    // comme "déjà vus" pour qu'aucun plan du passé ne soit recréé quand une
    // nouvelle bougie arrive.
    this.debug = { candles: 0, peaksDetected: 0, pocsAvailable: 0, plansCreated: 0, plansRejected: 0, fibFail: 0, aoiFail: 0, noPocForPeak: 0, rsiFiltered: 0, aoiFiltered: 0 };
    this.log(lastClosed.time, 'engine_ready', undefined, undefined, `engine initialized · ${count} warmup candles · signals from now on`);
  }

  /** Warmup NON-BLOQUANT : mêmes bougies, même état final que warmup() —
   *  mais nourri par chunks avec yields à l'event-loop pour que l'UI
   *  respire (35k bougies en synchrone gelait le panneau au Start).
   *  Résout sur le moteur une fois terminé. */
  async warmupAsync(
    candles: Candle[], dailyCandles: Candle[], intradayCandles: Candle[],
    onProgress?: (done: number, total: number) => void
  ): Promise<AppStrategyEngine> {
    if (candles.length === 0) { return this; }
    this.baseBars = candles;
    this.baseLen = candles.length;
    // Chunks plus PETITS (2000 → 800) : chaque burst main-thread est plus
    // court, plus de yields — le warmup 1 an reste ressenti mais sans
    // geler la fenêtre longtemps d'un coup.
    const CHUNK = 800;
    for (let i = 0; i < candles.length; i += CHUNK) {
      const end = Math.min(i + CHUNK, candles.length);
      for (let k = i; k < end; k++) this.feedBar(candles[k]);
      onProgress?.(end, candles.length);
      if (end < candles.length) await new Promise<void>((r) => setTimeout(r, 0));
    }
    this.finishWarmup(candles[candles.length - 1], candles.length);
    return this;
  }

  /**
   * @param candles bougies du store au TF du chart (live : la dernière est en
   *        formation ; replay : toutes clôturées via processAll)
   * @param processAll true en replay — traite aussi la dernière bougie.
   * @param upToTime borne TEMPORELLE du traitement : ne nourrir que les
   *        bougies de time <= upToTime (les suivantes restent pour les prochains
   *        appels). CRITIQUE en backtest : la boucle passe l'array COMPLET à
   *        chaque itération — sans borne, le premier update consommerait tout
   *        l'historique d'un coup, AVANT les injections POC des jours
   *        suivants (tous les plans naîtraient avec les POCs du jour 1).
   *
   * INCRÉMENTAL : seules les bougies postérieures à processedUntil sont
   * nourries (reprise par bissection, jamais de re-scan de l'historique).
   * Coût O(1) amorti par bougie — live et backtest.
   */
  update(candles: Candle[], dailyCandles: Candle[], intradayCandles: Candle[], processAll: boolean, upToTime?: number): void {
    if (candles.length === 0) return;
    const closed = processAll ? candles : candles.slice(0, -1);
    if (closed.length === 0) return;
    this.baseBars = closed;

    // Reprise par bissection : première bougie strictement après processedUntil.
    let lo = 0;
    let hi = closed.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (closed[mid].time <= this.processedUntil) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < closed.length; i++) {
      if (upToTime !== undefined && closed[i].time > upToTime) break;
      const candle = closed[i];
      this.baseLen = i + 1; // fenêtre fib : finit à la bougie courante (jamais le futur)
      this.flushReleasedPeaks();
      this.feedBar(candle);
      this.step(candle);
      this.processedUntil = candle.time;
    }
  }

  /** Nourrit une bougie de base dans toutes les frames d'exécution et
   *  transforme leurs événements en peaks/invalidations/divergences.
   *  Ordre intra-bougie : peaks et croix triés par temps (le batch traitait
   *  le tableau de markers trié), divs ensuite (maps par peak — la révision
   *  d'endpoint remplace l'entrée déjà stockée). */
  private feedBar(bar: Bar): void {
    const peaks: Array<{ seconds: number; ev: Extract<LiveEvent, { kind: 'peak' }> }> = [];
    for (const ef of this.execFrames) {
      const events = ef.feeder ? ef.feeder.feedBaseBar(bar) : ef.frame.feedFinalBar(bar);
      const marks: Array<{ time: number; run: () => void }> = [];
      for (const ev of events) {
        if (ev.kind === 'peak') {
          const seconds = ef.seconds;
          marks.push({ time: ev.peakAt, run: () => peaks.push({ seconds, ev }) });
        } else if (ev.kind === 'cross') {
          const cross = ev;
          marks.push({ time: cross.at, run: () => this.recordInvalidation(ef.seconds, cross) });
        } else {
          this.recordDivergence(ef.seconds, ef.frame, ev);
        }
      }
      marks.sort((a, b) => a.time - b.time);
      for (const m of marks) m.run();
    }
    for (const { seconds, ev } of peaks) this.createPeak(seconds, ev);
  }

  private createPeak(seconds: number, ev: Extract<LiveEvent, { kind: 'peak' }>): void {
    const side: Side = ev.isOB ? 'SHORT' : 'LONG';
    const peak: AppPeak = {
      peakAt: ev.peakAt,
      confirmedAt: ev.confirmedAt,
      peakRsi: ev.peakRsi,
      peakPrice: ev.peakPrice,
      side,
      executionSeconds: seconds,
    };
    this.recentPeaks.push(peak);
    this.maybeCreatePlan(peak);
  }

  private recordInvalidation(seconds: number, ev: Extract<LiveEvent, { kind: 'cross' }>): void {
    const event: AppInvalidation = {
      at: ev.at,
      side: ev.isOB ? 'SHORT' : 'LONG',
      reason: ev.isBreakout ? 'rsi_breakout' : 'midline_age',
      executionSeconds: seconds,
    };
    const timeKey = `${seconds}|${event.at}`;
    const byTime = this.invalidationsByTime.get(timeKey) ?? [];
    byTime.push(event);
    this.invalidationsByTime.set(timeKey, byTime);
    const sideKey = `${seconds}|${event.side}`;
    const times = this.invalidationTimes.get(sideKey) ?? [];
    times.push(event.at); // chronologique par construction → trié comme le batch
    this.invalidationTimes.set(sideKey, times);
  }

  private recordDivergence(seconds: number, frame: RsiPeaksLiveFrame, ev: Extract<LiveEvent, { kind: 'div' | 'div-revise' }>): void {
    const line = ev.line;
    const side: Side = line.isOB ? 'SHORT' : 'LONG';
    if (ev.kind === 'div-revise') {
      // Remplace l'endpoint de la div émise à la bougie précédente : le scan
      // ±1 du batch rebuild voyait la bougie future — on réplique son effet.
      const list = this.divergenceEvents.get(`${seconds}|${line.t1}`);
      if (list) {
        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i].divergenceAt === line.t2) { list[i].divEndRsi = line.p2_rsi; break; }
        }
      }
      return;
    }
    const t2 = frame.snapByTime(line.t2);
    const event: AppDivergence = {
      confirmedAt: line.t2,
      peakAt: line.t1,
      divergenceAt: line.t2,
      divergenceWick: t2 ? (side === 'SHORT' ? t2.high : t2.low) : line.t2_rsi,
      divEndRsi: line.p2_rsi,
      side,
      directionCandleConfirmed: t2
        ? side === 'SHORT'
          ? t2.close < t2.open
          : t2.close > t2.open
        : false,
    };
    const key = `${seconds}|${event.peakAt}`;
    const list = this.divergenceEvents.get(key) ?? [];
    list.push(event);
    this.divergenceEvents.set(key, list);
    this.recentDivergences.push(event);
  }

  /** Fenêtre glissante alignée aux pas fibonacci (buckets complets) pour les
   *  frames fib/AOI — bornée à fibWindowBars bougies de base, FINISSANT à la
   *  bougie courante (baseLen — jamais dans le futur). */
  private fibWindow(): Bar[] {
    const bars = this.baseBars;
    const len = Math.min(this.baseLen, bars.length);
    const cap = this.config.fibWindowBars;
    if (len <= cap) return bars.slice(0, len);
    const steps = [this.config.baseIntervalSeconds, ...this.config.fibonacciSeconds];
    let align = steps[0];
    for (const s of steps) {
      let a = align;
      let b = s;
      while (b !== 0) { const t = b; b = a % b; a = t; }
      align = (align / a) * s;
    }
    let start = len - cap;
    while (start < len && bars[start].time % align !== 0) start++;
    return bars.slice(start, len);
  }

  /**
   * POCs visibles : le moteur MTF POC de l'app (mêmes niveaux que le chart).
   * Coût maîtrisé : recompute UNE FOIS PAR JOUR de données (les états POC ne
   * changent qu'aux frontières de jours) et sur une fenêtre tronquée à 180
   * jours — simuler 1 000 jours × tout l'intraday à chaque tick figerait
   * l'interface.
   */
  /**
   * Injecte les POCs exacts de l'indicateur MTF POC affiché sur le chart.
   */
  setPocLevels(levels: number[], meta?: Map<number, { conc: number; tfSec: number }>): void {
    this.storePocLevels = levels;
    if (meta !== undefined) this.storePocMeta = meta;
  }

  private maybeCreatePlan(peak: AppPeak): void {
    const dedupKey = `${peak.executionSeconds}|${peak.peakAt}`;
    if (this.plannedPeaks.has(dedupKey)) return;
    this.plannedPeaks.add(dedupKey);
    this.debug.peaksDetected++;

    // Un peak du même côté qu'une position déjà REMPLIE fait partie du même
    // setup (3 drives en chaîne) : pas de nouveau plan ni de nouvelles
    // limites/AOI — c'est la gestion de la position qui prend le relais
    // (peak de référence chaîné, BE si profit, SL mèche + BE dès qu'on
    // peut). Les DCA en attente restent posées : le sweep du 3 drives peut
    // encore les remplir et améliorer la moyenne. Le peak est DIFFÉRÉ : si
    // la position se ferme (p.ex. la bougie qui le confirme nous stoppe),
    // il redevient éligible pour un vrai nouveau setup.
    if (!this.config.mtfLadderEnabled && this.positions.some((p) => p.plan.side === peak.side && p.fills.length > 0)) {
      this.deferredPeaks.push(peak);
      this.log(peak.confirmedAt, 'peak_3drive_ignored', peak.peakPrice, undefined,
        `${peak.side} RSI ${peak.peakRsi.toFixed(1)} · 3 drives of the current setup · same setup, no new limits (deferred while the position lives)`);
      return;
    }

    // Filtre d'extrémité RSI (0/off = V2 exact) : exiger une extrémité plus
    // profonde — les peaks tiédides sont du chop (rapport ETH 15m : RSI ext
    // 0-25 = +2372$, 25-30 = -1425$). Avant la recherche POC : économise tout
    // le travail aval sur les peaks filtrés.
    if (this.config.maxRsiExtremity < 100) {
      const rsiExt = peak.side === 'LONG' ? peak.peakRsi : 100 - peak.peakRsi;
      if (rsiExt > this.config.maxRsiExtremity) {
        this.debug.rsiFiltered++;
        this.log(peak.confirmedAt, 'peak_rejected', peak.peakPrice, undefined,
          `${peak.side} TF ${peak.executionSeconds / 60}min · filtered: RSI extremity ${rsiExt.toFixed(1)} > ${this.config.maxRsiExtremity} (not deep enough)`);
        return;
      }
    }

    const levels = this.storePocLevels;
    if (!levels || levels.length === 0) {
      this.debug.noPocForPeak++;
      this.log(peak.confirmedAt, 'peak_rejected', peak.peakPrice, undefined,
        `${peak.side} TF ${peak.executionSeconds / 60}min · rejected: no visible POC (MTF POC indicator missing from chart?)`);
      return;
    }
    this.debug.pocsAvailable = levels.length;

    // POC le plus proche au-delà du prix du peak (au-dessus pour un short).
    const direction = peak.side === 'LONG' ? 'below' : 'above';
    const candidates = levels.filter((level) => (direction === 'above' ? level > peak.peakPrice : level < peak.peakPrice));
    if (candidates.length === 0) {
      this.log(peak.confirmedAt, 'peak_rejected', peak.peakPrice, undefined,
        `${peak.side} TF ${peak.executionSeconds / 60}min · rejected: no POC ${direction === 'above' ? 'above' : 'below'} the peak (${peak.peakPrice.toFixed(1)})`);
      return;
    }
    const entryPoc = candidates.reduce((best, level) => (Math.abs(level - peak.peakPrice) < Math.abs(best - peak.peakPrice) ? level : best));

    // CONFLUENCE LIQUIDITE DE ZONE / TF : la liquidite se juge sur le
    // GROUPE de POCs autour de l'entree (l'etagere, meme groupement que les
    // DCA - minPocGroupSpacingPct), pas sur le seul POC le plus proche :
    // un POC dense un peu plus loin dans la meme zone rend le setup valide
    // (retour utilisateur : quand je parle de liquidite c'est DANS LA ZONE,
    // pas 1 POC en particulier). conc de chaque niveau = part du volume de
    // SON profil d'origine ; la zone = SOMME des membres du groupe.
    // POC sans meta (cache ancien) : passe.
    const pocMeta = this.storePocMeta.get(entryPoc);
    if (this.config.minPocConcentration > 0) {
      const zoneGroups = groupLevels(candidates, this.config.minPocGroupSpacingPct);
      const entryGroup = zoneGroups.find((g) => g.includes(entryPoc)) ?? [entryPoc];
      const zoneMetas = entryGroup
        .map((lvl) => this.storePocMeta.get(lvl))
        .filter((m): m is { conc: number; tfSec: number } => m !== undefined);
      if (zoneMetas.length > 0) {
        const zoneConc = this.config.pocZoneAgg === 'avg'
          ? zoneMetas.reduce((sum, m) => sum + m.conc, 0) / zoneMetas.length
          : this.config.pocZoneAgg === 'max'
            ? Math.max(...zoneMetas.map((m) => m.conc))
            : zoneMetas.reduce((sum, m) => sum + m.conc, 0);
        const bestConc = Math.max(...zoneMetas.map((m) => m.conc));
        if (zoneConc < this.config.minPocConcentration) {
          this.debug.plansRejected++;
          this.log(peak.confirmedAt, 'peak_rejected', peak.peakPrice, undefined,
            `${peak.side} TF ${peak.executionSeconds / 60}min · rejected: entry ZONE liquidity thin (zone conc ${(zoneConc * 100).toFixed(1)}% over ${entryGroup.length} POC(s), best ${(bestConc * 100).toFixed(1)}% < ${(this.config.minPocConcentration * 100).toFixed(1)}%)`);
          return;
        }
      }
    }
    if (pocMeta !== undefined) {
      if (this.config.minPocTfSec > 0 && pocMeta.tfSec < this.config.minPocTfSec) {
        this.debug.plansRejected++;
        this.log(peak.confirmedAt, 'peak_rejected', peak.peakPrice, undefined,
          `${peak.side} TF ${peak.executionSeconds / 60}min · rejected: entry POC TF too low (${Math.round(pocMeta.tfSec / 86400)}d < ${Math.round(this.config.minPocTfSec / 86400)}d)`);
        return;
      }
    }

    // Fenêtre glissante alignée aux pas fib (buckets complets) — remplace le
    // préfixe complet du batch : pivots/ATR identiques, mémoire bornée.
    const closed = this.fibWindow();

    // AOI adaptatif sur la frame d'exécution du peak (calculée AVANT la fib
    // car le RR 1:1 AOI→TP1 fait partie des conditions de sélection).
    const fibFrames = new Map<number, Bar[]>();
    for (const fibSeconds of this.config.fibonacciSeconds) {
      fibFrames.set(
        fibSeconds,
        fibSeconds === this.config.baseIntervalSeconds ? closed : resampleCloseTime(closed, fibSeconds)
      );
    }
    const execBars = fibFrames.get(peak.executionSeconds) ?? [];
    let peakIdx = -1;
    for (let i = execBars.length - 1; i >= 0; i--) {
      if (execBars[i].time === peak.peakAt) { peakIdx = i; break; }
    }
    if (peakIdx < 0) {
      this.debug.fibFail++;
      this.log(peak.confirmedAt, 'peak_rejected', peak.peakPrice, undefined,
        `${peak.side} TF ${peak.executionSeconds / 60}min · rejected: peak candle missing from execution frame`);
      return;
    }
    const atr = atrWilderSeries(execBars, this.config.aoiAtrLength);
    const atrAtPeak = atr[peakIdx];
    const closeAtPeak = execBars[peakIdx].close;
    if (atrAtPeak === null || closeAtPeak <= 0) {
      this.debug.aoiFail++;
      this.log(peak.confirmedAt, 'peak_rejected', peak.peakPrice, undefined,
        `${peak.side} TF ${peak.executionSeconds / 60}min · rejected: ATR unavailable at peak (insufficient history)`);
      return;
    }
    const from = Math.max(0, peakIdx - this.config.aoiAtmAdaptiveWindow + 1);
    let sum = 0;
    let count = 0;
    for (let i = from; i <= peakIdx; i++) {
      const value = atr[i];
      if (value !== null) { sum += value; count++; }
    }
    const baseline = count > 0 ? sum / count : atrAtPeak;
    const ratio = baseline > 0 ? atrAtPeak / baseline : 1;
    const multiplier = Math.min(3, Math.max(1, ratio * this.config.aoiAtmAdaptiveGain));
    const atrAoiPct = (atrAtPeak / closeAtPeak) * multiplier;

    // Extension POC : englober le(s) groupe(s) de POCs juste après l'entrée
    // (le mouvement vise les POCs), borné par un cap proportionnel à la
    // volatilité — un AOI minuscule ne remplirait jamais ses limites et
    // gonflerait le RR vers TP1 ; un mur infini de POCs est coupé au cap.
    const aoiCapPct = Math.min(atrAoiPct * this.config.aoiPocExtendCapX, this.config.aoiPocExtendMaxPct);
    let extendedPct = extendAoiToPocGroups(entryPoc, peak.side, levels, atrAoiPct, aoiCapPct, this.config.minPocGroupSpacingPct);
    // COUVERTURE NEWS-CANDLE (plancher RELATIF) : l'AOI couvre au moins
    // k × la plus grosse bougie des N dernières. Un setup né d'un spike de
    // news a une ATR héritée du régime mort ; sans cette couverture, la
    // bougie de news elle-même traverse le 1,5×AOI.
    if (this.config.aoiNewsCoverMult > 0 && this.baseBars.length >= 2) {
      const n = Math.min(this.config.aoiNewsCoverBars, this.baseBars.length - 1);
      let maxTr = 0;
      for (let i = this.baseBars.length - n; i < this.baseBars.length; i++) {
        const bar = this.baseBars[i];
        const prev = this.baseBars[i - 1];
        const tr = Math.max(bar.high - bar.low, Math.abs(bar.high - prev.close), Math.abs(bar.low - prev.close)) / bar.close;
        if (tr > maxTr) maxTr = tr;
      }
      const cover = this.config.aoiNewsCoverMult * maxTr;
      if (cover > extendedPct) extendedPct = cover;
    }
    // PLANCHER AOI : après ATR + englobement des groupes de POC, une zone
    // encore plus petite que minAoiFloorPct est élargie jusqu'à lui — pas de
    // rejet (cf. minAoiSizePct pour ça), la zone vit plus large : sizing
    // raisonnable, TPs en vrais R.
    const aoiPct = this.config.minAoiFloorPct > 0
      ? Math.max(extendedPct, this.config.minAoiFloorPct)
      : extendedPct;
    const aoiExtended = aoiPct > atrAoiPct * 1.05;

    // Filtre de taille d'AOI (0/off = V2 exact) : un AOI trop petit = risque
    // unitaire minuscule, limites remplies par du bruit, RR gonflé artifici
    // element (rapport ETH 15m : AOI <0.5% = -1064$, <1% = -413$).
    if (this.config.minAoiSizePct > 0 && aoiPct < this.config.minAoiSizePct) {
      this.debug.aoiFiltered++;
      this.log(peak.confirmedAt, 'peak_rejected', peak.peakPrice, undefined,
        `${peak.side} TF ${peak.executionSeconds / 60}min · filtered: AOI ${(aoiPct * 100).toFixed(2)}% < ${(this.config.minAoiSizePct * 100).toFixed(2)}% (too small, chop zone)`);
      return;
    }

    // Fibonacci multi-timeframe : la première (du 4h vers le TF du chart) dont
    // le golden pocket contient l'entrée ET dont le RR 1:1 AOI→TP1 passe.
    const aoiBoundary = peak.side === 'LONG' ? entryPoc * (1 - aoiPct) : entryPoc * (1 + aoiPct);
    const { plan: fib, diag: fibDiag } = selectFibonacciDiag(fibFrames, peak.confirmedAt, peak.side, entryPoc, aoiBoundary, levels, this.config);
    if (fib === null) {
      this.debug.fibFail++;
      const trail = fibDiag.map((d) => {
        const label = d.timeframeSeconds >= 3600 ? `${d.timeframeSeconds / 3600}h` : `${d.timeframeSeconds / 60}m`;
        const tested = d.candidates ?? 0;
        const count = tested > 0 ? `·${tested}${d.pool !== undefined && d.pool > tested ? `/${d.pool}` : ''}imp` : '';
        if (d.outcome === 'no_impulse') return `${label}:no impulse`;
        if (d.outcome === 'gp_miss') return `${label}:GP✗${d.gpLow!.toFixed(0)}-${d.gpHigh!.toFixed(0)}${count}`;
        return `${label}:RR✗${d.rr!.toFixed(2)}${count}`;
      }).join(' · ');
      this.log(peak.confirmedAt, 'peak_rejected', peak.peakPrice, undefined,
        `${peak.side} TF ${peak.executionSeconds / 60}min · fib rejected · entry ${entryPoc.toFixed(0)} · ${trail}`);
      return;
    }

    // FILTRE DE VOLATILITÉ (régime) : EWMA du TR% à pondération
    // exponentielle — une bougie récente pèse plus (alpha = 2/(N+1)).
    // Un spike unique au milieu d'un régime mort laisse l'EWMA basse →
    // setup rejeté : son AOI (ATR du régime mort) serait écrasée par
    // l'expansion post-news (sortie 1,5×AOI). Si la vol s'installe, l'EWMA
    // monte et les setups redeviennent admissibles avec une ATR saine.
    if (this.config.minVolatilityPct > 0 && this.baseBars.length >= 2) {
      const a = 2 / (this.config.volatilityLookbackBars + 1);
      let ew: number | null = null;
      const from = Math.max(1, this.baseBars.length - this.config.volatilityLookbackBars * 3);
      for (let i = from; i < this.baseBars.length; i++) {
        const bar = this.baseBars[i];
        const prev = this.baseBars[i - 1];
        const tr = Math.max(bar.high - bar.low, Math.abs(bar.high - prev.close), Math.abs(bar.low - prev.close)) / bar.close;
        ew = ew === null ? tr : a * tr + (1 - a) * ew;
      }
      if (ew !== null && ew < this.config.minVolatilityPct) {
        this.debug.plansRejected++;
        this.log(peak.confirmedAt, 'peak_rejected', peak.peakPrice, undefined,
          `${peak.side} TF ${peak.executionSeconds / 60}min · rejected: low volatility regime (EWMA TR ${(ew * 100).toFixed(3)}% < ${(this.config.minVolatilityPct * 100).toFixed(2)}%)`);
        return;
      }
    }
    const plan = planTrade(peak.confirmedAt, peak.peakAt, peak.side, peak.executionSeconds, entryPoc, levels, aoiPct, fib, this.config, {
      peakRsi: peak.peakRsi,
      peakPrice: peak.peakPrice,
      aoiDetail: { atr: atrAtPeak, atrPct: atrAtPeak / closeAtPeak, ratio, multiplier },
      pocDetail: null,
    });
    if (plan === null) {
      this.debug.plansRejected++;
      this.log(peak.confirmedAt, 'peak_rejected', peak.peakPrice, undefined,
        `${peak.side} TF ${peak.executionSeconds / 60}min · rejected: ${aoiPct <= 0 ? 'zero AOI at peak' : `RR to TP1 below minimum (${this.config.minRrToEffectiveTp1})`}`);
      return;
    }
    this.debug.plansCreated++;

    // Jumeaux inter-timeframes (le 2×TF prioritaire gagne).
    const twinWindow = this.config.executionSeconds[0];
    const twin =
      this.pending.find((other) => isTwin(other, plan, twinWindow)) ??
      this.positions.map((p) => p.plan).find((active) => isTwin(active, plan, twinWindow));
    if (twin) {
      const priorityIndex = (value: number) => this.config.executionSeconds.indexOf(value);
      if (priorityIndex(plan.executionSeconds) < priorityIndex(twin.executionSeconds)) {
        this.pending = this.pending.filter((other) => other !== twin);
        if (this.config.mtfLadderEnabled) {
          this.ladderCandidates = this.ladderCandidates.filter((c) => c.plan !== twin);
        }
        this.log(plan.createdAt, 'twin_replaced', undefined, undefined, 'priority twin replaces the secondary TF plan');
      } else {
        this.log(plan.createdAt, 'twin_ignored', undefined, undefined, 'twin ignored (priority TF already waiting/active)');
        return;
      }
    }
    // Dernier peak prioritaire : un nouveau plan du même côté (né du
    // ré-armement post-divergence — l'ancien peak a déjà divergé, schéma
    // 3 drives) REMPLACE les limites du plan plus ancien. On ne garde jamais
    // deux jeux de limites du même côté : seul le dernier peak doit être
    // joué. Ça vaut aussi pour la position ACTIVE sans aucun fill (limites
    // posées au marché mais jamais touchées) — aucune exposition, on peut
    // l'annuler proprement.
    const staleSidePlans = this.pending.filter((other) => other.side === plan.side);
    for (const old of staleSidePlans) {
      this.pending = this.pending.filter((other) => other !== old);
      // Le plan remplacé quitte AUSSI le pool ladder — sinon le candidat
      // fantôme (plan annulé) restait sélectionnable par findDowngrade.
      if (this.config.mtfLadderEnabled) {
        this.ladderCandidates = this.ladderCandidates.filter((c) => c.plan !== old);
      }
      this.updateSignal(old, 'CANCELLED', 0, 'replaced by the latest peak (the former diverged)');
      this.log(plan.createdAt, 'plan_replaced', old.entryPoc, undefined,
        `setup ${old.side} RSI ${old.peakRsi.toFixed(1)} cancelled (queue) · replaced by peak RSI ${plan.peakRsi.toFixed(1)} (divergence on the former)`);
    }
    for (const active of [...this.positions]) {
      if (active.plan.side !== plan.side || active.fills.length > 0) continue;
      // LADDER règle 1 : le TF le plus ÉLEVÉ gagne — un setup d'un TF
      // INFÉRIEUR ne remplace JAMAIS une position non remplie d'un TF
      // supérieur (elle garde ses limites, il attend en file).
      if (this.config.mtfLadderEnabled && plan.executionSeconds < active.plan.executionSeconds) continue;
      this.updateSignal(active.plan, 'CANCELLED', 0, 'replaced by the latest peak (the former diverged)');
      this.log(plan.createdAt, 'plan_replaced', active.plan.entryPoc, undefined,
        `setup ${active.plan.side} RSI ${active.plan.peakRsi.toFixed(1)} cancelled (active limits, no fill) · replaced by peak RSI ${plan.peakRsi.toFixed(1)}`);
      this.positions = this.positions.filter((p) => p !== active);
    }
    this.pending.push(plan);
    if (this.config.mtfLadderEnabled) {
      this.ladderCandidates.push({ plan, tfSec: plan.executionSeconds, side: plan.side, valid: true });
    }
    this.signalHistory.push({ plan, status: 'PENDING', pnl: 0 });
    this.pending.sort((a, b) => a.createdAt - b.createdAt);
    this.log(
      plan.createdAt,
      'plan_created',
      plan.entryPoc,
      undefined,
      `${plan.side} TF ${plan.executionSeconds / 60}min · fib ${plan.fibonacci.timeframeSeconds >= 3600 ? `${plan.fibonacci.timeframeSeconds / 3600}h` : `${plan.fibonacci.timeframeSeconds / 60}m`} · peak RSI ${plan.peakRsi.toFixed(1)} · POC ${plan.entryPoc.toFixed(1)} · AOI ${(plan.aoiPct * 100).toFixed(2)}%${aoiExtended ? ` (ATR ${(atrAoiPct * 100).toFixed(2)}% +POCs)` : ''} · RR ${plan.rrToTp1.toFixed(2)} · limites ${plan.entryLevels.map((l) => l.toFixed(0)).join('/')}`
    );
  }

  /** Armement du SL mèche autorisé ? 'immediate' = V2 ; 'after_tp1' = seulement
   *  après un TP touché ; 'off' = jamais (hard stop 2×AOI seul).
   *  NB : la CONFIRMATION DE DIVERGENCE en loss arme le SL mèche SANS passer
   *  par cette porte (règle utilisateur : protection immédiate à la div) —
   *  cette politique ne régit plus que l'invalidation par cassure du peak
   *  de référence. */
  private canArmWickStop(position: Position): boolean {
    if (this.config.wickStopMode === 'immediate') return true;
    if (this.config.wickStopMode === 'after_tp1') return position.nextTarget > 0;
    return false;
  }

  /** Niveau BE à remboursement EXACT des frais (breakevenCoverFees) :
   *  résout (sortie nette du solde restant) = 0 avec les MÊMES primitives
   *  que la sortie réelle (fillPrice + exitFees taker). Le slippage
   *  d'entrée est déjà dans `average` (prix de fill glissés).
   *  LONG  : exit = be·(1−slip) ; 0 = (exit−avg) − avg·feeIn − exit·feeOut
   *         → be = avg·(1+feeIn) / ((1−slip)·(1−feeOut))
   *  SHORT : exit = be·(1+slip) ; → be = avg·(1−feeIn) / ((1+slip)·(1+feeOut)) */
  /** Niveau du stop BE affichable ET exécutable (un seul point de vérité :
 *  journal 'breakeven_enabled', ligne jaune overlay et stop réel). */
  /** Niveau d'ARMEMENT du BE : en mode profit_close, ÉCHELLE — niveau
   *  couvrant les frais si la CLÔTURE l'atteint, sinon moyenne pure. Les
   *  autres modes utilisent le niveau classique. */
  private beArmLevel(side: Side, average: number, close: number): number {
    const fee = this.beStopLevel(side, average);
    if (this.config.breakevenMode !== 'profit_close') return fee;
    return side === 'LONG' ? (close >= fee ? fee : average) : (close <= fee ? fee : average);
  }

  /** Armement du BE = FIN du setup : les limites DCA restantes sont
   *  ANNULÉES (règle utilisateur : BE à la toute fin — plus de DCA en
   *  attente et div confirmée). Sinon une bougie qui revient remplit le DCA
   *  sous le BE et la position entière sort au stop au même moment. */
  private cancelRemainingLimitsAtBe(now: number, plan: TradePlan, position: Position): void {
    if (position.limitsCancelled) return;
    const remaining = plan.entryLevels.length - position.filledLevels.size;
    if (remaining <= 0) return;
    position.limitsCancelled = true;
    this.log(now, 'limits_cancelled', undefined, undefined, `BE armed · ${remaining} remaining DCA limit${remaining > 1 ? 's' : ''} removed (setup complete)`);
  }

  private beStopLevel(side: Side, average: number): number {
    return this.config.breakevenCoverFees
      ? this.breakevenLevel(side, average)
      : average * (side === 'LONG' ? 1 + this.config.breakevenOffsetPct : 1 - this.config.breakevenOffsetPct);
  }

  private breakevenLevel(side: Side, average: number): number {
    const slip = this.config.slippagePctPerFill;
    if (this.config.feeModel === 'maker_taker') {
      const feeIn = this.config.makerFeePct;
      const feeOut = this.config.takerFeePct;
      return side === 'LONG'
        ? (average * (1 + feeIn)) / ((1 - slip) * (1 - feeOut))
        : (average * (1 - feeIn)) / ((1 + slip) * (1 + feeOut));
    }
    const fee = this.config.feePctPerSide;
    return side === 'LONG'
      ? (average * (1 - fee)) / ((1 - slip) * (1 + fee))
      : (average * (1 + fee)) / ((1 + slip) * (1 - fee));
  }

  /** Frais d'une sortie : aller toujours payé (maker — entrée limite) ;
   *  retour maker pour un TP (limite), taker pour un stop/sortie forcée.
   *  feeModel 'flat' = feePctPerSide des deux côtés (V2). */
  private exitFees(entryPrice: number, exitPrice: number, size: number, makerExit: boolean): number {
    if (this.config.feeModel === 'maker_taker') {
      const exitFee = makerExit ? this.config.makerFeePct : this.config.takerFeePct;
      return entryPrice * size * this.config.makerFeePct + exitPrice * size * exitFee;
    }
    return (entryPrice + exitPrice) * size * this.config.feePctPerSide;
  }

  /** Mèche adverse extrême depuis un peak donné (bougie courante incluse),
   *  capée à `fallbackStopCapAoiMultiple` × AOI de la moyenne. */
  private adverseWickStop(side: Side, plan: TradePlan, fromPeakAt: number, average: number, now: number): number {
    let extreme = plan.peakPrice;
    for (const bar of this.baseBars) {
      if (bar.time >= fromPeakAt - this.config.baseIntervalSeconds && bar.time <= now) {
        if (side === 'LONG') extreme = Math.min(extreme, bar.low);
        else extreme = Math.max(extreme, bar.high);
      }
    }
    return side === 'LONG'
      ? Math.max(extreme, average * (1 - this.config.fallbackStopCapAoiMultiple * plan.aoiPct))
      : Math.min(extreme, average * (1 + this.config.fallbackStopCapAoiMultiple * plan.aoiPct));
  }

  private invalidationByTime(now: number, executionSeconds: number): AppInvalidation[] {
    return this.invalidationsByTime.get(`${executionSeconds}|${now}`) ?? [];
  }

  /** Libère les peaks différés : plus aucune position REMPLIE du même côté →
   *  ils redeviennent éligibles à un vrai nouveau setup (retrait de la dédup,
   *  recréation du plan à la bougie SUIVANTE via flushReleasedPeaks — cf.
   *  batch). En hedging, les peaks LONG et SHORT se libèrent indépendamment —
   *  fermer le LONG ne réarme pas les peaks du SHORT encore en vie. */
  private releaseDeferredPeaks(): void {
    if (this.deferredPeaks.length === 0) return;
    const stillDeferred: AppPeak[] = [];
    for (const peak of this.deferredPeaks) {
      if (this.positions.some((p) => p.plan.side === peak.side && p.fills.length > 0)) {
        stillDeferred.push(peak);
        continue;
      }
      this.plannedPeaks.delete(`${peak.executionSeconds}|${peak.peakAt}`);
      this.releasedPeaks.push(peak);
      this.log(peak.confirmedAt, 'deferred_peak_released', peak.peakPrice, undefined,
        `${peak.side} RSI ${peak.peakRsi.toFixed(1)} · position closed · the peak becomes a new setup`);
    }
    this.deferredPeaks = stillDeferred;
  }

  /** Recrée les plans des peaks libérés à la bougie précédente — AVANT les
   *  nouveaux événements de la bougie courante (le rebuild batch traitait
   *  les markers triés par temps : les peaks libérés, plus anciens, passaient
   *  avant ceux de la bougie courante). */
  private flushReleasedPeaks(): void {
    if (this.releasedPeaks.length === 0) return;
    const toCreate = this.releasedPeaks.sort((a, b) => a.peakAt - b.peakAt);
    this.releasedPeaks = [];
    for (const peak of toCreate) this.maybeCreatePlan(peak);
  }

  private purgeReason(plan: TradePlan, now: number): string | null {
    const times = this.invalidationTimes.get(`${plan.executionSeconds}|${plan.side}`) ?? [];
    // Strictement APRÈS le peak : une croix à l'heure du peak est celle du
    // peak précédent (le breakout qui a permis le ré-armement de celui-ci).
    const index = bisectAfter(times, plan.peakAt);
    if (index < times.length && times[index] < now) {
      return 'peak invalidated while waiting — stale setup, purged from queue';
    }
    for (const event of this.divergenceEvents.get(`${plan.executionSeconds}|${plan.peakAt}`) ?? []) {
      if (event.directionCandleConfirmed && event.confirmedAt < now) {
        return 'divergence confirmed without fill while waiting — setup purged';
      }
    }
    return null;
  }

  /** LADDER : basculer une position OUVERTE sur un autre plan (montée ou
   *  descente). Les fills déjà pris RESTENT (moyenne inchangée) ; les
   *  limites restantes de l'ancien plan disparaissent (elles ne sont plus
   *  surveillées) ; la gestion repart du nouveau plan — AOI, TPs fib,
   *  wick SL potentiel, BE. */
  /** LADDER : basculer le SETUP SURVEILLÉ d'une position OUVERTE (montée ou
   *  descente). Le plan d'ORIGINE reste INTÉGRAL — limites DCA restantes,
   *  AOI, hard stop 2×AOI, TPs fib, géométrie du SL mèche : l'exécution ne
   *  change JAMAIS de TF. Seul le REGARD bascule : peak de référence,
   *  divergences et invalidation se lisent désormais sur le setup du TF
   *  survolé. Le BE déjà armé n'est jamais desserré (il est indexé sur la
   *  moyenne réelle du trade, pas sur le setup surveillé). */
  private ladderSwitchRef(position: Position, refPlan: TradePlan, now: number, kind: 'upgrade' | 'downgrade', price: number): void {
    const oldTf = Math.round((position.ladderRef ?? position.plan).executionSeconds / 60);
    const newTf = Math.round(refPlan.executionSeconds / 60);
    this.log(now, `ladder_${kind}`, price, undefined,
      `${kind === 'upgrade' ? '⬆' : '⬇'} watching ${oldTf}m → ${newTf}m · plan ${Math.round(position.plan.executionSeconds / 60)}m kept (limits/AOI/stops/TPs unchanged)`);
    position.ladderRef = refPlan;
    position.referencePeakAt = refPlan.peakAt;
    position.ladderInvalidated = false;
    // L'état protecteur dérivé de l'ANCIEN setup survolé se ré-évaluera via
    // le nouveau (divergences, invalidation) ; le hard stop 2×AOI du plan
    // d'origine reste le filet permanent pendant ce temps.
    position.wickStop = null;
    position.emergencyStop = null;
    position.protectiveStopFrom = null;
    position.adverseCloses = 0;
  }

  /** LADDER : à la place du SL mèche, chercher un setup dans le TF juste
   *  inférieur (puis le suivant) AU SETUP SURVOLÉ. true = regard basculé
   *  (le trade continue), false = aucun candidat → SL mèche comme d'habitude. */
  private tryLadderDowngrade(position: Position, now: number, price: number): boolean {
    if (!this.config.mtfLadderEnabled) return false;
    if (!this.config.ladderDowngradeEnabled) return false;
    if (position.ladderFrozen) return false;
    const fullyFilled = position.filledLevels.size >= position.plan.entryLevels.length || position.limitsCancelled;
    if (fullyFilled) { position.ladderFrozen = true; return false; }
    const tfsDesc = ladderTfs(this.config.executionSeconds);
    const refSec = (position.ladderRef ?? position.plan).executionSeconds;
    const down = findDowngrade(this.ladderCandidates, position.plan.side, refSec, tfsDesc);
    if (!down) return false;
    this.ladderCandidates = this.ladderCandidates.filter((c) => c !== down);
    this.pending = this.pending.filter((p2) => p2 !== down.plan);
    this.ladderSwitchRef(position, down.plan, now, 'downgrade', price);
    return true;
  }

  /** Une descente est-elle POSSIBLE pour ce setup surveillé ? Il faut la
   *  cascade activée ET au moins un TF d'exécution sous le TF surveillé —
   *  sinon l'« attente de descente » n'aurait aucun sens (rien ne peut
   *  jamais venir) : gestion normale à l'invalidation. */
  private ladderDowngradePossible(position: Position): boolean {
    if (!this.config.mtfLadderEnabled || !this.config.ladderDowngradeEnabled) return false;
    const tfsDesc = ladderTfs(this.config.executionSeconds);
    const refSec = (position.ladderRef ?? position.plan).executionSeconds;
    return tfsDesc[tfsDesc.length - 1] < refSec;
  }

  /** LADDER règle 5 : un setup des DEUX TF les plus bas (1m/5m) ne peut être
   *  COMMENCÉ que si le RSI du TF le plus haut (30m) est DÉJÀ en zone — pas
   *  forcément un peak, au moins dans la bande : SHORT exige 30m OB (≥70),
   *  LONG exige 30m OS (≤30). Le plan reste en file : il activera quand la
   *  zone sera atteinte (ou périmera via l'invalidation/l'expiration). */
  private ladderLowTfZoneGated(plan: TradePlan): boolean {
    if (!this.config.mtfLadderEnabled) return false;
    const tfsDesc = ladderTfs(this.config.executionSeconds);
    if (tfsDesc.length < 3) return false;
    const lowTfs = tfsDesc.slice(-2);
    if (!lowTfs.includes(plan.executionSeconds)) return false;
    const topFrame = this.execFrames.find((f) => f.seconds === tfsDesc[0])?.frame;
    const rsi = topFrame?.latestSnap()?.val;
    if (rsi === undefined) return true; // RSI 30m pas encore formé → attendre
    return plan.side === 'SHORT' ? rsi < this.config.overbought : rsi > this.config.oversold;
  }

  private step(candle: Bar): void {
    const now = candle.time;
    // Position fermée à la bougie précédente → libérer les peaks différés
    // (le plan peut se créer et s'activer dès cette bougie).
    this.releaseDeferredPeaks();
    if (this.pending.length > 0) {
      const survivors: TradePlan[] = [];
      for (const plan of this.pending) {
        let reason = this.purgeReason(plan, now);
        // Expiration par âge : un setup qui n'a jamais activé en N bougies
        // est périmé (le mouvement visé a eu lieu sans nous).
        if (reason === null && this.config.limitExpiryBars > 0 &&
            (now - plan.createdAt) / this.config.baseIntervalSeconds >= this.config.limitExpiryBars) {
          reason = 'setup expired without activation — limit orders never placed';
        }
        if (reason === null) survivors.push(plan);
        else {
          this.log(now, 'cancelled_unfilled', candle.close, undefined, reason);
          this.updateSignal(plan, 'CANCELLED', 0, reason.slice(0, 40));
          if (this.config.mtfLadderEnabled) {
            this.ladderCandidates = this.ladderCandidates.filter((c) => c.plan !== plan);
          }
        }
      }
      this.pending = survivors;
    }

    // ═══ LADDER : montée + gel fully-filled + re-tente de descente ═══
    if (this.config.mtfLadderEnabled) {
      for (const position of this.positions) {
        const fullyFilled = position.filledLevels.size >= position.plan.entryLevels.length || position.limitsCancelled;
        if (fullyFilled) { position.ladderFrozen = true; continue; }
        if (position.ladderFrozen) continue;
        const refSec = (position.ladderRef ?? position.plan).executionSeconds;
        const up = findUpgrade(this.ladderCandidates, position.plan.side, refSec);
        if (up) {
          this.ladderCandidates = this.ladderCandidates.filter((c) => c !== up);
          this.pending = this.pending.filter((p2) => p2 !== up.plan);
          this.ladderSwitchRef(position, up.plan, candle.time, 'upgrade', candle.close);
          continue;
        }
        // Setup surveillé INVALIDÉ sans candidat dispo à l'époque → la
        // descente se re-tente à chaque bougie : les peaks inférieurs nés
        // du mouvement adverse entrent au pool quelques minutes après
        // l'invalidation. Fin de partie (BE ou SL mèche armé) → plus de
        // re-tente, la gestion normale prend le relais.
        if (position.ladderInvalidated && !position.breakeven && position.wickStop === null) {
          if (this.tryLadderDowngrade(position, now, candle.close)) {
            this.log(now, 'ladder_downgrade_late', candle.close, undefined, 'lower setup appeared after invalidation · watching it now');
          }
        }
      }
    }

    // ACTIVATION FIFO : en hedging, AUTANT de plans que les slots et la marge
    // le permettent (chacun devient une position indépendante) ; en mode
    // mono, une seule position à la fois — les suivantes attendent en file.
    while (this.pending.length > 0 && this.pending[0].createdAt <= now) {
      // UN trade à la fois : une position BE-armée reste VIVANTE (solde qui
      // court vers ses TPs) et occupe le slot jusqu'à sa sortie — le setup
      // en file démarre juste après sa clôture (BE touché / TP / stop).
      if (!this.config.hedgingEnabled && this.positions.length > 0) break;
      if (this.positions.length >= this.config.maxConcurrentPositions) break;
      // LADDER règle 1 : activer le setup du TF le PLUS ÉLEVÉ disponible
      // (pas FIFO) — un peak 15m avec un setup 30m jouable joue le 30m.
      // Règle 6 : les DÉBUTS de setup sont limités aux N TF les plus hauts
      // (défaut 2 = 30m/15m) — les setups 1m/5m ne sont JAMAIS des entrées
      // (la porte OB/OS règle 5 les rend de toute façon quasi impossibles ;
      // il faudra en plus une forte confluence de liquidité). Ils vivent en
      // file comme carburant de DESCENTE (downgrade) et meurent par leur
      // propre invalidation/expiration.
      let plan = this.pending[0];
      if (this.config.mtfLadderEnabled) {
        const entryTfs = ladderTfs(this.config.executionSeconds).slice(0, Math.max(1, this.config.ladderEntryTfCount));
        const eligible = this.pending.filter((p2) =>
          p2.createdAt <= now && entryTfs.includes(p2.executionSeconds) && !this.ladderLowTfZoneGated(p2));
        if (eligible.length === 0) break;
        plan = eligible.reduce((a, b) => (b.executionSeconds > a.executionSeconds ? b : a));
      }
      const worstAverage = plan.entryLevels.reduce((sum, level) => sum + level, 0) / plan.entryLevels.length;
      // Risque 1% ancré à la FIN de l'AOI (la borne affichée en SL) : la
      // distance réelle moyenne-pleine → borne AOI. Le hard stop 2×AOI reste
      // le filet ultime (risque max ~2% dans le pire des cas).
      const riskDistance = Math.abs(worstAverage - plan.aoiBoundary);
      let totalSize = riskDistance > 0 ? (this.capital * this.config.riskPerTradePct) / riskDistance : 0;
      // Marge : le notional des positions actives (limites posées incluses)
      // est déjà engagé — la nouvelle position est taillée dans le reste du
      // capital×levier×cap d'utilisation. En OUTRE, une seule position ne peut
      // pas consommer plus que `maxMarginSharePerPosition` du plafond : sans
      // ça, un setup à petit AOI (sizing risque-basé énorme) verrouille 100%
      // de la marge et le hedging ne peut plus jamais s'exprimer. Marge
      // épuisée → le setup RESTE en file (FIFO) et activera dès libération.
      const marginCap = this.capital * this.config.maxLeverage * this.config.marginUtilizationCap;
      const marginAvailable = Math.min(
        marginCap - this.usedNotional(),
        marginCap * this.config.maxMarginSharePerPosition
      );
      const marginSize = marginAvailable / worstAverage;
      if (marginSize <= 0) {
        const waitKey = `${plan.createdAt}|${plan.side}`;
        if (!this.marginWaitLogged.has(waitKey)) {
          this.marginWaitLogged.add(waitKey);
          this.log(now, 'waiting_margin', candle.close, undefined, `setup ${plan.side} held in queue · margin exhausted (${((this.usedNotional() / marginCap) * 100).toFixed(0)}% used) · waiting for a slot`);
        }
        break;
      }
      totalSize = Math.min(totalSize, marginSize);
      if (this.config.mtfLadderEnabled) {
        this.pending = this.pending.filter((p2) => p2 !== plan);
        this.ladderCandidates = this.ladderCandidates.filter((c) => c.plan !== plan);
      } else {
        this.pending.shift();
      }
      const position: Position = {
        plan, fills: [], filledLevels: new Set(), remainingSize: 0, plannedSize: totalSize,
        nextTarget: 0, breakeven: false, breakevenLevel: null, adverseCloses: 0,
        divergenceConfirmed: false, awaitingDirectionCandle: false, emergencyStop: null, limitsCancelled: false,
        wickStop: null, lastDivEndRsi: null, lastDivDivergenceAt: null, seenDivKeys: new Set(), referencePeakAt: plan.peakAt, protectiveStopFrom: null, activatedAt: now,
        // Début du journal de CE trade (immunisé contre la fenêtre glissante
        // du journal global : la tranche est figée à la clôture).
        journalStartIdx: this.journal.length,
      };
      this.positions.push(position);
      this.log(now, 'plan_activated', undefined, undefined, `${plan.side} TF ${plan.executionSeconds / 60}min, planned size ${totalSize.toFixed(4)}${this.positions.length > 1 ? ` · hedging: position #${this.positions.length}` : ''}`);
      this.updateSignal(plan, 'PENDING');
      // Pas de rattrapage des divs ici : le traitement unifié ci-dessous
      // (divergences passées non vues) rattrape tout au premier pas.
      const staleTimes = this.invalidationTimes.get(`${plan.executionSeconds}|${plan.side}`) ?? [];
      // Strictement après le peak (cf. purgeReason) : la croix du peak
      // précédent à l'heure de naissance de ce peak ne le périmène pas.
      const staleIndex = bisectAfter(staleTimes, plan.peakAt);
      if (staleIndex < staleTimes.length && staleTimes[staleIndex] < now) {
        this.log(now, 'cancelled_unfilled', candle.close, undefined, 'peak invalidated before activation — stale setup');
        this.updateSignal(plan, 'CANCELLED', 0, 'Peak invalidated');
        this.closePosition(position);
      }
    }

    for (const position of [...this.positions]) {
      this.stepPosition(position, candle);
    }
  }

  /** Notional cumulé engagé par les positions actives — exposition PLEINE
   *  (limites non fillées incluses : elles restent posées au marché). */
  private usedNotional(): number {
    let sum = 0;
    for (const p of this.positions) {
      const avg = p.fills.length > 0
        ? p.fills.reduce((s, f) => s + f.price * f.size, 0) / p.fills.reduce((s, f) => s + f.size, 0)
        : p.plan.entryLevels.reduce((s, level) => s + level, 0) / p.plan.entryLevels.length;
      sum += p.plannedSize * avg;
    }
    return sum;
  }

  /** Retire une position fermée et libère les peaks différés de son côté. */
  private closePosition(position: Position): void {
    this.positions = this.positions.filter((p) => p !== position);
    this.releaseDeferredPeaks();
  }

  /** Gestion d'UNE position sur une bougie — totalement indépendante des
   *  autres (hedging) : divergences, fills DCA, stops protecteurs, TPs,
   *  break-even. Aucune interférence avec les positions voisines. */
  private stepPosition(position: Position, candle: Bar): void {
    const now = candle.time;
    const plan = position.plan;
    const side = plan.side;

    let divJustConfirmed = false;
    // LADDER : divergences et invalidation se lisent sur le setup SURVEILLÉ
    // (ladderRef), le plan d'origine ne sert que d'exécution.
    const watchSec = (position.ladderRef ?? plan).executionSeconds;
    for (const event of this.divergenceEvents.get(`${watchSec}|${position.referencePeakAt}`) ?? []) {
      // Une div n'apparaît dans la machine qu'à la bougie SUIVANTE de son
      // extrême : on traite donc tout événement passé non encore vu (dédup
      // par extrême), pas seulement confirmedAt === now.
      if (event.confirmedAt > now) continue;
      if (position.seenDivKeys.has(event.divergenceAt)) continue;
      position.seenDivKeys.add(event.divergenceAt);
      position.lastDivEndRsi = event.divEndRsi;
      position.lastDivDivergenceAt = event.divergenceAt;
      if (event.directionCandleConfirmed) {
        position.divergenceConfirmed = true;
        position.awaitingDirectionCandle = false;
        divJustConfirmed = true;
        this.log(now, 'divergence_confirmed', candle.close, undefined, 'divergence confirmed (candle closed in our direction)');
      } else {
        position.awaitingDirectionCandle = true;
        this.log(now, 'awaiting_direction_candle', candle.close, undefined, 'divergence detected, waiting for direction candle');
      }
    }
    // FILLS : l'ordre limite n'est en place qu'à partir de la bougie
    // SUIVANT l'activation — la bougie de confirmation du peak ne peut pas
    // se remplir elle-même. Une limite se remplit intrabar dès que le prix
    // la touche.
    const limitsLive = now > position.activatedAt;
    if (limitsLive && position.fills.length === 0 && plan.entryLevels.length > 0) {
      const firstLevel = plan.entryLevels[0];
      // Condition SIDE-AWARE (même règle que le fill réel) : pour un LONG la
      // limite se touche par le BAS (low <= level) — l'ancien log testait
      // high >= level, vrai dès que le prix est AU-DESSUS de la limite d'achat,
      // affichant des "TOUCHED!" trompeurs sans aucun fill.
      const touched = side === 'LONG' ? candle.low <= firstLevel : candle.high >= firstLevel;
      // Log UNIQUEMENT au toucher (le « not touched » par bougie inondait le
      // journal : ~1 événement/bougie tant que la position attendait son fill).
      if (touched) {
        this.log(now, 'fill_check', candle.close, undefined,
          `H=${candle.high.toFixed(1)} L=${candle.low.toFixed(1)} · limit=${firstLevel.toFixed(1)} · TOUCHED`);
      }
    }
    const fillSize = position.plannedSize / plan.entryLevels.length;
    for (let order = 0; limitsLive && order < plan.entryLevels.length; order++) {
      const level = plan.entryLevels[order];
      const rounded = Math.round(level * 1e10) / 1e10;
      if (position.filledLevels.has(rounded)) continue;
      if (position.limitsCancelled) break;
      const hit = side === 'LONG' ? candle.low <= level : candle.high >= level;
      if (hit) {
        const price = fillPrice(level, side, this.config.slippagePctPerFill, true);
        position.fills.push({ price, size: fillSize, time: now });
        position.remainingSize += fillSize;
        position.filledLevels.add(rounded);
        this.log(now, 'dca_fill', price, fillSize, `DCA${order + 1} limit @ ${level.toFixed(1)}`);
        // Mettre à jour le signal avec le statut fill et le prix de fill.
        this.updateSignal(plan, 'OPEN', undefined, `Fill @ ${price.toFixed(1)} (${order + 1}/${plan.entryLevels.length})`);
      }
    }

    // APRÈS les fills : anti-zombie (divergence confirmée sans fill → annuler).
    if (position.divergenceConfirmed && position.fills.length === 0) {
      this.log(now, 'cancelled_unfilled', candle.close, undefined, 'divergence confirmed without any fill — setup cancelled');
      this.updateSignal(plan, 'CANCELLED', 0, 'Div without fill');
      this.closePosition(position);
      return;
    }
    if (position.awaitingDirectionCandle) {
      const directionCandle = side === 'LONG' ? candle.close > candle.open : candle.close < candle.open;
      if (directionCandle) {
        position.divergenceConfirmed = true;
        position.awaitingDirectionCandle = false;
        divJustConfirmed = true;
        this.log(now, 'divergence_confirmed', candle.close, undefined, 'direction candle closed');
      }
    }

    // Invalidation sur setup non fillé : limites retirées.
    if (position.fills.length === 0) {
      const events = this.invalidationByTime(now, plan.executionSeconds);
      const expired = this.config.limitExpiryBars > 0 &&
        (now - plan.createdAt) / this.config.baseIntervalSeconds >= this.config.limitExpiryBars;
      if (events.some((event) => event.side === side) || expired) {
        this.log(now, 'cancelled_unfilled', candle.close, undefined, expired ? 'limit expiry — setup too old' : 'invalidation — limits removed');
        this.updateSignal(plan, 'CANCELLED', 0, expired ? 'Expiry' : 'Invalidation');
        this.closePosition(position);
        return;
      }
    }

    if (position.fills.length === 0) return;

    const average = position.fills.reduce((sum, fill) => sum + fill.price * fill.size, 0) /
      position.fills.reduce((sum, fill) => sum + fill.size, 0);

    // ─── État protecteur AU DÉBUT de la bougie ───
    // La bougie courante est jugée par le stop armé à la clôture d'une bougie
    // PRÉCÉDENTE (BE ou SL mèche), mèche incluse. Les arrêts posés à la
    // clôture de CETTE bougie ne s'activeront qu'à la suivante — et ne peuvent
    // pas désarmer le stop déjà actif : intra-bougie la mèche précède la
    // clôture, donc une clôture en profit qui arme le BE ne masque pas une
    // mèche qui touche le SL actif. Le SL d'abord, le BE ensuite.
    const beAtOpen = position.breakeven;
    const wickAtOpen = position.wickStop;
    const activeAtOpen = position.protectiveStopFrom !== null && now > position.protectiveStopFrom;
    const activeWickTouched = activeAtOpen && wickAtOpen !== null &&
      (side === 'LONG' ? candle.low <= wickAtOpen : candle.high >= wickAtOpen);

    // ─── Stop à la confirmation de divergence (mode on_divergence) ───
    // Div confirmée = une bougie a clôturé dans notre sens, position remplie :
    //  · en profit → BE immédiat (moyenne).
    //  · en loss → SL sur la mèche adverse (depuis le peak, cap 2×AOI) et
    //    BE dès qu'une clôture repasse en profit.
    //  · 3 drives : si l'extrême de la div est ENCORE en zone OB/OS, un
    //    nouveau peak va se créer — BE seulement si fully filled ET profit ;
    //    sinon on attend la div finale (extrême hors zone) pour le
    //    traitement complet.
    const beArmOnDiv = this.config.breakevenMode === 'on_divergence' || this.config.breakevenMode === 'profit_close';
    if (beArmOnDiv && divJustConfirmed && !position.breakeven) {
      const inProfit = side === 'LONG' ? candle.close > average : candle.close < average;
      const divEndInZone = position.lastDivEndRsi !== null &&
        (side === 'LONG' ? position.lastDivEndRsi <= this.config.oversold : position.lastDivEndRsi >= this.config.overbought);
      const fullyFilled = position.filledLevels.size >= plan.entryLevels.length || position.limitsCancelled;
      if (divEndInZone) {
        // 3 drives : l'extrême de la div est encore en zone → un nouveau
        // peak vient d'être ré-armé par l'indicateur. Il devient le peak de
        // RÉFÉRENCE du trade (les divs suivantes se jugent sur lui) — la
        // chaîne peut s'enchaîner autant de fois que les 3-drives continuent
        // (mèches plus hautes, RSI plus bas).
        if (position.lastDivDivergenceAt !== null) {
          position.referencePeakAt = position.lastDivDivergenceAt;
          this.log(now, 'reference_peak_moved', candle.close, undefined,
            `3 drives · reference peak → ${new Date(position.referencePeakAt * 1000).toLocaleTimeString()} · waiting for its divergence`);
        }
        if (inProfit && fullyFilled && !activeWickTouched) {
          position.breakeven = true;
          position.breakevenLevel = this.beArmLevel(side, average, candle.close);
          position.protectiveStopFrom = now;
          this.cancelRemainingLimitsAtBe(now, plan, position);
          this.log(now, 'breakeven_enabled', position.breakevenLevel, undefined, `3 drives (div extreme still in zone, RSI ${position.lastDivEndRsi!.toFixed(1)}) · fully filled · stop at ${position.breakevenLevel.toFixed(1)} (active next candle)`);
        } else if (!inProfit && this.config.wickStopMode !== 'off') {
          // Div confirmée en LOSS (3 drives) : SL sur la mèche adverse
          // TOUJOURS — la politique wickStopMode after_tp1 ne s'applique
          // PAS à la confirmation de divergence (règle utilisateur : la
          // protection ne doit jamais attendre un TP). BE dès qu'une
          // clôture repasse en profit (bloc dédié ci-dessous). En LADDER
          // avec cascade active, la descente se tente d'abord.
          if (!this.tryLadderDowngrade(position, now, candle.close)) {
            const wick = this.adverseWickStop(side, plan, position.referencePeakAt, average, now);
position.wickStop = position.wickStop === null ? wick : (side === 'LONG' ? Math.max(position.wickStop, wick) : Math.min(position.wickStop, wick));
            position.protectiveStopFrom = now;
            this.log(now, 'sl_wick', wick, undefined, `3 drives confirmed at a loss · SL on adverse wick (${wick.toFixed(1)}) · active next candle · BE on first profitable close`);
          }
        }
        // inProfit sans fullyFilled : on garde le stop courant — les DCA en
        // attente peuvent encore se remplir au-dessus et améliorer la moyenne.
      } else if (inProfit && !activeWickTouched) {
        // Div FINALE (plus de 3d possible) : on ne joue QUE la dernière
        // div — BE immédiat et ANNULATION des limites DCA restantes (fin du
        // setup : plus aucune nouvelle exposition).
        position.breakeven = true;
        position.breakevenLevel = this.beArmLevel(side, average, candle.close);
        position.protectiveStopFrom = now;
        this.cancelRemainingLimitsAtBe(now, plan, position);
        this.log(now, 'breakeven_enabled', position.breakevenLevel, undefined, `final divergence confirmed in profit · stop at ${position.breakevenLevel.toFixed(1)}${position.breakevenLevel !== average ? ' (frais couverts)' : ' (moyenne)'} (active next candle)`);
      } else if (this.config.wickStopMode !== 'off') {
        // Div FINALE confirmée en LOSS : SL sur la mèche adverse TOUJOURS
        // (cap 2×AOI de la moyenne) — pas de condition TP1 ici non plus.
        // BE dès qu'une clôture repasse en profit.
        if (!this.tryLadderDowngrade(position, now, candle.close)) {
          const wick = this.adverseWickStop(side, plan, position.referencePeakAt, average, now);
position.wickStop = position.wickStop === null ? wick : (side === 'LONG' ? Math.max(position.wickStop, wick) : Math.min(position.wickStop, wick));
          position.protectiveStopFrom = now;
          this.log(now, 'sl_wick', wick, undefined, `div confirmed at a loss · SL on adverse wick (${wick.toFixed(1)}) · active next candle · BE on first profitable close`);
        }
      }
    }
    // Après un SL mèche : BE dès qu'une clôture repasse en profit — sauf si
    // la mèche de cette même bougie touche le SL actif : la mèche précède la
    // clôture, le SL a priorité (la sortie SL est faite par le check
    // ci-dessous, jugé sur l'état au début de la bougie).
    if (beArmOnDiv && position.wickStop !== null && !position.breakeven) {
      const inProfit = side === 'LONG' ? candle.close > average : candle.close < average;
      if (inProfit && !activeWickTouched) {
        position.breakeven = true;
        position.breakevenLevel = this.beArmLevel(side, average, candle.close);
        position.protectiveStopFrom = now;
        this.cancelRemainingLimitsAtBe(now, plan, position);
        this.log(now, 'breakeven_enabled', position.breakevenLevel, undefined, `profitable close after wick SL · stop at ${position.breakevenLevel.toFixed(1)}${position.breakevenLevel !== average ? ' (frais couverts)' : ' (moyenne)'} (active next candle)`);
      }
    }
    // ─── BE ÉCHELLE — UPGRADE (mode profit_close) ───
    // L'ARMEMENT suit les moments canoniques ci-dessus (div confirmée en
    // profit, retour en profit après SL mèche) — PAS toute clôture en
    // profit : la bougie de CONFIRMATION est précisément celle du pullback ;
    // un BE armé avant elle se fait sortir par ce pullback (fill DCA1 →
    // close en profit → BE → bougie suivante descend, remplit DCA2, confirme
    // la div… et sort en BE avant d'avoir vécu). Une fois armé, chaque
    // clôture atteignant le niveau frais-couverts RELÈVE le stop (jamais
    // desserré).
    if (this.config.breakevenMode === 'profit_close' && position.breakeven && position.breakevenLevel !== null) {
      const feeLevelL = this.beStopLevel(side, average);
      const canCover = side === 'LONG' ? candle.close >= feeLevelL : candle.close <= feeLevelL;
      if (canCover) {
        const curL = position.breakevenLevel;
        const better = side === 'LONG' ? feeLevelL > curL : feeLevelL < curL;
        if (better) {
          position.breakevenLevel = feeLevelL;
          this.log(now, 'breakeven_enabled', feeLevelL, undefined, `BE upgrade · stop at ${feeLevelL.toFixed(1)} (frais couverts) (active next candle)`);
        }
      }
    }

    // Invalidation lue sur le setup SURVEILLÉ (ladderRef en mode ladder).
    const invalidationEvents = this.invalidationByTime(now, watchSec);
    const invalidation = invalidationEvents.find((event) => event.side === side);
    if (invalidation && !position.breakeven) {
      // Invalidation EN PROFIT (règle utilisateur : div cassée/peak broken +
      // profit → BE immédiat, sans attendre TP1) : le setup est mort, on
      // verrouille — BE frais-couverts + annulation des limites restantes.
      const inProfitNow = side === 'LONG' ? candle.close > average : candle.close < average;
      if (inProfitNow && !activeWickTouched) {
        position.breakeven = true;
        position.breakevenLevel = this.beArmLevel(side, average, candle.close);
        position.protectiveStopFrom = now;
        this.cancelRemainingLimitsAtBe(now, plan, position);
        this.log(now, 'breakeven_enabled', position.breakevenLevel, undefined, `invalidation (${invalidation.reason}) in profit · stop at ${position.breakevenLevel.toFixed(1)}${position.breakevenLevel !== average ? ' (frais couverts)' : ' (moyenne)'} (active next candle)`);
      }
    }
    if (invalidation && (this.config.mtfLadderEnabled || this.canArmWickStop(position))) {
      // Peak de RÉFÉRENCE cassé (breakout/midline/âge) : même règle que la
      // div confirmée en loss — SL sur la mèche adverse depuis le peak de
      // référence (cap 2×AOI), BE dès qu'une clôture est en profit. En
      // LADDER la descente se tente SANS condition de TP.
      if (!this.tryLadderDowngrade(position, now, candle.close)) {
        if (this.canArmWickStop(position)) {
          const wick = this.adverseWickStop(side, plan, position.referencePeakAt, average, now);
position.wickStop = position.wickStop === null ? wick : (side === 'LONG' ? Math.max(position.wickStop, wick) : Math.min(position.wickStop, wick));
          position.protectiveStopFrom = now;
          this.log(now, 'sl_wick', wick, undefined, `reference peak broken (${invalidation.reason}) · SL on wick (${wick.toFixed(1)}) · active next candle · BE on first profitable close`);
        } else {
          if (this.ladderDowngradePossible(position)) {
            position.ladderInvalidated = true;
            this.log(now, 'ladder_await_downgrade', candle.close, undefined, `reference peak broken (${invalidation.reason}) · no lower setup available yet · watching for one (hard stop as backstop)`);
          }
        }
      }
    }
    if (invalidation && this.config.cancelLimitsOnPartialInvalidation && !position.limitsCancelled) {
      position.limitsCancelled = true;
      // Message seulement s'il RESTE des limites à annuler — une position
      // fully filled n'a rien en attente (sinon message trompeur).
      if (position.filledLevels.size < plan.entryLevels.length) {
        this.log(now, 'limits_cancelled', undefined, undefined, 'invalidation: remaining DCA limits removed');
      }
    }

    const forcedLevel = side === 'LONG'
      ? average * (1 - this.config.forcedExitAoiMultiple * plan.aoiPct)
      : average * (1 + this.config.forcedExitAoiMultiple * plan.aoiPct);
    const adverseClose = side === 'LONG' ? candle.close < forcedLevel : candle.close > forcedLevel;
    position.adverseCloses = adverseClose && !position.breakeven ? position.adverseCloses + 1 : 0;
    if (position.adverseCloses > 0) {
      this.log(now, 'adverse_close', candle.close, undefined, `${position.adverseCloses} close(s) beyond 2×AOI (${forcedLevel.toFixed(1)})`);
    }

    // Stop protecteur (BE ou mèche) : jugé sur l'état AU DÉBUT de la bougie
    // (snapshot) — posé à la CLÔTURE d'une bougie, il n'est actif qu'à partir
    // de la bougie SUIVANTE ; la bougie qui l'a posé ne peut pas se sortir
    // elle-même (sa mèche a servi à le calculer), et un armement fait à la
    // clôture de la bougie courante ne désarme pas le stop déjà actif.
    // Stop BE : moyenne + offset optionnel (0 = moyenne exacte, V2). L'offset
    // décale le stop DANS le sens du trade — une sortie BE remboursant les
    // frais au lieu de les perdre.
    const beLevel = this.config.breakevenMode === 'profit_close' && position.breakevenLevel !== null
      ? position.breakevenLevel
      : this.beStopLevel(side, average);
    let stop: number | null = position.emergencyStop;
    if (activeAtOpen && beAtOpen) stop = beLevel;
    else if (activeAtOpen && wickAtOpen !== null) stop = wickAtOpen;
    const hardLevel = side === 'LONG'
      ? average * (1 - this.config.hardExitAoiMultiple * plan.aoiPct)
      : average * (1 + this.config.hardExitAoiMultiple * plan.aoiPct);
    const candidates = [hardLevel, ...(stop !== null ? [stop] : [])];
    const effectiveStop = side === 'LONG' ? Math.max(...candidates) : Math.min(...candidates);
    const stopHit = side === 'LONG' ? candle.low <= effectiveStop : candle.high >= effectiveStop;
    const forcedExit = position.adverseCloses >= this.config.forcedExitConsecutiveCloses;
    if (stopHit || forcedExit) {
      const exitLevel = stopHit ? effectiveStop : candle.close;
      const exitPrice = fillPrice(exitLevel, side, this.config.slippagePctPerFill, false);
      const gross = side === 'LONG' ? (exitPrice - average) * position.remainingSize : (average - exitPrice) * position.remainingSize;
      const fees = this.exitFees(average, exitPrice, position.remainingSize, false);
      const reason = stopHit && effectiveStop === hardLevel
        ? `${this.config.hardExitAoiMultiple}x_aoi_hard_stop`
        : stopHit && beAtOpen && effectiveStop === beLevel
          ? 'break_even_stop'
          : stopHit && wickAtOpen !== null && effectiveStop === wickAtOpen
            ? 'wick_stop_after_div'
            : stopHit
              ? 'divergence_invalidated'
              : '2x_aoi_forced_exit';
      this.log(now, 'exit', exitPrice, position.remainingSize, `${reason}, PnL ${(gross - fees).toFixed(2)} USD`);
      const finalSig = this.signalHistory.find((s) => s.plan === plan);
      if (finalSig) {
        finalSig.pnlTotal = (finalSig.pnlTotal ?? 0) + (gross - fees);
        finalSig.feesTotal = (finalSig.feesTotal ?? 0) + fees;
        finalSig.exitAt = now;
      }
      // Statut jugé sur le P&L TOTAL du trade (TPs partiels inclus) : un
      // trade qui prend des TPs puis sort en BE est un WIN, pas un BE.
      const totalPnl = finalSig?.pnlTotal ?? (gross - fees);
      this.updateSignal(plan, totalPnl >= 0 ? 'TP' : 'SL', totalPnl, reason);
      this.trades.push({
        createdAt: plan.createdAt, entryAt: position.fills[0].time, exitAt: now, side,
        averageEntry: average, exitPrice, pnl: gross - fees, fees, reason, fills: position.fills.length,
        logs: this.journal.slice(position.journalStartIdx),
      });
      // Le peak confirmé par CETTE bougie (elle nous a stoppés) doit
      // pouvoir devenir un setup immédiatement.
      this.closePosition(position);
      return;
    }

    while (position.nextTarget < plan.targets.length) {
      const target = plan.targets[position.nextTarget];
      const hit = side === 'LONG' ? candle.high >= target.price : candle.low <= target.price;
      if (!hit) break;
      // Fraction de la quantité RÉELLEMENT remplie (pas de la taille plannée) :
      // un trade partiellement rempli (2/4 DCAs) vend 25% de CE qu'il détient
      // à chaque TP — sinon TP1+TP2 épuisaient la position et fermaient le
      // trade avant TP3/TP4. Le DERNIER TP vide toujours le restant, donc la
      // position ne ferme plus jamais "complètement" en milieu d'échelle.
      const filledTotal = position.fills.length * (position.plannedSize / plan.entryLevels.length);
      const isLastTarget = position.nextTarget === plan.targets.length - 1;
      const size = isLastTarget
        ? position.remainingSize
        : Math.min(position.remainingSize, filledTotal * target.fraction);
      if (size <= 0) { position.nextTarget++; continue; }
      const exitPrice = fillPrice(target.price, side, this.config.slippagePctPerFill, false);
      const gross = side === 'LONG' ? (exitPrice - average) * size : (average - exitPrice) * size;
      const fees = this.exitFees(average, exitPrice, size, true);
      position.remainingSize -= size;
      this.log(now, 'exit', exitPrice, size, `tp${position.nextTarget + 1}, PnL ${(gross - fees).toFixed(2)} USD`);
      this.trades.push({
        createdAt: plan.createdAt, entryAt: position.fills[0].time, exitAt: now, side,
        averageEntry: average, exitPrice, pnl: gross - fees, fees, reason: `tp${position.nextTarget + 1}`, fills: position.fills.length,
      });
      position.nextTarget++;
      // Agréger sur la carte du signal : TPs pris (détail), PnL et frais cumulés.
      const sig = this.signalHistory.find((s) => s.plan === plan);
      if (sig) {
        sig.tpsTaken = position.nextTarget;
        sig.tpExits = [...(sig.tpExits ?? []), { tp: position.nextTarget, price: exitPrice, size, pnl: gross - fees }];
        sig.pnlTotal = (sig.pnlTotal ?? 0) + (gross - fees);
        sig.feesTotal = (sig.feesTotal ?? 0) + fees;
        sig.exitAt = now;
      }
      if (!position.breakeven) {
        position.breakeven = true;
        position.breakevenLevel = this.beArmLevel(side, average, candle.close);
        position.protectiveStopFrom = now;
        // MÊME règle que les autres armements : BE = fin du setup, les DCA
        // restants sont annulés (sinon un fill post-TP1 sous le BE fait
        // sortir la position entière à un stop calibré sur l'ancienne
        // moyenne).
        this.cancelRemainingLimitsAtBe(now, plan, position);
        this.log(now, 'breakeven_enabled', position.breakevenLevel, undefined, `TP hit · stop at ${position.breakevenLevel.toFixed(1)} (active next candle)${position.breakevenLevel !== average ? ' · frais couverts' : ''}`);
      }
    }
    if (position.remainingSize <= 1e-12) {
      // Position épuisée par les TPs : clotûrer la carte du signal aussi —
      // sans ça elle resterait OPEN en fantôme.
      const sig = this.signalHistory.find((s) => s.plan === plan);
      if (sig && sig.status === 'OPEN') {
        sig.status = (sig.pnlTotal ?? 0) >= 0 ? 'TP' : 'SL';
        sig.pnl = sig.pnlTotal ?? sig.pnl;
        sig.exitAt = sig.exitAt ?? now;
      }
      this.closePosition(position);
    }
  }

  /** Positions ENCORE OUVERTES (slim, pour l'API agents et le rapport
   *  server-side « live signals ») : plan clé + état d'exécution. Aucune
   *  méthode/fonction — données JSON-sérialisables. */
  getOpenPositions(): Array<{
    createdAt: number; side: Side; entryAt: number | null; averageEntry: number | null;
    filledLevels: number; plannedSize: number; remainingSize: number; nextTarget: number;
    breakeven: boolean; emergencyStop: number | null;
    entryLevels: number[]; aoiBoundary: number; stopImaginary: number; peakRsi: number; entryPoc: number;
  }> {
    return this.positions.map((p) => ({
      createdAt: p.plan.createdAt,
      side: p.plan.side,
      entryAt: p.fills.length > 0 ? p.fills[0].time : null,
      averageEntry: p.fills.length > 0 ? p.fills.reduce((s, f) => s + f.price * f.size, 0) / Math.max(1e-12, p.fills.reduce((s, f) => s + f.size, 0)) : null,
      filledLevels: p.filledLevels.size,
      plannedSize: p.plannedSize,
      remainingSize: p.remainingSize,
      nextTarget: p.nextTarget,
      breakeven: p.breakeven,
      emergencyStop: p.emergencyStop,
      entryLevels: p.plan.entryLevels,
      aoiBoundary: p.plan.aoiBoundary,
      stopImaginary: p.plan.stopImaginary,
      peakRsi: p.plan.peakRsi,
      entryPoc: p.plan.entryPoc,
    }));
  }

  getSnapshot(lastPrice: number | null): StrategySnapshot & { debug: Record<string, number> } {
    const wins = this.trades.filter((trade) => trade.pnl > 0 || trade.reason === 'break_even_stop');
    // Stats sur TRADES groupés (une entrée = un trade) — même sémantique que
    // le backtest headless : chaque TP touché + le BE/SL final sont des
    // ClosedTrade séparés, les compter individuellement gonfle le compteur
    // (un trade à 4 TPs = 4 "trades") et le winrate.
    const groupAgg = new Map<string, { pnl: number; reason: string }>();
    for (const t of [...this.trades].sort((a, b) => a.exitAt - b.exitAt)) {
      // Clé = plan (createdAt) : en hedging, deux plans peuvent remplir la
      // même bougie du même côté — entryAt|side les fusionnerait à tort.
      const key = `${t.createdAt}`;
      const g = groupAgg.get(key);
      if (!g) groupAgg.set(key, { pnl: t.pnl, reason: t.reason });
      else { g.pnl += t.pnl; g.reason = t.reason; }
    }
    let groupedWins = 0;
    let groupedLosses = 0;
    for (const g of groupAgg.values()) {
      if (g.pnl > 0 || g.reason === 'break_even_stop') groupedWins++;
      else groupedLosses++;
    }
    const losses = this.trades.filter((trade) => trade.pnl <= 0 && trade.reason !== 'break_even_stop');
    const snapshotPosition = (p: Position) => ({
      plan: p.plan,
      fills: p.fills.length,
      averageEntry: p.fills.length > 0
        ? p.fills.reduce((sum, fill) => sum + fill.price * fill.size, 0) /
          p.fills.reduce((sum, fill) => sum + fill.size, 0)
        : null,
      remainingSize: p.remainingSize,
      divergenceConfirmed: p.divergenceConfirmed,
      breakeven: p.breakeven,
      emergencyStop: p.emergencyStop,
      wickStop: p.wickStop,
      filledEntryLevels: Array.from(p.filledLevels),
      nextTarget: p.nextTarget,
      nextTargetPrice: p.plan.targets[p.nextTarget]?.price ?? null,
      floatingPnl: ((): number | null => {
        if (lastPrice === null || p.fills.length === 0) return null;
        const average = p.fills.reduce((sum, fill) => sum + fill.price * fill.size, 0) /
          p.fills.reduce((sum, fill) => sum + fill.size, 0);
        return p.plan.side === 'LONG'
          ? (lastPrice - average) * p.remainingSize
          : (average - lastPrice) * p.remainingSize;
      })(),
    });
    // Floating global = somme des positions remplies (hedging).
    let floating: number | null = null;
    for (const p of this.positions) {
      if (p.fills.length === 0 || lastPrice === null) continue;
      const average = p.fills.reduce((sum, fill) => sum + fill.price * fill.size, 0) /
        p.fills.reduce((sum, fill) => sum + fill.size, 0);
      const pnl = p.plan.side === 'LONG'
        ? (lastPrice - average) * p.remainingSize
        : (average - lastPrice) * p.remainingSize;
      floating = (floating ?? 0) + pnl;
    }
    const positions = this.positions.map(snapshotPosition);
    return {
      pendingPlans: this.pending,
      positions,
      // Compat mono-position : la plus ancienne (les consommateurs legacy ne
      // voient qu'elle ; le floating ci-dessus reste la somme de toutes).
      position: positions[0] ?? null,
      positionFloatingTotal: floating,
      trades: this.trades,
      journal: this.journal,
      debug: { ...this.debug, candles: this.baseBars.length },
      signalHistory: this.signalHistory,
      stats: {
        trades: groupAgg.size,
        wins: groupedWins,
        losses: groupedLosses,
        pnl: this.trades.reduce((sum, trade) => sum + trade.pnl, 0),
        fees: this.trades.reduce((sum, trade) => sum + trade.fees, 0),
      },
    };
  }

  buildOverlay(): OverlaySpecV2 {
    const lastBar = this.baseBars[this.baseBars.length - 1];
    const end = lastBar ? lastBar.time : this.processedUntil;
    // Trade sélectionné dans l'historique : on ne dessine QUE lui, sur une
    // fenêtre calée sur sa sortie (exitAt + quelques bougies). Sinon,
    // comportement normal (file + TOUTES les positions actives, 3 derniers
    // plans — hedging : chaque position est dessinée avec ses propres
    // niveaux remplis et ses lignes STOP/BE).
    const activePlans = (): TradePlan[] => [...this.pending, ...this.positions.map((p) => p.plan)].slice(-3);
    let plans: TradePlan[];
    let windowEnd: number | null = null;
    if (this.selectedPlanKey) {
      const sel = this.signalHistory.find((s) => `${s.plan.createdAt}|${s.plan.peakAt}` === this.selectedPlanKey);
      if (sel) {
        plans = [sel.plan];
        windowEnd = (sel.exitAt ?? end) + 4 * this.config.baseIntervalSeconds;
      } else {
        plans = activePlans();
      }
    } else {
      plans = activePlans();
    }
    const zones: OverlayZone[] = [];
    const levels: OverlayLevel[] = [];
    const fibImpulseLines: OverlaySpecV2['fibImpulseLines'] = [];
    let selExitAt: number | null = null;
    let selCreatedAt: number | null = null;
    for (const plan of plans) {
      const activePos = this.positions.find((p) => p.plan === plan);
      drawPlanOverlay(plan, {
        windowEnd,
        end,
        baseIntervalSeconds: this.config.baseIntervalSeconds,
        baseBars: this.baseBars,
        filledSet: activePos ? activePos.filledLevels : new Set<number>(),
      }, { zones, levels, fibImpulseLines });
      if (this.selectedPlanKey && activePos === undefined) {
        const sel = this.signalHistory.find((s) => `${s.plan.createdAt}|${s.plan.peakAt}` === this.selectedPlanKey);
        selCreatedAt = sel?.plan.createdAt ?? null;
        selExitAt = sel?.exitAt ?? null;
      }
    }
    // Trade sélectionné FERMÉ : la position n'existe plus — ligne BE
    // reconstruite depuis le journal, démarrant à la bougie d'armement.
    if (selCreatedAt !== null && selExitAt !== null) {
      pushBeLevel(levels, beEventsIn(this.journal, selCreatedAt, selExitAt), (windowEnd ?? end));
    }
    for (const pos of this.positions) {
      const activeStop = pos.wickStop ?? pos.emergencyStop;
      if (activeStop !== null) {
        levels.push({ price: activeStop, label: `STOP ${activeStop.toFixed(0)}`, color: '#dc2626', style: 'solid', start: pos.plan.createdAt, end });
      }
      if (pos.breakeven && pos.fills.length > 0) {
        const average = pos.fills.reduce((sum, fill) => sum + fill.price * fill.size, 0) /
          pos.fills.reduce((sum, fill) => sum + fill.size, 0);
        // Départ à la bougie d'armement (journal) plutôt qu'à la création du
        // plan ; dashed → visible même quand l'entry est au même prix.
        const be = beEventsIn(this.journal, pos.plan.createdAt, end).filter(
          (e) => Math.abs((e.price ?? 0) - average) / Math.max(1e-9, average) < 0.002,
        );
        levels.push({ price: average, label: `BE ${average.toFixed(0)}`, color: '#eab308', style: 'dashed', start: be.length > 0 ? be[0].t : pos.plan.createdAt, end, labelOffsetPx: -12 });
      }
    }
    return {
      pocLines: [], peakMarkers: [], divergenceLines: [],
      fibImpulseLines,
      zones, levels,
      trades: this.trades.slice(-40).map((t) => ({ entryTime: t.entryAt, entryPrice: t.averageEntry, exitTime: t.exitAt, exitPrice: t.exitPrice, direction: t.side, pnl: t.pnl, reason: t.reason })),
      journalMarkers: [],
    };
  }
}
